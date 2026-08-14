import type { Vec3 } from 'mathcat';
import type * as THREE from 'three';

import { TARGET_HEIGHT } from './character-visuals';
import type { Characters } from './characters';
import { computePath, type Navigation } from './navigation';
import { createObjectiveMarker, type ObjectiveMarker, updateObjectiveMarker } from './objective-marker';
import { createPathTrail, hidePathTrail, type PathTrail, resamplePath, setPathTrail, updatePathTrail } from './path-trail';
import { groundAt, type Physics } from './physics';
import { objectiveShort, objectiveTarget, type Quest } from './quest';
import { CATS_CENTER } from './scene';

// Objective guidance: the "where do I go next" layer. Owns two UI pieces (the world-space marker
// over the current target, and the breadcrumb ribbon along the route to it) and drives them each
// frame from the quest + world state. index feeds updateObjective the per-frame world context.

export type Objective = { marker: ObjectiveMarker; trail: PathTrail };

export function createObjective(scene: THREE.Scene): Objective {
    return { marker: createObjectiveMarker(), trail: createPathTrail(scene) };
}

// Everything updateObjective reads each frame (passed explicitly; no shared State). `suppressed`
// hides guidance during dialogue / launch cutscene / non first-person; `feet` + `groundY` are the
// player's grounded position the ribbon starts from.
export type ObjectiveWorld = {
    quest: Quest;
    navigation: Navigation;
    physics: Physics;
    characters: Characters;
    striker: THREE.Object3D | null;
    feet: Vec3; // player feet (x/z); y comes from groundY
    groundY: number;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    suppressed: boolean;
};

// Where the marker anchors: top of a crew member's head (feet + model height), the ship's origin
// for 'ship', or the first cat's head for 'cats'.
function markerAnchor(w: ObjectiveWorld, key: string): Vec3 | null {
    if (key === 'ship') return w.striker ? [w.striker.position.x, w.striker.position.y, w.striker.position.z] : null;
    if (key === 'cats') {
        const c = w.characters.list.find((ch) => ch.model === 'cat');
        return c ? [c.position[0], c.position[1] + c.headHeight, c.position[2]] : null;
    }
    const ch = w.characters.list.find((c) => c.model === key);
    return ch ? [ch.position[0], ch.position[1] + TARGET_HEIGHT, ch.position[2]] : null;
}

// Navmesh point to route the ribbon to (feet, not head; the pad for the ship since it floats
// off-mesh).
function objectiveGoal(w: ObjectiveWorld, key: string): Vec3 | null {
    if (key === 'ship') return CATS_CENTER;
    const ch = w.characters.list.find((c) => c.model === key);
    return ch ? [ch.position[0], ch.position[1], ch.position[2]] : null;
}

// Per-frame: place the marker over the current target (pin on-screen, edge arrow when off) and lay
// the ribbon along the route. Both hide when suppressed or there's no target.
export function updateObjective(obj: Objective, w: ObjectiveWorld, time: number): void {
    const objKey = w.suppressed ? null : objectiveTarget(w.quest);
    const objPos = objKey ? markerAnchor(w, objKey) : null;
    updateObjectiveMarker(obj.marker, objPos, objectiveShort(w.quest), w.camera, w.renderer);

    // Recompute the route every frame so the ribbon tracks you. Chevron placement is anchored to
    // world space inside the trail (goal-end sampling + goal-anchored UVs + easing), so chevrons
    // hold their spots instead of jumping as the path re-solves.
    if (!objKey) {
        hidePathTrail(obj.trail);
        return;
    }
    const goal = objectiveGoal(w, objKey);
    // Use the grounded feet Y (held steady on jumps, like the shadows), not the live y, so the
    // ribbon stays on the floor instead of leaping up when you jump.
    const corners = goal ? computePath(w.navigation, [w.feet[0], w.groundY, w.feet[2]], goal) : null;
    if (corners) {
        const dots = resamplePath(corners);
        // Ground each dot on the real collider floor. On a ray miss, don't fall back to the raw
        // navmesh height (it can sit below the visible floor -> the ribbon dips underground); reuse
        // the last good floor Y. Dots run player->goal, so seed from the grounded Y.
        let lastY = w.groundY;
        for (const d of dots) {
            const fy = groundAt(w.physics, d[0], d[2], d[1] + 0.5, 4);
            if (fy !== null) lastY = fy;
            d[1] = lastY;
        }
        setPathTrail(obj.trail, dots);
    } else {
        hidePathTrail(obj.trail);
    }
    updatePathTrail(obj.trail, time);
}
