import type { BodyId } from 'crashcat';
import type { Vec3 } from 'mathcat';

import {
    addCrowdAgent,
    getAgent,
    isAgentAtTarget,
    makeAgentParams,
    type Navigation,
    removeCrowdAgent,
    setAgentMaxSpeed,
    setAgentTarget,
    setAgentVelocity,
    snapToNavMesh,
} from './navigation';
import { addCharacterCollider, groundAt, moveCharacterCollider, type Physics, removeCharacterCollider } from './physics';
import { CATS_CENTER, CATS_COUNT, CATS_SPREAD, QUEST_CAST } from './scene';

// The unified NPC data model. Every non-player character — the crew AND the cats — is a Character:
// a navcat crowd agent + a ghost sensor for the view ray + a grounded feet position + a behaviour.
// This module owns the DATA and the per-frame kinematics/steering; it holds no three.js. The
// visual system (character-visuals.ts) reads these and draws an animated model per id.
//
// The only thing that differs between a crewmember and a cat is its `behaviour` (and its model +
// tuning): crew `follow` the player; cats `wander`, then in the finale `goto` the ship and `hop`
// aboard. Each behaviour is a small tagged variant with its own updater — no god-object of flags.

// --- Behaviours (tagged union) -------------------------------------------------------------------

// Crew: parked at a room anchor (`stationary`) until the quest flips them to `following` the player.
export type FollowBehaviour = { kind: 'follow'; mode: 'stationary' | 'following'; target: Vec3; facePlayer: boolean };
// Cats loitering: stop-and-go wander around a centre; hold + face the player while being talked to.
export type WanderBehaviour = {
    kind: 'wander';
    center: Vec3;
    radius: number;
    state: 'moving' | 'paused';
    pauseTimer: number; // seconds left of the current loiter
    targetX: number;
    targetZ: number;
    retarget: number; // seconds before giving up on an unreachable target
    talking: boolean; // held + facing the player while being talked to
};
// Finale step 1: steer the agent to a world point (the gather spot under the ship).
export type GotoBehaviour = { kind: 'goto'; target: Vec3 };
// Finale step 2: a procedural position-arc leap from `from` to `to`; despawns when `timer` runs out.
export type HopBehaviour = { kind: 'hop'; from: Vec3; to: Vec3; timer: number };

export type Behaviour = FollowBehaviour | WanderBehaviour | GotoBehaviour | HopBehaviour;

export type Character = {
    id: string; // == navcat agent id
    model: string; // which template character-visuals draws ('George' … | 'cat')
    name: string; // nameplate label
    headHeight: number; // metres above the feet the camera looks at while talking
    position: Vec3; // grounded feet, world space (snapped to the collider, not the navmesh)
    facing: number; // yaw (radians)
    speed: number; // m/s (drives idle <-> walk in the visuals)
    prev: Vec3; // previous position (for velocity)
    sensor: BodyId; // kinematic ghost capsule the view ray hits (→ bodyToCharacter)
    emote: string | null; // one-shot clip request; the visual system consumes it
    behaviour: Behaviour;
};

export type Characters = { list: Character[] };

export function initCharacters(): Characters {
    return { list: [] };
}

// --- Crew tuning (world units; this ship is ~human-at-half-scale) ---
const FOLLOW_RADIUS = 0.5; // agent radius navcat keeps between companions
const FOLLOW_HEIGHT = 1.3; // agent height (a bit taller than the ~1m player)
const FOLLOW_SPEED = 3.4; // m/s — roughly matches the player's 3.5 walk
const STOP_DISTANCE = 1.2; // hold this far from the player instead of crowding them
const REISSUE_DIST = 0.4; // only re-aim once the player has moved this far (avoids thrash)
const CREW_HEAD = 0.72; // camera look-at height (~face level; crew models are ~1m tall)
const LOOK_AT_RANGE = 6; // metres within which an idle crew member ambiently turns to face you
const FACE_IDLE_RATE = 1.2; // per second — the ambient "turn toward you" while idle
const FACE_TALK_RATE = 6; // per second — snappier turn while being spoken to

