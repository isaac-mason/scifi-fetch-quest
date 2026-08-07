import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { addInteractable, type Interactable, type Interactables, removeInteractable } from './interactables';
import { applyProbeVolume, isProbeVolumeReady } from './light-probes';
import {
    addCrowdAgent,
    isAgentAtTarget,
    makeAgentParams,
    type Navigation,
    removeCrowdAgent,
    setAgentMaxSpeed,
    setAgentTarget,
    setAgentVelocity,
    snapToNavMesh,
} from './navigation';
import { groundAt, moveCharacterCollider, type Physics } from './physics';

// "cats" — a scatter of cats loitering around the striker. They're proper navcat crowd agents
// (like the companions), each strolling to random navmesh points near where it spawned, so they
// path smoothly and avoid each other + the crew. Walk clip while moving, Idle when they stop. For
// now they just play dumb ("meow?") when talked to. Each has a moving ghost sensor body so the
// view ray can pick it out.

const CAT_RADIUS = 0.25; // crowd avoidance radius
const CAT_HEIGHT = 0.4; // crowd agent height
const CAT_SPEED = 0.55; // m/s stroll (a touch slower)
const WALK_ENTER = 0.1; // m/s above which a cat crossfades to Walk
const CROSSFADE = 8; // idle<->walk blend rate (per second)
const WALK_REF = 0.5; // m/s the Walk clip reads as natural — higher = slightly slower feet
const ARRIVE_DIST = 0.4; // within this of its target, a cat stops for a bit
const RETARGET_MAX = 6; // seconds before giving up on a target it can't reach
const PAUSE_MIN = 0.8; // seconds a cat loiters between strolls (stop-and-go)
const PAUSE_MAX = 3.0;
const TALK_TURN = 8; // how fast a talked-to cat spins to face you
const IDLE_TURN = 4; // how fast a cat swings to its heading
const HOP_DUR = 0.6; // seconds of the finale leap into the ship (procedural — model has no jump clip)
const HOP_LIFT = 0.5; // metres of extra arc height at the peak of the hop

export type Cat = {
    mesh: THREE.Object3D;
    it: Interactable;
    agentId: string;
    center: Vec3; // where it wanders around
    wanderRadius: number;
    targetX: number;
    targetZ: number;
    retarget: number; // seconds until it gives up on an unreachable target
    state: 'moving' | 'paused'; // stop-and-go wander
    pauseTimer: number; // seconds left of the current loiter
    talking: boolean; // set while the player is talking to this cat — it holds + faces you
    boarding: boolean; // set during the finale — it dashes to the ship (no wander)
    jumping: boolean; // reached the ship → playing the one-shot jump-in before despawning
    jumpTimer: number; // seconds left of the jump-in before this cat is removed
    headOffset: number;
    yOffset: number; // lifts the model so its feet sit on the floor
    yaw: number; // damped facing
    prevX: number;
    prevZ: number;
    mixer: THREE.AnimationMixer;
    idle: THREE.AnimationAction | null;
    walk: THREE.AnimationAction | null;
    jump: THREE.AnimationAction | null; // "Spin" flair played during the finale hop into the ship
    boardTarget: Vec3; // the ship point the finale hop arcs toward
    hopFrom: Vec3; // where the hop started (captured on arrival at the ship)
    walkWeight: number;
};

export type Cats = { list: Cat[] };

export function initCats(): Cats {
    return { list: [] };
}

export type LoadCatsOpts = {
    url: string;
    count: number;
    center: Vec3;
    spread: number;
    height: number; // fit each cat to this world height
    yNudge: number; // extra vertical offset on top of the auto foot-grounding
    onTalk: (cat: Cat) => void;
};

const _snap: Vec3 = [0, 0, 0];

// Pick a fresh wander target on the navmesh near the cat's centre and hand it to the crowd.
function retarget(cat: Cat, navigation: Navigation): void {
    for (let t = 0; t < 6; t++) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * cat.wanderRadius;
        const p: Vec3 = [cat.center[0] + Math.cos(ang) * r, cat.center[1], cat.center[2] + Math.sin(ang) * r];
        if (snapToNavMesh(navigation, p, _snap)) {
            setAgentTarget(navigation, cat.agentId, [_snap[0], _snap[1], _snap[2]]);
            cat.targetX = _snap[0];
            cat.targetZ = _snap[2];
            cat.retarget = 2 + Math.random() * (RETARGET_MAX - 2);
            return;
        }
    }
}

