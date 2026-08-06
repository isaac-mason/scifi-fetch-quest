import { kcc } from 'crashcat';
import type { Vec3 } from 'mathcat';
import type * as THREE from 'three';

import { type Character, EYE_HEIGHT } from './character';
import { CHARACTER_LOOK_TARGET, CHARACTER_SPAWN } from './scene';

const LOOK_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
const PITCH_LIMIT = Math.PI / 2 - 0.05; // stop just short of straight up/down

// --- View bob (ported verbatim from makecat's character-controller bob math) ---
// Phase velocity is a linear map of actual horizontal speed → angular rate, capped
// so a fast slide can't spin the cycle unbounded. One bob cycle is 2π radians.
const BOB_PHASE_VEL_PER_M_S = 2.5;
const BOB_PHASE_VEL_MAX = 22;
// Extra phase-rate multiplier while sprinting — sprint speed alone only nudges the
// phase ~30% above walk, so this makes the run cadence read as clearly faster.
const BOB_PHASE_VEL_SPRINT_FACTOR = 1.1;
// Lerp rates for the amplitude ramp (per second, used as `dt * rate`).
const BOB_AMP_LERP_RATE = 15;
const BOB_OFFSET_LERP_RATE = 15;
// On landing, jam the phase to the bottom of the cycle (sin = −1) so the walk
// restarts on a foot-plant.
const BOB_LANDING_PHASE = (3 * Math.PI) / 2;

type BobStatus = 'walk' | 'run' | 'crouch' | 'idle' | 'fall' | 'fly';

// Per-state amplitude targets (metres), verbatim from makecat. clingy-space-friends has no
// crouch/noclip inputs, so walk/run/idle/fall are reachable here; crouch/fly are kept
// for fidelity. These deviate from the source's raw numbers in two deliberate ways:
//   1. Scaled down (~0.45×) — the source's amplitudes are absolute metres tuned for a
//      1.62 m eye height; clingy-space-friends's eye sits at 0.75 m, so the same numbers read
//      ~2× too intense here.
//   2. Lateral-dominant — the source's *camera* walk bob is vertical-only; its
//      side-to-side motion lived in the (viewmodel-only) item sway, which we don't
//      have. We fold that side-to-side into the camera by giving walk a horizontal
//      component larger than its vertical one.
// Lateral uses sin(phase/2) (half frequency → slow sway); vertical uses sin(phase).
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
    yaw: number;
    pitch: number;
    input: {
        forward: boolean;
        backward: boolean;
        left: boolean;
        right: boolean;
        jump: boolean;
        sprint: boolean;
        /** One-shot interact (left-click while locked). Set on click; the loop consumes it. */
        interact: boolean;
    };
    /** View-bob runtime state (see updateCameraBob). */
    bob: {
        /** bob phase in radians; advances at `phaseVelocity · dt` while moving. */
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

// Initial look angles from the spawn → look-target direction (see scene.ts).
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
        yaw,
        pitch,
        input: { forward: false, backward: false, left: false, right: false, jump: false, sprint: false, interact: false },
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
        if (!controls.enabled) return;
        if (controls.locked) controls.input.interact = true;
        else domElement.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
        controls.locked = document.pointerLockElement === domElement;
    });

    document.addEventListener('mousemove', (e) => {
        if (!controls.locked) return;
        controls.yaw -= e.movementX * LOOK_SENSITIVITY;
        controls.pitch -= e.movementY * LOOK_SENSITIVITY;
        controls.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, controls.pitch));
    });

    const setKey = (code: string, down: boolean): boolean => {
        switch (code) {
            case 'KeyW':
            case 'ArrowUp':
                controls.input.forward = down;
                return true;
            case 'KeyS':
            case 'ArrowDown':
                controls.input.backward = down;
                return true;
            case 'KeyA':
            case 'ArrowLeft':
                controls.input.left = down;
                return true;
            case 'KeyD':
            case 'ArrowRight':
                controls.input.right = down;
                return true;
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
    };

    window.addEventListener('keydown', (e) => {
        if (!controls.enabled) return;
        if (setKey(e.code, true)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
        setKey(e.code, false);
    });

    return controls;
}

// Release the mouse and clear held keys (e.g. when switching to orbit mode).
export function releaseFirstPersonControls(controls: FirstPersonControls): void {
    if (controls.locked) document.exitPointerLock();
    controls.input.forward = false;
    controls.input.backward = false;
    controls.input.left = false;
    controls.input.right = false;
    controls.input.jump = false;
    controls.input.sprint = false;
    controls.input.interact = false;
}

// Build the world-space horizontal move direction from yaw + the held keys.
export function getMoveDirection(controls: FirstPersonControls, out: Vec3): Vec3 {
    const f = (controls.input.forward ? 1 : 0) - (controls.input.backward ? 1 : 0);
    const r = (controls.input.right ? 1 : 0) - (controls.input.left ? 1 : 0);
    const sin = Math.sin(controls.yaw);
    const cos = Math.cos(controls.yaw);
    // forward = (-sin, 0, -cos); right = (cos, 0, -sin)
    out[0] = -sin * f + cos * r;
    out[1] = 0;
    out[2] = -cos * f - sin * r;
    return out;
}

// Advance the view-bob for this frame. Phase velocity is driven by the character's
// actual horizontal velocity (so running into a wall stops the cycle), the amplitude
// eases toward the per-state target, and offsets settle back home when stopped.
function updateCameraBob(controls: FirstPersonControls, velocity: Vec3, grounded: boolean, dt: number): void {
    const bob = controls.bob;

    bob.previousPhase = bob.phase;

    // Re-anchor on landing so the cycle restarts at the bottom (sin = −1).
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
        // Not moving → reset so the next walk starts at the foot-plant.
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

        // Vertical: sin(phase), full sine — dips and rises.
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
// grounded — airborne (jumps/falls) the eye tracks the feet exactly, so those stay crisp.
const EYE_SMOOTH_TAU = 0.09; // seconds — vertical smoothing time constant (bigger = smoother/laggier)
const EYE_MAX_LAG = 0.35; // metres — the eye never trails the actual feet by more than this

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

    // Bob shifts the eye along the yaw-aligned right vector (lateral) and world up
    // (vertical) — the same right = (cos yaw, 0, −sin yaw) the move code uses.
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
