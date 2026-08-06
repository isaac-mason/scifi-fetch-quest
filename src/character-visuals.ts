import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { type Character, FOLLOWERS } from './characters';

const BASE = import.meta.env.BASE_URL;

// Fit every model to this world height (feet-to-crown), regardless of each model's
// native (much larger) authored size. Purely visual — the agent collision height
// (FOLLOW_HEIGHT) is independent, so this only changes how big the models look.
const TARGET_HEIGHT = 1;

// Model forward axis vs travel direction (radians). If the companions walk
// backwards, flip this to Math.PI.
const FACING_OFFSET = 0;

// Foot placement nudge (world units) applied after scaling.
const FOOT_OFFSET_Y = 0;

const WALK_ENTER_SPEED = 0.4; // m/s: rise above this to switch Idle -> Walk
const WALK_EXIT_SPEED = 0.1; // m/s: fall below this to switch Walk -> Idle
const BLEND_RATE = 8; // idle<->walk crossfade speed
const TURN_RATE = 8; // yaw damping toward travel heading
const WALK_CLIP_SPEED = 1.4; // m/s the Walk clip reads as natural (for stride cadence)
const EMOTE_BLEND = 0.35; // seconds to fade the emote in at the start and out at the end

type Template = { scene: THREE.Object3D; clips: THREE.AnimationClip[]; fit: number };

type View = {
    root: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    /** This companion's own SH irradiance (9 coefficients), injected into its cloned
     *  materials' shaders. Updated in place each frame from the companion's probe sample,
     *  so it's lit — normal-shaded — by the light where IT stands. */
    sh: THREE.Vector3[];
    idle: THREE.AnimationAction | null;
    walk: THREE.AnimationAction | null;
    walkWeight: number; // 0 = idle, 1 = walking (smoothed)
    walking: boolean; // latched gait state (hysteresis)
    yaw: number; // current rendered yaw, damped toward the character's facing
    emote: THREE.AnimationAction | null; // currently-playing one-shot emote, or null
    emoteWeight: number; // 0 = locomotion, 1 = emote (smoothed crossfade)
    emoteTime: number; // seconds left of the current emote before it blends back
};

// The visualization system: owns all three.js for the companions. Reads the
// data-only Character[] (characters.ts) and creates/updates/removes one animated
// model per character id.
export type CharacterVisuals = {
    scene: THREE.Scene;
    templates: Map<string, Template>;
    views: Map<string, View>;
};

export function initCharacterVisuals(scene: THREE.Scene): CharacterVisuals {
    return { scene, templates: new Map(), views: new Map() };
}

// Load the follower GLTF templates and precompute a per-model fit scale so each
// ends up TARGET_HEIGHT tall. Await before spawning the companions.
export async function loadCharacterVisuals(visuals: CharacterVisuals): Promise<void> {
    const loader = new GLTFLoader();
    // The optimized character .glb (pnpm optimize:characters) use EXT_meshopt_compression
    // for geometry/animation; WebP textures are decoded by the loader natively.
    loader.setMeshoptDecoder(MeshoptDecoder);
    await Promise.all(
        FOLLOWERS.map(async (name) => {
            try {
                const gltf = await loader.loadAsync(`${BASE}characters/${name}.glb`);
                gltf.scene.traverse((o) => {
                    o.frustumCulled = false; // skinned bounds are unreliable -> avoid cull flicker
                    // Companions cast (and receive each other's) shadows. Set on the
                    // template so SkeletonUtils.clone carries the flags to every instance.
                    const mesh = o as THREE.Mesh;
                    if (mesh.isMesh) {
                        mesh.castShadow = true;
                        mesh.receiveShadow = true;
                    }
                });
                const box = new THREE.Box3().setFromObject(gltf.scene);
                const height = box.max.y - box.min.y || 1;
                visuals.templates.set(name, { scene: gltf.scene, clips: gltf.animations, fit: TARGET_HEIGHT / height });
            } catch (err) {
                console.warn(`character load failed: ${name}`, err);
            }
        }),
    );
}

const findClip = (clips: THREE.AnimationClip[], name: string) => clips.find((c) => c.name === name) ?? null;

function createView(visuals: CharacterVisuals, ch: Character): View | null {
    const tmpl = visuals.templates.get(ch.model) ?? visuals.templates.values().next().value;
    if (!tmpl) return null;

    const root = cloneSkinned(tmpl.scene);
    root.scale.setScalar(tmpl.fit);

    // Per-companion SH irradiance. SkeletonUtils.clone shares materials, so clone them and
    // inject a per-object SH probe: its irradiance (normal-shaded, same as a scene
    // LightProbe) is added on top of the fill lights, but sampled at THIS companion.
    const sh = Array.from({ length: 9 }, () => new THREE.Vector3());
    const inject = (m: THREE.Material): THREE.Material => {
        const c = m.clone();
        if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            c.onBeforeCompile = (shader) => {
                shader.uniforms.uCompanionSH = { value: sh };
                shader.fragmentShader =
                    'uniform vec3 uCompanionSH[9];\n' +
                    shader.fragmentShader.replace(
                        '#include <lights_fragment_begin>',
                        '#include <lights_fragment_begin>\n\tirradiance += shGetIrradianceAt( inverseTransformDirection( geometryNormal, viewMatrix ), uCompanionSH );',
                    );
            };
            // Shared program across all companions (same code) — only the uniform differs.
            c.customProgramCacheKey = () => 'companion-probe-sh';
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
    // Both play; a random phase keeps the group out of lock-step. Start idle and
    // let the first updates blend to walk once the agent gets moving.
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
        mixer,
        sh,
        idle,
        walk,
        walkWeight: 0,
        walking: false,
        yaw: ch.facing + FACING_OFFSET,
        emote: null,
        emoteWeight: 0,
        emoteTime: 0,
    };
}