// --- Cat tuning ---
const CAT_RADIUS = 0.25; // crowd avoidance radius
const CAT_AGENT_HEIGHT = 0.4; // crowd agent height (distinct from the model fit height in scene.ts)
const CAT_SPEED = 0.55; // m/s stroll
const CAT_HEAD = 0.18; // camera look-at height above a cat's feet
const CAT_SENSOR_RADIUS = 0.4; // view-ray sensor capsule
const CAT_SENSOR_HEIGHT = 0.6;
const ARRIVE_DIST = 0.4; // within this of its target, a cat stops for a bit
const RETARGET_MAX = 6; // seconds before giving up on a target it can't reach
const PAUSE_MIN = 0.8; // seconds a cat loiters between strolls (stop-and-go)
const PAUSE_MAX = 3.0;
const BOARD_SPEED = 2.6; // m/s — a proper dash to the ship (vs the lazy wander speed)
const HOP_DUR = 0.6; // seconds of the finale leap into the ship (procedural — model has no jump clip)
const HOP_LIFT = 0.5; // metres of extra arc height at the peak of the hop
const HOP_CLIP = 'Fall'; // the cat model's mid-air flair clip (no dedicated jump clip exists)

// Below this speed the horizontal motion is mostly jitter, so hold the last heading rather than
// spinning to chase noise; above it, face the travel direction.
const FACING_MIN_SPEED = 0.25;

const GROUND_RAY_UP = 0.5;
const GROUND_RAY_DIST = 5.0;

// Grounded feet Y at (x, z): the collider surface under the navmesh point, or the navmesh height
// itself if the ray misses (over a gap).
function groundedY(physics: Physics, x: number, z: number, navY: number): number {
    return groundAt(physics, x, z, navY + GROUND_RAY_UP, GROUND_RAY_DIST) ?? navY;
}

// --- Spawning ------------------------------------------------------------------------------------

// Add a crowd agent + ghost sensor at `feet` and return a base Character; the caller sets the
// behaviour. Shared by the crew and cat spawners. Returns null if the agent can't be added.
function spawnCharacter(
    physics: Physics,
    navigation: Navigation,
    opts: {
        model: string;
        name: string;
        headHeight: number;
        feet: Vec3;
        agentRadius: number;
        agentHeight: number;
        agentSpeed: number;
        sensorRadius: number;
        sensorHeight: number;
    },
): Omit<Character, 'behaviour'> | null {
    const params = makeAgentParams(opts.agentRadius, opts.agentHeight, opts.agentSpeed);
    const id = addCrowdAgent(navigation, opts.feet, params);
    if (!id) return null;
    const sensor = addCharacterCollider(physics, id, opts.feet, opts.sensorRadius, opts.sensorHeight);
    const feet: Vec3 = [opts.feet[0], opts.feet[1], opts.feet[2]];
    return {
        id,
        model: opts.model,
        name: opts.name,
        headHeight: opts.headHeight,
        position: [feet[0], feet[1], feet[2]],
        facing: 0,
        speed: 0,
        prev: [feet[0], feet[1], feet[2]],
        sensor,
        emote: null,
    };
}

// Spawn the crew: park each of the four companions at its room anchor (QUEST_CAST) as a STATIONARY
// follow agent. They hold position until the quest flips them to following. Call after the navmesh
// loads.
export function spawnCrew(characters: Characters, navigation: Navigation, physics: Physics): void {
    for (const { model, pos, facing } of QUEST_CAST) {
        const spawn: Vec3 = [pos[0], pos[1], pos[2]];
        if (!snapToNavMesh(navigation, spawn, spawn)) continue; // sit on walkable floor
        const base = spawnCharacter(physics, navigation, {
            model,
            name: model,
            headHeight: CREW_HEAD,
            feet: spawn,
            agentRadius: FOLLOW_RADIUS,
            agentHeight: FOLLOW_HEIGHT,
            agentSpeed: FOLLOW_SPEED,
            sensorRadius: FOLLOW_RADIUS,
            sensorHeight: FOLLOW_HEIGHT,
        });
        if (!base) continue;
        base.facing = facing;
        characters.list.push({
            ...base,
            behaviour: { kind: 'follow', mode: 'stationary', target: [spawn[0], spawn[1], spawn[2]], facePlayer: false },
        });
    }
}

