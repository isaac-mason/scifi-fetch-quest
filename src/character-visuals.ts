import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import type { Character } from './characters';
import { applyProbeVolume, isProbeVolumeReady } from './light-probes';
import { CAT_HEIGHT, CAT_URL } from './scene';

// Draws every NPC (crew + cats). Owns all three.js: loads a template per model and per character id
// creates/updates/removes an animated instance from the data-only Character (characters.ts).
// Behaviour lives in characters.ts; this module just renders what the data says.

const BASE = import.meta.env.BASE_URL;

// Feet-to-crown world height the CREW models are fit to; used by index to place the head marker.
export const TARGET_HEIGHT = 1;

// Model forward axis vs travel direction (radians). If a model walks backwards, flip to Math.PI.
const FACING_OFFSET = 0;
const TURN_RATE = 8; // yaw damping toward the character's facing
const BLEND_RATE = 8; // idle<->walk crossfade speed
const EMOTE_BLEND = 0.35; // seconds to fade a one-shot in/out

// Per-model gait tuning: walk<->idle thresholds and natural clip speed differ per model.
export type GaitConfig = {
    enter: number; // m/s: rise above this to switch Idle -> Walk
    exit: number; // m/s: fall below this to switch Walk -> Idle (hysteresis)
    clipSpeed: number; // m/s the Walk clip reads as natural (drives stride cadence)
    clipMin: number; // clamp on the walk timeScale (slowest)
    clipMax: number; // clamp on the walk timeScale (fastest)
};

// One entry per loadable model. `fitHeight` scales the authored model to a world height; `gait`
// tunes the locomotion crossfade.
export type ModelSpec = { name: string; url: string; fitHeight: number; gait: GaitConfig };

// Crew stride reads fast at ~3.4 m/s follow; cats amble at ~0.55 m/s, so their walk clip engages
// sooner and plays back quicker relative to speed.
const CREW_GAIT: GaitConfig = { enter: 0.4, exit: 0.1, clipSpeed: 1.4, clipMin: 0.4, clipMax: 1.6 };
const CAT_GAIT: GaitConfig = { enter: 0.1, exit: 0.05, clipSpeed: 0.5, clipMin: 1.0, clipMax: 2.2 };

// Model registry: four crew (fit to TARGET_HEIGHT) + the cat (fit to CAT_HEIGHT). loadCharacterVisuals
// loads a template per entry; a Character's `model` field names which one it draws.
export const CHARACTER_MODELS: ModelSpec[] = [
    { name: 'George', url: `${BASE}characters/George.glb`, fitHeight: TARGET_HEIGHT, gait: CREW_GAIT },
    { name: 'Leela', url: `${BASE}characters/Leela.glb`, fitHeight: TARGET_HEIGHT, gait: CREW_GAIT },
    { name: 'Mike', url: `${BASE}characters/Mike.glb`, fitHeight: TARGET_HEIGHT, gait: CREW_GAIT },
    { name: 'Stan', url: `${BASE}characters/Stan.glb`, fitHeight: TARGET_HEIGHT, gait: CREW_GAIT },
    { name: 'cat', url: CAT_URL, fitHeight: CAT_HEIGHT, gait: CAT_GAIT },
];

type Template = {
    scene: THREE.Object3D;
    clips: THREE.AnimationClip[];
    fit: number; // scale factor to reach fitHeight
    yOffset: number; // lifts the model so its Idle-pose feet sit on the floor
    gait: GaitConfig;
};

type View = {
    root: THREE.Object3D;
    yOffset: number; // copied from the template (lifts feet to the floor)
    gait: GaitConfig;
    mixer: THREE.AnimationMixer;
    idle: THREE.AnimationAction | null;
    walk: THREE.AnimationAction | null;
    walkWeight: number; // 0 = idle, 1 = walking (smoothed)
    walking: boolean; // latched gait state (hysteresis)
    yaw: number; // current rendered yaw, damped toward the character's facing
    // One-shot overlay slot, shared by crew emotes and the cat's hop flair: play once over the
    // whole body, then blend back to locomotion.
    oneshot: THREE.AnimationAction | null;
    oneshotWeight: number; // 0 = locomotion, 1 = one-shot (smoothed crossfade)
    oneshotTime: number; // seconds left of the current one-shot before it blends back
};

