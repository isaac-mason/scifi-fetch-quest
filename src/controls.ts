import { kcc } from 'crashcat';
import type { Vec3 } from 'mathcat';
import type * as THREE from 'three';

import { type Character, EYE_HEIGHT, updateCharacterController } from './character-controller';
import { createInput, type Input } from './input';
import type { Physics } from './physics';
import { CHARACTER_LOOK_TARGET, CHARACTER_SPAWN } from './scene';

const LOOK_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
const PITCH_LIMIT = Math.PI / 2 - 0.05; // stop just short of straight up/down

// --- View bob (ported verbatim from makecat's character-controller bob math) ---
// Phase velocity maps horizontal speed -> angular rate, capped so a fast slide can't spin the cycle
// unbounded. One bob cycle is 2*pi radians.
const BOB_PHASE_VEL_PER_M_S = 2.5;
const BOB_PHASE_VEL_MAX = 22;
// Extra phase-rate multiplier while sprinting, so the run cadence reads as clearly faster.
const BOB_PHASE_VEL_SPRINT_FACTOR = 1.1;
// Lerp rates for the amplitude ramp (per second, used as `dt * rate`).
const BOB_AMP_LERP_RATE = 15;
const BOB_OFFSET_LERP_RATE = 15;
// On landing, jam the phase to the bottom of the cycle (sin = -1) so the walk restarts on a foot-plant.
const BOB_LANDING_PHASE = (3 * Math.PI) / 2;

type BobStatus = 'walk' | 'run' | 'crouch' | 'idle' | 'fall' | 'fly';

// Per-state amplitude targets (metres), verbatim from makecat. Only walk/run/idle/fall are reachable
// here (no crouch/noclip); crouch/fly kept for fidelity. Two deliberate deviations from the source:
//   1. Scaled down (~0.45x) - source amplitudes are tuned for a 1.62m eye height; ours sits at
//      0.75m, so the same numbers read ~2x too intense.
//   2. Lateral-dominant - the source's camera bob is vertical-only (side-to-side lived in the
//      viewmodel item sway we don't have), so walk gets a horizontal component larger than vertical.
// Lateral uses sin(phase/2) (half frequency -> slow sway); vertical uses sin(phase).
const BOB_STATE_VALUES: Record<BobStatus, { horizontalAmplitude: number; verticalAmplitude: number }> = {
    walk: { horizontalAmplitude: 0.022, verticalAmplitude: 0.012 },
    run: { horizontalAmplitude: 0.032, verticalAmplitude: 0.018 },
    crouch: { horizontalAmplitude: 0, verticalAmplitude: 0 },
    idle: { horizontalAmplitude: 0, verticalAmplitude: 0 },
    fall: { horizontalAmplitude: 0, verticalAmplitude: 0 },
    fly: { horizontalAmplitude: 0, verticalAmplitude: 0 },
};

export type FirstPersonControls = {
    camera: THREE.PerspectiveCamera;
    domElement: HTMLElement;
    /** Whether this controller is the active camera driver (vs. orbit mode). */
    enabled: boolean;
    /** Is the pointer currently locked (mouse driving the look)? */
    locked: boolean;
    /** When true, keeps pointer lock but stops driving look/movement/interact, so an overlay
     *  (e.g. the dialogue radial) can read the raw mouse deltas. Toggle via setControlsPaused. */
    paused: boolean;
    yaw: number;
    pitch: number;
    /** Device-agnostic input intent (analog move axis + buttons) this controller produces; see
     *  input.ts. Read by the character controller + interaction. */
    input: Input;
    /** Keyboard binding state: which movement keys are held. Derived into input.move by
     *  applyMoveKeys - a keyboard-specific detail, kept off the device-agnostic Input. */
    moveKeys: { forward: boolean; backward: boolean; left: boolean; right: boolean };
    /** View-bob runtime state (see updateCameraBob). */
    bob: {
        /** bob phase in radians; advances at `phaseVelocity * dt` while moving. */
        phase: number;
        sineValue: number;
        sineValuePrevious: number;
        previousPhase: number;
        /** amplitudes ramp toward the per-state targets; snap to 0 on stop. */
        lateralAmplitude: number;
        verticalAmplitude: number;
        /** head displacement: offsetX along the yaw-right vector, offsetY along up. */
        offsetX: number;
        offsetY: number;
        /** previous tick's grounded, to re-anchor the phase on landing. */
        previousGrounded: boolean;
    };
    /** Smoothed feet Y the eye follows, so bumpy collider terrain doesn't jolt the view.
     *  NaN until the first camera update anchors it to the actual feet. */
    smoothedFeetY: number;
};