export async function loadCats(
    cats: Cats,
    scene: THREE.Scene,
    physics: Physics,
    interactables: Interactables,
    navigation: Navigation,
    opts: LoadCatsOpts,
): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(opts.url);
    const template = gltf.scene;
    // Light the cats like the crew — inject the probe volume into the (shared) materials once.
    if (isProbeVolumeReady()) {
        template.traverse((o) => {
            const m = (o as THREE.Mesh).material;
            const mats = Array.isArray(m) ? m : m ? [m] : [];
            for (const mat of mats) {
                if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial)
                    applyProbeVolume(mat as THREE.MeshStandardMaterial);
            }
        });
    }

    const box = new THREE.Box3().setFromObject(template);
    const fit = opts.height / (box.max.y - box.min.y || 1);
    const clips = gltf.animations; // model has: Fall, Idle, Spin, Walk (no jump — the finale hop is faked)
    const findClip = (name: string) => clips.find((c) => c.name === name) ?? null;

    // Grounding offset: measure the model's lowest vertex in the ACTUAL Idle pose so the feet land
    // on floorY. Two things matter: (1) pose the skeleton to Idle first (a bind-pose box doesn't
    // match how it's rendered → floating), and (2) setFromObject(..., true) with precise=true
    // applies the bone transforms per vertex, so the box reflects the skinned pose, not the rest
    // geometry. Then yOffset lifts the origin so min.y sits at 0 (feet on the floor).
    const probe = cloneSkinned(template);
    probe.scale.setScalar(fit);
    const probeIdle = findClip('Idle');
    if (probeIdle) {
        const probeMixer = new THREE.AnimationMixer(probe);
        probeMixer.clipAction(probeIdle).play();
        probeMixer.update(0); // pose to the first Idle frame
    }
    probe.updateMatrixWorld(true);
    const yOffset = -new THREE.Box3().setFromObject(probe, true).min.y + opts.yNudge;
    const rand = (a: number, b: number) => a + Math.random() * (b - a);

    const maxFromCenter = opts.spread * 1.6; // reject spawns that snap far from the ship
    for (let i = 0; i < opts.count; i++) {
        // On-navmesh spawn near the centre. snapToNavMesh returns the NEAREST poly, which — near a
        // thin/edge pad — can be surprisingly far; reject those so the mob stays by the ship.
        let onMesh = false;
        for (let t = 0; t < 16 && !onMesh; t++) {
            const guess: Vec3 = [
                opts.center[0] + rand(-1, 1) * opts.spread,
                opts.center[1],
                opts.center[2] + rand(-1, 1) * opts.spread,
            ];
            if (!snapToNavMesh(navigation, guess, _snap)) continue;
            const dx = _snap[0] - opts.center[0];
            const dz = _snap[2] - opts.center[2];
            onMesh = dx * dx + dz * dz <= maxFromCenter * maxFromCenter;
        }
        if (!onMesh) continue;
        const base: Vec3 = [_snap[0], _snap[1], _snap[2]];

        const agentId = addCrowdAgent(navigation, base, makeAgentParams(CAT_RADIUS, CAT_HEIGHT, CAT_SPEED));
        if (!agentId) continue;

        const mesh = cloneSkinned(template);
        mesh.scale.setScalar(fit);
        mesh.traverse((o) => {
            o.frustumCulled = false;
            o.castShadow = true; // cats drop shadows too (see shadows.ts / index caster list)
        });
        const yaw = rand(0, Math.PI * 2);
        mesh.position.set(base[0], base[1] + yOffset, base[2]);
        mesh.rotation.y = yaw;
        scene.add(mesh);

        const mixer = new THREE.AnimationMixer(mesh);
        const idleClip = findClip('Idle');
        const walkClip = findClip('Walk');
        const fallClip = findClip('Fall'); // no jump clip in the model — Fall is the mid-air flair
        const idle = idleClip ? mixer.clipAction(idleClip) : null;
        const walk = walkClip ? mixer.clipAction(walkClip) : null;
        const jump = fallClip ? mixer.clipAction(fallClip) : null;
        if (idle) {
            idle.play();
            idle.time = rand(0, idleClip?.duration ?? 0);
        }
        if (walk) {
            walk.play();
            walk.setEffectiveWeight(0);
        }

        const headOffset = opts.height * 0.6;
        const cat: Cat = {
            mesh,
            it: null as unknown as Interactable,
            agentId,
            center: [opts.center[0], opts.center[1], opts.center[2]], // wander the SHIP, not the spawn
            wanderRadius: opts.spread,
            targetX: base[0],
            targetZ: base[2],
            retarget: 0,
            state: 'paused',
            pauseTimer: Math.random() * PAUSE_MAX, // stagger the mob's first move
            talking: false,
            boarding: false,
            jumping: false,
            jumpTimer: 0,
            headOffset,
            yOffset,
            yaw,
            prevX: base[0],
            prevZ: base[2],
            mixer,
            idle,
            walk,
            jump,
            boardTarget: [0, 0, 0],
            hopFrom: [0, 0, 0],
            walkWeight: 0,
        };
        cat.it = addInteractable(interactables, physics, {
            id: `cat-${i}`,
            label: 'cat',
            verb: 'talk',
            position: base,
            headHeight: headOffset,
            radius: 0.4,
            height: 0.6,
            mesh,
            onInteract: () => opts.onTalk(cat),
        });
        cats.list.push(cat);
    }
    console.log(`cats: spawned ${cats.list.length}/${opts.count} crowd agents near [${opts.center.join(', ')}]`);
    if (cats.list.length === 0) {
        console.warn('cats: none spawned — CATS_CENTER (scene.ts) is off the navmesh; move it onto walkable floor.');
    }
}