const _catSnap: Vec3 = [0, 0, 0];

// Spawn the cat mob: a scatter of wandering cats around CATS_CENTER. Each is a crowd agent that
// strolls to random navmesh points near the centre (WanderBehaviour). Call after the navmesh loads.
export function spawnCats(characters: Characters, navigation: Navigation, physics: Physics): void {
    const maxFromCenter = CATS_SPREAD * 1.6; // reject spawns that snap far from the ship
    let spawned = 0;
    for (let i = 0; i < CATS_COUNT; i++) {
        // On-navmesh spawn near the centre. snapToNavMesh returns the NEAREST poly, which — near a
        // thin/edge pad — can be surprisingly far; reject those so the mob stays by the ship.
        let onMesh = false;
        for (let t = 0; t < 16 && !onMesh; t++) {
            const guess: Vec3 = [
                CATS_CENTER[0] + (Math.random() * 2 - 1) * CATS_SPREAD,
                CATS_CENTER[1],
                CATS_CENTER[2] + (Math.random() * 2 - 1) * CATS_SPREAD,
            ];
            if (!snapToNavMesh(navigation, guess, _catSnap)) continue;
            const dx = _catSnap[0] - CATS_CENTER[0];
            const dz = _catSnap[2] - CATS_CENTER[2];
            onMesh = dx * dx + dz * dz <= maxFromCenter * maxFromCenter;
        }
        if (!onMesh) continue;

        const base = spawnCharacter(physics, navigation, {
            model: 'cat',
            name: 'cat',
            headHeight: CAT_HEAD,
            feet: [_catSnap[0], _catSnap[1], _catSnap[2]],
            agentRadius: CAT_RADIUS,
            agentHeight: CAT_AGENT_HEIGHT,
            agentSpeed: CAT_SPEED,
            sensorRadius: CAT_SENSOR_RADIUS,
            sensorHeight: CAT_SENSOR_HEIGHT,
        });
        if (!base) continue;
        base.facing = Math.random() * Math.PI * 2;
        characters.list.push({
            ...base,
            behaviour: {
                kind: 'wander',
                center: [CATS_CENTER[0], CATS_CENTER[1], CATS_CENTER[2]], // wander the SHIP, not the spawn
                radius: CATS_SPREAD,
                state: 'paused',
                pauseTimer: Math.random() * PAUSE_MAX, // stagger the mob's first move
                targetX: _catSnap[0],
                targetZ: _catSnap[2],
                retarget: 0,
                talking: false,
            },
        });
        spawned++;
    }
    console.log(`cats: spawned ${spawned}/${CATS_COUNT} crowd agents near [${CATS_CENTER.join(', ')}]`);
    if (spawned === 0) {
        console.warn('cats: none spawned — CATS_CENTER (scene.ts) is off the navmesh; move it onto walkable floor.');
    }
}

// --- Interaction hooks (called from index) -------------------------------------------------------

// Can the player talk to this character right now? Crew are always talkable; cats only while
// loitering (not mid-finale). Others (goto/hop) are not.
export function isTalkable(ch: Character): boolean {
    return ch.behaviour.kind === 'follow' || ch.behaviour.kind === 'wander';
}

// Flip a crew member from parked to trailing the player (the accusation conga line). No-op unless
// it's a follow character.
export function setCharacterFollowing(characters: Characters, id: string): void {
    const ch = characters.list.find((c) => c.id === id);
    if (ch && ch.behaviour.kind === 'follow') ch.behaviour.mode = 'following';
}