// Owns all three.js for the NPCs; creates/updates/removes one animated model per character id.
export type CharacterVisuals = {
    scene: THREE.Scene;
    templates: Map<string, Template>;
    views: Map<string, View>;
};

export function initCharacterVisuals(scene: THREE.Scene): CharacterVisuals {
    return { scene, templates: new Map(), views: new Map() };
}

// Load every model template and precompute its fit scale + foot offset. Await before spawning
// characters. A model whose GLTF fails to load is skipped (its characters never get a view).
export async function loadCharacterVisuals(visuals: CharacterVisuals): Promise<void> {
    const loader = new GLTFLoader();
    // Crew .glb use EXT_meshopt_compression; the decoder is harmless for models that don't.
    loader.setMeshoptDecoder(MeshoptDecoder);
    await Promise.all(
        CHARACTER_MODELS.map(async (spec) => {
            try {
                const gltf = await loader.loadAsync(spec.url);
                gltf.scene.traverse((o) => {
                    o.frustumCulled = false; // skinned bounds are unreliable -> avoid cull flicker
                    const mesh = o as THREE.Mesh;
                    if (mesh.isMesh) {
                        mesh.castShadow = true; // NPCs cast + receive each other's shadows
                        mesh.receiveShadow = true;
                    }
                });
                const fit = spec.fitHeight / (measureHeight(gltf.scene) || 1);
                const yOffset = measureFootOffset(gltf.scene, gltf.animations, fit);
                visuals.templates.set(spec.name, { scene: gltf.scene, clips: gltf.animations, fit, yOffset, gait: spec.gait });
            } catch (err) {
                console.warn(`character model load failed: ${spec.name}`, err);
            }
        }),
    );
}

const measureHeight = (obj: THREE.Object3D): number => {
    const box = new THREE.Box3().setFromObject(obj);
    return box.max.y - box.min.y;
};

// Grounding offset: measure the lowest vertex in the actual Idle pose so the feet land on the floor.
// Poses the skeleton to Idle first (bind-pose box would float), and setFromObject(..., true) applies
// bone transforms per vertex so the box reflects the skinned pose. Returns the lift that puts min.y at 0.
function measureFootOffset(scene: THREE.Object3D, clips: THREE.AnimationClip[], fit: number): number {
    const probe = cloneSkinned(scene);
    probe.scale.setScalar(fit);
    const idle = clips.find((c) => c.name === 'Idle');
    if (idle) {
        const mixer = new THREE.AnimationMixer(probe);
        mixer.clipAction(idle).play();
        mixer.update(0); // pose to the first Idle frame
    }
    probe.updateMatrixWorld(true);
    return -new THREE.Box3().setFromObject(probe, true).min.y;
}

const findClip = (clips: THREE.AnimationClip[], name: string) => clips.find((c) => c.name === name) ?? null;

function createView(visuals: CharacterVisuals, ch: Character): View | null {
    const tmpl = visuals.templates.get(ch.model);
    if (!tmpl) return null;

    const root = cloneSkinned(tmpl.scene);
    root.scale.setScalar(tmpl.fit);

    // Light every NPC from the baked probe volume (light-probes.ts). SkeletonUtils.clone shares
    // materials, so clone them and inject the volume sampler; the shader adds per-fragment SH
    // irradiance on top of the fill lights. Uniforms are shared globally, so no per-frame CPU work.
    const inject = (m: THREE.Material): THREE.Material => {
        const c = m.clone();
        // Only inject if a probe grid loaded, else the shader would sample an unbound sampler3D.
        if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial && isProbeVolumeReady()) {
            applyProbeVolume(c as THREE.MeshStandardMaterial);
        }
        return c;
    };
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const src = mesh.material;
        mesh.material = Array.isArray(src) ? src.map(inject) : inject(src);
    });

    visuals.scene.add(root);

    const mixer = new THREE.AnimationMixer(root);
    const idleClip = findClip(tmpl.clips, 'Idle');
    const walkClip = findClip(tmpl.clips, 'Walk');
    const idle = idleClip ? mixer.clipAction(idleClip) : null;
    const walk = walkClip ? mixer.clipAction(walkClip) : null;
    // Both play; a random phase keeps a group out of lock-step. Start idle, blend to walk on move.
    if (idle && idleClip) {
        idle.play();
        idle.time = Math.random() * idleClip.duration;
        idle.setEffectiveWeight(1);
    }
    if (walk && walkClip) {
        walk.play();
        walk.time = Math.random() * walkClip.duration;
        walk.setEffectiveWeight(0);
    }

    return {
        root,
        yOffset: tmpl.yOffset,
        gait: tmpl.gait,
        mixer,
        idle,
        walk,
        walkWeight: 0,
        walking: false,
        yaw: ch.facing + FACING_OFFSET,
        oneshot: null,
        oneshotWeight: 0,
        oneshotTime: 0,
    };
}