// Per-frame (after the crowd steps): drive each cat's stop-and-go wander (or hold + face the
// player while being talked to), sync the mesh + sensor, and crossfade Walk/Idle by speed.
export function updateCats(
    cats: Cats,
    navigation: Navigation,
    physics: Physics,
    interactables: Interactables,
    playerPos: Vec3,
    dt: number,
): void {
    let boarded: Cat[] | null = null; // cats that finished their jump this frame → remove after the loop
    for (const c of cats.list) {
        const agent = navigation.crowd?.agents[c.agentId];
        if (!agent) continue;
        const x = agent.position[0];
        const y = agent.position[1];
        const z = agent.position[2];

        // State: boarding (dash to the ship, then jump in + despawn) overrides the wander; else
        // talking (hold + face you) → paused (loiter) → moving (until arrival).
        let stopped = false;
        let facePlayer = false;
        if (c.boarding) {
            if (c.jumping) {
                // Leaping up into the ship (arc handled below); despawn when the hop ends.
                stopped = true;
                c.jumpTimer -= dt;
                if (c.jumpTimer <= 0) {
                    if (!boarded) boarded = [];
                    boarded.push(c);
                }
            }
            // else: running to / waiting under the ship — the crowd drives it (walk/idle below).
            // The hop is triggered externally by hopCats once the ship has descended to meet them.
        } else if (c.talking) {
            stopped = true;
            facePlayer = true;
        } else if (c.state === 'paused') {
            c.pauseTimer -= dt;
            if (c.pauseTimer <= 0) {
                // Time to move: issue a fresh target and go. Crucially do NOT take the stopped=true
                // path — zeroing the agent velocity on the same frame we requestMoveTarget overrides
                // (cancels) the move, so the cat never actually leaves. This was killing the wander.
                retarget(c, navigation);
                c.state = 'moving';
            } else {
                stopped = true;
            }
        } else {
            // Leash: if crowd shoving has pushed it well past the wander ring, head back now.
            const strayed = Math.hypot(x - c.center[0], z - c.center[2]) > c.wanderRadius * 1.6;
            c.retarget -= dt;
            if (strayed || c.retarget <= 0 || Math.hypot(x - c.targetX, z - c.targetZ) < ARRIVE_DIST) {
                if (strayed) {
                    retarget(c, navigation); // fresh target back near the ship
                } else {
                    c.state = 'paused';
                    c.pauseTimer = PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
                }
            }
        }
        if (stopped) setAgentVelocity(navigation, c.agentId, [0, 0, 0]);

        // Speed + heading from the frame's motion.
        const dx = x - c.prevX;
        const dz = z - c.prevZ;
        const speed = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
        let targetYaw = c.yaw;
        if (facePlayer) {
            const pdx = playerPos[0] - x;
            const pdz = playerPos[2] - z;
            if (pdx * pdx + pdz * pdz > 0.04) targetYaw = Math.atan2(pdx, pdz);
        } else if (dx * dx + dz * dz > 1e-6) {
            targetYaw = Math.atan2(dx, dz);
        }
        const turn = facePlayer ? TALK_TURN : IDLE_TURN;
        c.yaw += Math.atan2(Math.sin(targetYaw - c.yaw), Math.cos(targetYaw - c.yaw)) * Math.min(1, turn * dt);
        c.prevX = x;
        c.prevZ = z;

        if (c.jumping) {
            // Procedural leap: arc from where it left the floor up into the ship (boardTarget),
            // with a parabolic lift peaking mid-hop. No grounding — it's airborne, then despawns.
            const p = Math.min(1, 1 - c.jumpTimer / HOP_DUR);
            const lift = HOP_LIFT * 4 * p * (1 - p);
            c.mesh.position.set(
                c.hopFrom[0] + (c.boardTarget[0] - c.hopFrom[0]) * p,
                c.hopFrom[1] + (c.boardTarget[1] - c.hopFrom[1]) * p + lift,
                c.hopFrom[2] + (c.boardTarget[2] - c.hopFrom[2]) * p,
            );
            c.mesh.rotation.y = c.yaw;
        } else {
            // Sit on the ACTUAL collider surface (the navmesh only approximates it): raycast down
            // from just above the agent's navmesh height and snap to the floor. Falls back to the
            // navmesh height if the ray misses (e.g. over a gap).
            const floorY = groundAt(physics, x, z, y + 1.0, 3.0) ?? y;
            c.mesh.position.set(x, floorY + c.yOffset, z);
            c.mesh.rotation.y = c.yaw;
            moveCharacterCollider(physics, c.it.bodyId, [x, floorY, z]);
            c.it.head[0] = x;
            c.it.head[1] = floorY + c.headOffset;
            c.it.head[2] = z;
        }

        // Crossfade Idle <-> Walk (skipped while the one-shot jump-in plays); drive Walk from speed.
        if (!c.jumping) {
            const walking = !stopped && speed > WALK_ENTER;
            c.walkWeight += ((walking ? 1 : 0) - c.walkWeight) * Math.min(1, CROSSFADE * dt);
            c.walk?.setEffectiveWeight(c.walkWeight);
            c.idle?.setEffectiveWeight(1 - c.walkWeight);
            if (c.walk) c.walk.timeScale = THREE.MathUtils.clamp(speed / WALK_REF, 1.0, 2.2);
        }
        c.mixer.update(dt);
    }

    // Remove any cats that just finished leaping into the ship.
    if (boarded) for (const c of boarded) removeCat(cats, navigation, physics, interactables, c);
}