// While talking to a crew member, turn them quickly to face the player (set true on open, false on
// close). No-op for non-follow characters.
export function setFacePlayer(ch: Character, on: boolean): void {
    if (ch.behaviour.kind === 'follow') ch.behaviour.facePlayer = on;
}

// Set/clear a cat's "being talked to" hold (it stops and faces you). On release it loiters briefly
// before wandering off again. No-op for non-wander characters.
export function setCatTalking(ch: Character, on: boolean): void {
    if (ch.behaviour.kind !== 'wander') return;
    ch.behaviour.talking = on;
    if (!on) {
        ch.behaviour.state = 'paused';
        ch.behaviour.pauseTimer = 0.6;
    }
}

// Request a specific (authored) emote on the character with the given id — played once by the
// visuals as the matching clip. Crew use Yes/No/Dance; cats use Spin/Idle. A clip the model lacks
// is simply ignored by the visual system.
export function requestCharacterEmote(characters: Characters, id: string, emote: string): void {
    const ch = characters.list.find((c) => c.id === id);
    if (ch) ch.emote = emote;
}

// --- Finale (cats board the striker) -------------------------------------------------------------

const isCat = (ch: Character) => ch.model === 'cat';

// Finale step 1: send every cat dashing to the ground under the ship (target snaps onto the navmesh
// below it). They gather + wait there (goto) until hopCats fires.
export function boardCats(characters: Characters, navigation: Navigation, target: Vec3): void {
    for (const ch of characters.list) {
        if (!isCat(ch)) continue;
        ch.behaviour = { kind: 'goto', target: [target[0], target[1], target[2]] };
        setAgentMaxSpeed(navigation, ch.id, BOARD_SPEED); // stampede, not a stroll
        setAgentTarget(navigation, ch.id, [target[0], target[1], target[2]]);
    }
}

// Finale: true once every cat has reached the ground under the ship (within `threshold`).
export function allCatsGathered(characters: Characters, navigation: Navigation, threshold: number): boolean {
    return characters.list.filter(isCat).every((ch) => isAgentAtTarget(navigation, ch.id, threshold));
}

// Finale step 2: once the ship has descended to meet them, launch every gathered cat on a hop up
// into it (arcing from where it stands to `shipPoint`). Each despawns at the end of its hop.
export function hopCats(characters: Characters, shipPoint: Vec3): void {
    for (const ch of characters.list) {
        if (!isCat(ch) || ch.behaviour.kind === 'hop') continue;
        const from: Vec3 = [ch.position[0], ch.position[1], ch.position[2]];
        ch.facing = Math.atan2(shipPoint[0] - from[0], shipPoint[2] - from[2]); // face the ship
        ch.behaviour = { kind: 'hop', from, to: [shipPoint[0], shipPoint[1], shipPoint[2]], timer: HOP_DUR };
        ch.emote = HOP_CLIP; // mid-air flair via the shared one-shot slot
    }
}

// Finale safety net: force-remove any cats still around (e.g. a straggler that never reached the
// ship) so nothing lingers after the ship's gone. Most despawn themselves at the end of their hop.
export function despawnCats(characters: Characters, navigation: Navigation, physics: Physics): void {
    for (const ch of [...characters.list]) {
        if (isCat(ch)) removeCharacter(characters, navigation, physics, ch);
    }
}

// Remove one character entirely (crowd agent + sensor unmap) and pull it from the list. The visual
// system drops the mesh on the next frame (its id is no longer alive).
function removeCharacter(characters: Characters, navigation: Navigation, physics: Physics, ch: Character): void {
    removeCrowdAgent(navigation, ch.id);
    removeCharacterCollider(physics, ch.sensor);
    const i = characters.list.indexOf(ch);
    if (i >= 0) characters.list.splice(i, 1);
}

// --- Per-frame update ----------------------------------------------------------------------------