// Initial look angles from the spawn -> look-target direction (see scene.ts).
function initialAngles(): { yaw: number; pitch: number } {
    const dx = CHARACTER_LOOK_TARGET[0] - CHARACTER_SPAWN[0];
    const dy = CHARACTER_LOOK_TARGET[1] - (CHARACTER_SPAWN[1] + EYE_HEIGHT);
    const dz = CHARACTER_LOOK_TARGET[2] - CHARACTER_SPAWN[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    // Forward (yaw only) is (-sin yaw, 0, -cos yaw); pitch lifts it on the up axis.
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
    return { yaw, pitch };
}

export function initFirstPersonControls(camera: THREE.PerspectiveCamera, domElement: HTMLElement): FirstPersonControls {
    const { yaw, pitch } = initialAngles();

    const controls: FirstPersonControls = {
        camera,
        domElement,
        enabled: true,
        locked: false,
        paused: false,
        yaw,
        pitch,
        input: createInput(),
        moveKeys: { forward: false, backward: false, left: false, right: false },
        bob: {
            phase: 0,
            sineValue: 0,
            sineValuePrevious: 0,
            previousPhase: 0,
            lateralAmplitude: 0,
            verticalAmplitude: 0,
            offsetX: 0,
            offsetY: 0,
            previousGrounded: false,
        },
        smoothedFeetY: Number.NaN,
    };

    // Click the canvas to capture the mouse; once captured, a left-click interacts.
    domElement.addEventListener('click', () => {
        if (!controls.enabled || controls.paused) return;
        if (controls.locked) controls.input.interact = true;
        else domElement.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
        controls.locked = document.pointerLockElement === domElement;
    });

    document.addEventListener('mousemove', (e) => {
        if (!controls.locked || controls.paused) return;
        controls.yaw -= e.movementX * LOOK_SENSITIVITY;
        controls.pitch -= e.movementY * LOOK_SENSITIVITY;
        controls.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, controls.pitch));
    });

    const setKey = (code: string, down: boolean): boolean => {
        switch (code) {
            case 'KeyW':
            case 'ArrowUp':
                controls.moveKeys.forward = down;
                break;
            case 'KeyS':
            case 'ArrowDown':
                controls.moveKeys.backward = down;
                break;
            case 'KeyA':
            case 'ArrowLeft':
                controls.moveKeys.left = down;
                break;
            case 'KeyD':
            case 'ArrowRight':
                controls.moveKeys.right = down;
                break;
            case 'Space':
                controls.input.jump = down;
                return true;
            case 'ShiftLeft':
            case 'ShiftRight':
                controls.input.sprint = down;
                return true;
            default:
                return false;
        }
        applyMoveKeys(controls); // a movement key changed -> refresh the analog axis
        return true;
    };

    window.addEventListener('keydown', (e) => {
        if (!controls.enabled || controls.paused) return;
        if (setKey(e.code, true)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
        setKey(e.code, false);
    });

    return controls;
}

// Pause/resume the controller without releasing pointer lock: freezes look/movement/interact so an
// overlay can consume the mouse. Clears held movement on pause. Pointer stays locked, so mouse
// deltas still flow to the overlay's own listeners.
export function setControlsPaused(controls: FirstPersonControls, paused: boolean): void {
    controls.paused = paused;
    if (paused) clearHeld(controls);
}

// Release the mouse and clear held keys (e.g. when switching to orbit mode).
export function releaseFirstPersonControls(controls: FirstPersonControls): void {
    if (controls.locked) document.exitPointerLock();
    clearHeld(controls);
    controls.input.interact = false;
}

// Release all held movement/jump/sprint so the character stops (keydown is gated while paused, so
// keys pressed before a pause don't linger). Clears the keyboard binding state AND the derived axis.
function clearHeld(controls: FirstPersonControls): void {
    controls.moveKeys.forward = false;
    controls.moveKeys.backward = false;
    controls.moveKeys.left = false;
    controls.moveKeys.right = false;
    controls.input.move[0] = 0;
    controls.input.move[1] = 0;
    controls.input.jump = false;
    controls.input.sprint = false;
}

