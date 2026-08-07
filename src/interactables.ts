import type { BodyId } from 'crashcat';
import type { Vec3 } from 'mathcat';
import type * as THREE from 'three';

import { addInteractableBody, type Physics, removeInteractableBody } from './physics';

// Look-and-click world objects that aren't crowd characters: the keys pickup, the cat at the
// ship. Each has a ghost sensor body (the view ray hits it) and an onInteract callback. The
// interact system in index.ts resolves a ray hit to a character OR one of these.

export type Interactable = {
    id: string;
    label: string; // nameplate name
    verb: string; // nameplate prompt verb ("take" / "talk")
    head: Vec3; // world point for the camera to look at while interacting
    bodyId: BodyId;
    mesh: THREE.Object3D | null;
    onInteract: () => void;
};

export type Interactables = { byBody: Map<BodyId, Interactable> };

export function initInteractables(): Interactables {
    return { byBody: new Map() };
}

export type InteractableOpts = {
    id: string;
    label: string;
    verb: string;
    position: Vec3; // base (feet) position of the sensor
    headHeight?: number; // look-at height above the base (default 0.9)
    radius?: number; // sensor capsule radius (default 0.5)
    height?: number; // sensor capsule height (default 1)
    mesh?: THREE.Object3D | null;
    onInteract: () => void;
};

export function addInteractable(reg: Interactables, physics: Physics, opts: InteractableOpts): Interactable {
    const radius = opts.radius ?? 0.5;
    const height = opts.height ?? 1;
    const headHeight = opts.headHeight ?? 0.9;
    const bodyId = addInteractableBody(physics, opts.id, opts.position, radius, height);
    const it: Interactable = {
        id: opts.id,
        label: opts.label,
        verb: opts.verb,
        head: [opts.position[0], opts.position[1] + headHeight, opts.position[2]],
        bodyId,
        mesh: opts.mesh ?? null,
        onInteract: opts.onInteract,
    };
    reg.byBody.set(bodyId, it);
    return it;
}

// The interactable a ray hit resolves to (or null if that body isn't one / has been removed).
export function interactableAt(reg: Interactables, bodyId: BodyId): Interactable | null {
    return reg.byBody.get(bodyId) ?? null;
}

// Stop an interactable being hittable and hide its mesh (collected / gone).
export function removeInteractable(reg: Interactables, physics: Physics, it: Interactable): void {
    reg.byBody.delete(it.bodyId);
    removeInteractableBody(physics, it.bodyId);
    if (it.mesh) it.mesh.visible = false;
}