// Advance every character: read its agent, ground it on the collider, derive speed/facing, then run
// its behaviour. Run AFTER the navcat crowd step (navigation.updateCrowd). Pure data — no meshes.
export function updateCharacters(
    characters: Characters,
    navigation: Navigation,
    physics: Physics,
    playerPos: Vec3,
    dt: number,
): void {
    const despawn: Character[] = []; // hop finished this frame → remove after the loop
    for (const ch of characters.list) {
        // The hop is airborne + agent-independent: it drives position by a procedural arc and
        // despawns at the end. Everything else rides the crowd agent, grounded on the collider.
        if (ch.behaviour.kind === 'hop') {
            if (updateHop(ch, ch.behaviour, dt)) despawn.push(ch);
            ch.speed = 0;
            continue;
        }

        const agent = getAgent(navigation, ch.id);
        if (!agent) continue;
        const ax = agent.position[0];
        const az = agent.position[2];
        const floorY = groundedY(physics, ax, az, agent.position[1]);
        ch.position[0] = ax;
        ch.position[1] = floorY;
        ch.position[2] = az;

        // Speed + heading from the frame's horizontal motion.
        const dx = ax - ch.prev[0];
        const dz = az - ch.prev[2];
        ch.speed = dt > 1e-5 ? Math.hypot(dx, dz) / dt : 0;
        if (ch.speed > FACING_MIN_SPEED) {
            ch.facing = Math.atan2(dx, dz); // face the way it's walking
        } else {
            // Stopped: turn toward the player if the behaviour wants it (idle crew, talked-to cats).
            const face = faceIntent(ch, playerPos);
            if (face) {
                const arc = Math.atan2(Math.sin(face.yaw - ch.facing), Math.cos(face.yaw - ch.facing));
                ch.facing += arc * Math.min(1, face.rate * dt);
            }
        }
        ch.prev[0] = ax;
        ch.prev[1] = floorY;
        ch.prev[2] = az;

        // Keep the raycast sensor glued to the character.
        moveCharacterCollider(physics, ch.sensor, ch.position);

        // Behaviour steering (sets the agent's target/velocity for next frame).
        switch (ch.behaviour.kind) {
            case 'follow':
                stepFollow(ch, ch.behaviour, navigation, playerPos);
                break;
            case 'wander':
                stepWander(ch, ch.behaviour, navigation, dt);
                break;
            case 'goto':
                // Agent-driven: the target was set on entry (boardCats); nothing to do per frame.
                break;
        }
    }

    for (const ch of despawn) removeCharacter(characters, navigation, physics, ch);
}

// Where a stopped character wants to face (or null to hold heading), with the turn rate.
function faceIntent(ch: Character, playerPos: Vec3): { yaw: number; rate: number } | null {
    const b = ch.behaviour;
    const pdx = playerPos[0] - ch.position[0];
    const pdz = playerPos[2] - ch.position[2];
    const d2 = pdx * pdx + pdz * pdz;
    if (b.kind === 'follow') {
        // Ambient turn-to-face while idle in range; snappier while being talked to.
        if ((b.facePlayer || d2 < LOOK_AT_RANGE * LOOK_AT_RANGE) && d2 > 0.09) {
            return { yaw: Math.atan2(pdx, pdz), rate: b.facePlayer ? FACE_TALK_RATE : FACE_IDLE_RATE };
        }
    } else if (b.kind === 'wander' && b.talking && d2 > 0.04) {
        return { yaw: Math.atan2(pdx, pdz), rate: FACE_TALK_RATE };
    }
    return null;
}