// Set/clear the "being talked to" hold (the cat stops and faces the player). On release it
// loiters briefly before wandering off again.
export function setCatTalking(cat: Cat, talking: boolean): void {
    cat.talking = talking;
    if (!talking) {
        cat.state = 'paused';
        cat.pauseTimer = 0.6;
    }
}

const BOARD_SPEED = 2.6; // m/s — a proper dash to the ship (vs the lazy wander speed)

// Finale step 1: send every cat dashing to the ground under the ship (target snaps onto the
// navmesh below it). They gather + wait there until hopCats fires. They've stolen it — see index.ts.
export function boardCats(cats: Cats, navigation: Navigation, target: Vec3): void {
    for (const c of cats.list) {
        c.boarding = true;
        c.talking = false;
        setAgentMaxSpeed(navigation, c.agentId, BOARD_SPEED); // stampede, not a stroll
        setAgentTarget(navigation, c.agentId, [target[0], target[1], target[2]]);
    }
}

// Finale: true once every cat has reached the ground under the ship (within `threshold`).
export function allCatsGathered(cats: Cats, navigation: Navigation, threshold: number): boolean {
    return cats.list.every((c) => isAgentAtTarget(navigation, c.agentId, threshold));
}

// Finale step 2: once the ship has descended to meet them, launch every gathered cat on a hop up
// into it (arcing from where it stands to `shipPoint`). Each despawns at the end of its hop.
export function hopCats(cats: Cats, shipPoint: Vec3): void {
    for (const c of cats.list) {
        if (c.jumping) continue;
        c.boardTarget = [shipPoint[0], shipPoint[1], shipPoint[2]];
        c.hopFrom = [c.mesh.position.x, c.mesh.position.y, c.mesh.position.z];
        c.yaw = Math.atan2(shipPoint[0] - c.hopFrom[0], shipPoint[2] - c.hopFrom[2]); // face the ship
        c.jumping = true;
        c.jumpTimer = HOP_DUR;
        c.walk?.setEffectiveWeight(0);
        c.idle?.setEffectiveWeight(0);
        if (c.jump) {
            c.jump.reset();
            c.jump.setEffectiveWeight(1);
            c.jump.play();
        }
    }
}

// Remove one cat entirely (crowd agent + raycast sensor + mesh) and pull it from the list.
function removeCat(cats: Cats, navigation: Navigation, physics: Physics, interactables: Interactables, c: Cat): void {
    removeInteractable(interactables, physics, c.it); // unmap the sensor + hide the mesh
    removeCrowdAgent(navigation, c.agentId); // pull the agent from the crowd
    c.mesh.parent?.remove(c.mesh); // and out of the scene graph
    const i = cats.list.indexOf(c);
    if (i >= 0) cats.list.splice(i, 1);
}

// Finale safety net: force-remove any cats still around (e.g. a straggler that never reached the
// ship) so nothing lingers after the ship's gone. Most despawn themselves at the end of their jump.
export function despawnCats(cats: Cats, navigation: Navigation, physics: Physics, interactables: Interactables): void {
    for (const c of [...cats.list]) removeCat(cats, navigation, physics, interactables, c);
}