// Per-frame: sync meshes to character data - spawn views for new ids, place/orient/animate existing
// ones, drop views whose character is gone. `visible` (debug toggle) hides models without tearing
// views down, so animation/state keep running and they reappear intact when re-enabled.
export function updateCharacterVisuals(visuals: CharacterVisuals, characters: Character[], dt: number, visible = true): void {
    const alive = new Set<string>();

    for (const ch of characters) {
        alive.add(ch.id);
        let view = visuals.views.get(ch.id);
        if (!view) {
            const created = createView(visuals, ch);
            if (!created) continue; // template not loaded yet
            visuals.views.set(ch.id, created);
            view = created;
        }

        view.root.visible = visible;
        // ch.position is the grounded feet point; yOffset lifts the model origin so its feet sit there.
        view.root.position.set(ch.position[0], ch.position[1] + view.yOffset, ch.position[2]);

        // Damp rendered yaw toward facing along the shortest arc so heading changes don't snap.
        const targetYaw = ch.facing + FACING_OFFSET;
        const delta = Math.atan2(Math.sin(targetYaw - view.yaw), Math.cos(targetYaw - view.yaw));
        view.yaw += delta * Math.min(1, TURN_RATE * dt);
        view.root.rotation.y = view.yaw;

        // One-shot overlay: consume a request (crew emote or the cat's 'Fall' hop), play it once,
        // then crossfade back to locomotion. Fades in/out over EMOTE_BLEND at each end.
        if (ch.emote) {
            const tmpl = visuals.templates.get(ch.model);
            const clip = tmpl ? findClip(tmpl.clips, ch.emote) : null;
            if (clip) {
                if (view.oneshot) view.oneshot.stop();
                const action = view.mixer.clipAction(clip);
                action.reset();
                action.setLoop(THREE.LoopOnce, 1);
                action.clampWhenFinished = true;
                action.play();
                view.oneshot = action;
                view.oneshotTime = clip.duration;
            }
            ch.emote = null; // consumed
        }
        if (view.oneshotTime > 0) view.oneshotTime -= dt;
        // Full weight while playing, then fade out over the last EMOTE_BLEND seconds. Linear envelope
        // (constant rate) keeps the crossfade even; an exponential lerp would front-load and snap.
        const oneshotTarget = view.oneshotTime > EMOTE_BLEND ? 1 : 0;
        const step = dt / EMOTE_BLEND;
        view.oneshotWeight =
            view.oneshotWeight < oneshotTarget
                ? Math.min(oneshotTarget, view.oneshotWeight + step)
                : Math.max(oneshotTarget, view.oneshotWeight - step);
        if (view.oneshotTime <= 0 && view.oneshot && view.oneshotWeight <= 0) {
            view.oneshot.stop();
            view.oneshot = null;
        }

        // Latch gait with hysteresis so a jittery crawl near the boundary stays put.
        if (view.walking ? ch.speed < view.gait.exit : ch.speed > view.gait.enter) {
            view.walking = !view.walking;
        }
        const target = view.walking ? 1 : 0;
        view.walkWeight += (target - view.walkWeight) * Math.min(1, BLEND_RATE * dt);
        // The one-shot takes over the whole body while active, so scale locomotion down by it.
        const locomotion = 1 - view.oneshotWeight;
        view.walk?.setEffectiveWeight(view.walkWeight * locomotion);
        view.idle?.setEffectiveWeight((1 - view.walkWeight) * locomotion);
        view.oneshot?.setEffectiveWeight(view.oneshotWeight);
        // Match stride cadence to actual speed so the feet don't slide.
        if (view.walk)
            view.walk.timeScale = THREE.MathUtils.clamp(ch.speed / view.gait.clipSpeed, view.gait.clipMin, view.gait.clipMax);

        view.mixer.update(dt);
    }

    for (const [id, view] of visuals.views) {
        if (!alive.has(id)) {
            visuals.scene.remove(view.root);
            visuals.views.delete(id);
        }
    }
}