// Smoothly turn the view to look at a world point (during dialogue / the launch, while paused).
// Lerps yaw/pitch toward the aim each frame, so control resumes without a snap. Matches
// updateFirstPersonCamera's angle convention (forward = (-sin yaw, ..., -cos yaw), pitch on up).
const FACE_RATE = 6; // per-second approach toward the target look angles
export function faceFirstPersonToward(controls: FirstPersonControls, character: Character, target: Vec3, dt: number): void {
    const ex = character.kcc.position[0];
    const ey = character.kcc.position[1] + EYE_HEIGHT;
    const ez = character.kcc.position[2];
    const dx = target[0] - ex;
    const dy = target[1] - ey;
    const dz = target[2] - ez;
    const len = Math.hypot(dx, dy, dz) || 1;
    const targetYaw = Math.atan2(-dx, -dz);
    const targetPitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
    const k = Math.min(1, FACE_RATE * dt);
    // Shortest-arc yaw approach so we never spin the long way round.
    const dYaw = Math.atan2(Math.sin(targetYaw - controls.yaw), Math.cos(targetYaw - controls.yaw));
    controls.yaw += dYaw * k;
    controls.pitch += (targetPitch - controls.pitch) * k;
}

// Refresh the analog move axis (input.move) from held keyboard keys. A key is +/-1, so a diagonal
// is (1,1) - magnitude sqrt(2), which the controller clamps to full speed.
function applyMoveKeys(controls: FirstPersonControls): void {
    const k = controls.moveKeys;
    controls.input.move[0] = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    controls.input.move[1] = (k.forward ? 1 : 0) - (k.backward ? 1 : 0);
}

// Rotate a LOCAL analog move axis (x=strafe, y=forward) by the camera yaw into a world-space
// horizontal direction. Magnitude is preserved (analog tilt), so the caller can scale speed by it.
function getMoveDirection(move: readonly [number, number], yaw: number, out: Vec3): Vec3 {
    const r = move[0];
    const f = move[1];
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // forward = (-sin, 0, -cos); right = (cos, 0, -sin)
    out[0] = -sin * f + cos * r;
    out[1] = 0;
    out[2] = -cos * f - sin * r;
    return out;
}

const _moveDir: Vec3 = [0, 0, 0];

// Drive the player's KCC from this frame's first-person input: feed it the move direction + the
// jump/sprint intent. No-op while the controller is disabled (orbit-camera debug mode) so the
// character holds still. Keeps the input->controller wiring in the input layer; the KCC stays
// input-agnostic (updateCharacter takes plain movement intent, drivable by AI or a replay too).
export function driveCharacter(controls: FirstPersonControls, physics: Physics, character: Character, dt: number): void {
    if (!controls.enabled) return;
    getMoveDirection(controls.input.move, controls.yaw, _moveDir);
    updateCharacterController(physics, character, _moveDir, controls.input, dt);
}