// Crew follow: chase the player while far, hold once inside STOP_DISTANCE so the companions don't
// jostle the player. Re-issue the target only after the player has actually moved (so navcat isn't
// re-planning every frame). Stationary crew just hold their anchor.
function stepFollow(ch: Character, b: FollowBehaviour, navigation: Navigation, playerPos: Vec3): void {
    if (b.mode === 'stationary') {
        setAgentVelocity(navigation, ch.id, [0, 0, 0]); // don't let avoidance drift the anchor
        return;
    }
    const px = ch.position[0];
    const pz = ch.position[2];
    const toPlayer = Math.hypot(playerPos[0] - px, playerPos[2] - pz);
    if (toPlayer > STOP_DISTANCE) {
        const moved = Math.hypot(playerPos[0] - b.target[0], playerPos[2] - b.target[2]);
        if (moved > REISSUE_DIST) {
            setAgentTarget(navigation, ch.id, playerPos);
            b.target[0] = playerPos[0];
            b.target[1] = playerPos[1];
            b.target[2] = playerPos[2];
        }
    } else {
        // Arrived near the player — decelerate and let the next move re-issue (target reset to
        // here so REISSUE_DIST triggers).
        setAgentVelocity(navigation, ch.id, [0, 0, 0]);
        b.target[0] = px;
        b.target[1] = ch.position[1];
        b.target[2] = pz;
    }
}

const _wanderSnap: Vec3 = [0, 0, 0];

// Cat wander: stop-and-go strolls to random navmesh points near the centre, or hold + face the
// player while being talked to. A leash pulls it back if crowd shoving strays it too far.
function stepWander(ch: Character, b: WanderBehaviour, navigation: Navigation, dt: number): void {
    const x = ch.position[0];
    const z = ch.position[2];
    if (b.talking) {
        setAgentVelocity(navigation, ch.id, [0, 0, 0]); // hold + face (handled in faceIntent)
        return;
    }
    if (b.state === 'paused') {
        b.pauseTimer -= dt;
        if (b.pauseTimer <= 0) {
            // Time to move: issue a fresh target and go. Crucially do NOT also zero the velocity
            // this frame — that cancels the move target and the cat never leaves.
            retargetWander(ch, b, navigation);
            b.state = 'moving';
        } else {
            setAgentVelocity(navigation, ch.id, [0, 0, 0]);
        }
        return;
    }
    // moving: leash back if shoved past the ring, else stop to loiter once arrived / timed out.
    const strayed = Math.hypot(x - b.center[0], z - b.center[2]) > b.radius * 1.6;
    b.retarget -= dt;
    if (strayed || b.retarget <= 0 || Math.hypot(x - b.targetX, z - b.targetZ) < ARRIVE_DIST) {
        if (strayed) {
            retargetWander(ch, b, navigation); // fresh target back near the ship
        } else {
            b.state = 'paused';
            b.pauseTimer = PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
        }
    }
}

// Pick a fresh wander target on the navmesh near the cat's centre and hand it to the crowd.
function retargetWander(ch: Character, b: WanderBehaviour, navigation: Navigation): void {
    for (let t = 0; t < 6; t++) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * b.radius;
        const p: Vec3 = [b.center[0] + Math.cos(ang) * r, b.center[1], b.center[2] + Math.sin(ang) * r];
        if (snapToNavMesh(navigation, p, _wanderSnap)) {
            setAgentTarget(navigation, ch.id, [_wanderSnap[0], _wanderSnap[1], _wanderSnap[2]]);
            b.targetX = _wanderSnap[0];
            b.targetZ = _wanderSnap[2];
            b.retarget = 2 + Math.random() * (RETARGET_MAX - 2);
            return;
        }
    }
}

// Procedural leap: arc from where the cat left the floor up into the ship (`to`), with a parabolic
// lift peaking mid-hop. No grounding — it's airborne. Returns true when the hop is done (despawn).
function updateHop(ch: Character, b: HopBehaviour, dt: number): boolean {
    b.timer -= dt;
    const p = Math.min(1, 1 - b.timer / HOP_DUR);
    const lift = HOP_LIFT * 4 * p * (1 - p);
    ch.position[0] = b.from[0] + (b.to[0] - b.from[0]) * p;
    ch.position[1] = b.from[1] + (b.to[1] - b.from[1]) * p + lift;
    ch.position[2] = b.from[2] + (b.to[2] - b.from[2]) * p;
    return b.timer <= 0;
}