// Per-frame: sync meshes to character data — spawn views for new ids,
// place/orient/animate existing ones, drop views whose character is gone.
export function updateCharacterVisuals(visuals: CharacterVisuals, characters: Character[], dt: number): void {
    const alive = new Set<string>();

    for (const ch of characters) {
        alive.add(ch.id);
        let view = visuals.views.get(ch.id);
        if (!view) {
            const created = createView(visuals, ch);
            if (!created) continue; // templates not loaded yet
            visuals.views.set(ch.id, created);
            view = created;
        }

        view.root.position.set(ch.position[0], ch.position[1] + FOOT_OFFSET_Y, ch.position[2]);
        // Damp yaw toward the target facing along the shortest arc so slow / noisy
        // heading changes turn gracefully instead of snapping.
        const targetYaw = ch.facing + FACING_OFFSET;
        const delta = Math.atan2(Math.sin(targetYaw - view.yaw), Math.cos(targetYaw - view.yaw));
        view.yaw += delta * Math.min(1, TURN_RATE * dt);
        view.root.rotation.y = view.yaw;

        // Emote: consume a one-shot request, play it once, then crossfade back to
        // locomotion. The emote fades IN over EMOTE_BLEND at the start and OUT over
        // EMOTE_BLEND at the end (overlapping the clip's tail so the return is smooth).
        if (ch.emote) {
            const tmpl = visuals.templates.get(ch.model) ?? visuals.templates.values().next().value;
            const clip = tmpl ? findClip(tmpl.clips, ch.emote) : null;
            if (clip) {
                if (view.emote) view.emote.stop();
                const action = view.mixer.clipAction(clip);
                action.reset();
                action.setLoop(THREE.LoopOnce, 1);
                action.clampWhenFinished = true;
                action.play();
                view.emote = action;
                view.emoteTime = clip.duration;
            }
            ch.emote = null; // consumed
        }
        if (view.emoteTime > 0) view.emoteTime -= dt;
        // Full weight while playing, then fade out over the last EMOTE_BLEND seconds.
        // Move the weight at a CONSTANT rate (linear envelope) so the crossfade is even
        // — an exponential lerp front-loads the change and reads as a snap.
        const emoteTarget = view.emoteTime > EMOTE_BLEND ? 1 : 0;
        const emoteStep = dt / EMOTE_BLEND;
        view.emoteWeight =
            view.emoteWeight < emoteTarget
                ? Math.min(emoteTarget, view.emoteWeight + emoteStep)
                : Math.max(emoteTarget, view.emoteWeight - emoteStep);
        if (view.emoteTime <= 0 && view.emote && view.emoteWeight <= 0) {
            view.emote.stop();
            view.emote = null;
        }

        // Latch gait with hysteresis so a jittery crawl near the boundary stays put.
        if (view.walking ? ch.speed < WALK_EXIT_SPEED : ch.speed > WALK_ENTER_SPEED) {
            view.walking = !view.walking;
        }
        const target = view.walking ? 1 : 0;
        view.walkWeight += (target - view.walkWeight) * Math.min(1, BLEND_RATE * dt);
        // The emote takes over the whole body while active, so scale locomotion down by it.
        const locomotion = 1 - view.emoteWeight;
        view.walk?.setEffectiveWeight(view.walkWeight * locomotion);
        view.idle?.setEffectiveWeight((1 - view.walkWeight) * locomotion);
        view.emote?.setEffectiveWeight(view.emoteWeight);
        // Match stride cadence to actual speed so the feet don't slide.
        if (view.walk) view.walk.timeScale = THREE.MathUtils.clamp(ch.speed / WALK_CLIP_SPEED, 0.4, 1.6);

        view.mixer.update(dt);
    }

    for (const [id, view] of visuals.views) {
        if (!alive.has(id)) {
            visuals.scene.remove(view.root);
            visuals.views.delete(id);
        }
    }
}

// Feed one companion its OWN probe SH (9 coefficients, e.g. from a sampled LightProbe),
// scaled by `intensity`, into its shader — so it's normal-shaded by the light where IT
// stands, not by one shared scene probe. No-op if the companion's view isn't built yet.
export function setCompanionProbe(visuals: CharacterVisuals, id: string, coeffs: THREE.Vector3[], intensity: number): void {
    const view = visuals.views.get(id);
    if (!view) return;
    for (let i = 0; i < 9; i++) view.sh[i].copy(coeffs[i]).multiplyScalar(intensity);
}