// Advance the view-bob for this frame. Phase velocity is driven by the character's
// actual horizontal velocity (so running into a wall stops the cycle), the amplitude
// eases toward the per-state target, and offsets settle back home when stopped.
function updateCameraBob(controls: FirstPersonControls, velocity: Vec3, grounded: boolean, dt: number): void {
    const bob = controls.bob;

    bob.previousPhase = bob.phase;

    // Re-anchor on landing so the cycle restarts at the bottom (sin = -1).
    if (grounded && !bob.previousGrounded) {
        bob.phase = BOB_LANDING_PHASE;
    }

    const vx = velocity[0];
    const vz = velocity[2];
    const horizontalSpeed = Math.sqrt(vx * vx + vz * vz);

    let phaseVelocity = horizontalSpeed * BOB_PHASE_VEL_PER_M_S;
    if (controls.input.sprint && grounded) phaseVelocity *= BOB_PHASE_VEL_SPRINT_FACTOR;
    if (phaseVelocity > BOB_PHASE_VEL_MAX) phaseVelocity = BOB_PHASE_VEL_MAX;

    if (phaseVelocity > 0) {
        bob.phase += phaseVelocity * dt;
    } else {
        // Not moving -> reset so the next walk starts at the foot-plant.
        bob.phase = 0;
    }

    const sineValue = Math.sin(bob.phase);
    const sineValueHalf = Math.sin(bob.phase * 0.5);
    bob.sineValuePrevious = bob.sineValue;
    bob.sineValue = sineValue;

    // clingy-space-friends has no crouch/noclip, so only walk/run/idle/fall occur.
    const status: BobStatus = !grounded ? 'fall' : horizontalSpeed > 0 ? (controls.input.sprint ? 'run' : 'walk') : 'idle';
    const targets = BOB_STATE_VALUES[status];

    if (phaseVelocity > 0) {
        const ampK = dt * BOB_AMP_LERP_RATE;

        // Lateral: sin(phase/2), written directly so it tracks the sinusoid exactly.
        bob.lateralAmplitude += (targets.horizontalAmplitude - bob.lateralAmplitude) * ampK;
        if (bob.lateralAmplitude > 0) {
            bob.offsetX = sineValueHalf * bob.lateralAmplitude;
        }

        // Vertical: sin(phase), full sine - dips and rises.
        bob.verticalAmplitude += (targets.verticalAmplitude - bob.verticalAmplitude) * ampK;
        if (bob.verticalAmplitude > 0) {
            bob.offsetY = sineValue * bob.verticalAmplitude;
        }
    } else {
        // Settle: amplitudes hard-zero, offsets glide home instead of snapping.
        bob.lateralAmplitude = 0;
        bob.verticalAmplitude = 0;
        const resetK = dt * BOB_OFFSET_LERP_RATE;
        bob.offsetX += -bob.offsetX * resetK;
        bob.offsetY += -bob.offsetY * resetK;
    }

    bob.previousGrounded = grounded;
}

// Point the camera at the character's eyes and aim it from yaw/pitch, with view-bob.
// Eye-height smoothing so bumpy collider terrain doesn't jolt the view. Only applied while
// grounded - airborne (jumps/falls) the eye tracks the feet exactly, so those stay crisp.
const EYE_SMOOTH_TAU = 0.09; // seconds - vertical smoothing time constant (bigger = smoother/laggier)
const EYE_MAX_LAG = 0.35; // metres - the eye never trails the actual feet by more than this

export function updateFirstPersonCamera(controls: FirstPersonControls, character: Character, dt: number): void {
    const feet = character.kcc.position;
    const grounded = character.kcc.ground.state === kcc.GroundState.ON_GROUND;
    updateCameraBob(controls, character.kcc.linearVelocity, grounded, dt);

    // Smooth the feet Y the eye follows. Anchor on first use; while grounded, ease toward the
    // real feet Y (frame-rate-independent) and clamp the lag so big steps still catch up
    // quickly. Airborne, snap to the real feet so jumps/falls feel responsive.
    if (Number.isNaN(controls.smoothedFeetY)) controls.smoothedFeetY = feet[1];
    if (grounded) {
        const alpha = 1 - Math.exp(-dt / EYE_SMOOTH_TAU);
        controls.smoothedFeetY += (feet[1] - controls.smoothedFeetY) * alpha;
        const lag = controls.smoothedFeetY - feet[1];
        if (lag > EYE_MAX_LAG) controls.smoothedFeetY = feet[1] + EYE_MAX_LAG;
        else if (lag < -EYE_MAX_LAG) controls.smoothedFeetY = feet[1] - EYE_MAX_LAG;
    } else {
        controls.smoothedFeetY = feet[1];
    }

    // Bob shifts the eye along the yaw-aligned right vector (lateral) and world up (vertical) -
    // the same right = (cos yaw, 0, -sin yaw) the move code uses.
    const bob = controls.bob;
    const rightX = Math.cos(controls.yaw);
    const rightZ = -Math.sin(controls.yaw);
    controls.camera.position.set(
        feet[0] + rightX * bob.offsetX,
        controls.smoothedFeetY + EYE_HEIGHT + bob.offsetY,
        feet[2] + rightZ * bob.offsetX,
    );
    controls.camera.rotation.order = 'YXZ';
    controls.camera.rotation.set(controls.pitch, controls.yaw, 0);
}
