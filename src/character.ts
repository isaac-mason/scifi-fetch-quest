import { capsule, type Filter, filter, type KCC, kcc, transformed } from 'crashcat';
import { quat, type Vec3, vec3, vec4 } from 'mathcat';
import { OBJECT_LAYER_GHOST, OBJECT_LAYER_MOVING, type Physics } from './physics';
import { CHARACTER_SPAWN, GRAVITY } from './scene';

// --- Character dimensions (metres) ---
const CHARACTER_HEIGHT = 1.2; // full capsule height, foot to crown
const CHARACTER_RADIUS = 0.2;
// A capsule's total height is its cylinder section plus a radius hemisphere at
// each end, so cylinder = height - 2*radius (and half of that for the shape arg).
const HALF_HEIGHT_OF_CYLINDER = CHARACTER_HEIGHT / 2 - CHARACTER_RADIUS;
// Headroom between the eyes and the capsule crown. When you jump into a ceiling the
// KCC stops the crown just below it, so the eye ends up this far under the surface.
// Keep it comfortably larger than the camera's near plane (see CAMERA_NEAR), or the
// ceiling falls inside the near plane when you jump and gets clipped — you'd see
// straight through the roof.
const HEAD_CLEARANCE = 0.25;
/** Camera height above the character's feet (its `position`) — eyes below the crown. */
export const EYE_HEIGHT = CHARACTER_HEIGHT - HEAD_CLEARANCE;

// --- Movement feel — Quake-style (tuned for our ~9.81 m/s² gravity, human scale) ---
const MAX_SPEED = 3.5; // target ground speed (m/s) the accel ramps you up to
const SPRINT_MULTIPLIER = 1.6; // scales ground target speed while sprinting (Shift)
const JUMP_SPEED = 4.5; // upward launch velocity on jump (m/s)
const GROUND_ACCEL = 12; // how hard you accelerate toward wish-dir on the ground
const AIR_ACCEL = 12; // air acceleration — combined with AIR_SPEED_CAP this is what
const AIR_SPEED_CAP = 1.0; //   lets you gain speed by air-strafing (the bhop trick)
const FRICTION = 6; // ground friction; higher = stops quicker
const STOP_SPEED = 1.5; // m/s — below this, friction bites harder so you fully stop
const MAX_SLOPE_ANGLE = (50 * Math.PI) / 180;

export type Character = {
    kcc: KCC;
    filter: Filter;
    updateSettings: kcc.UpdateSettings;
    listener: kcc.CharacterListener;
    /** True only on frames the player is actively steering (has a wish-direction).
     *  Gates the contact-solve velocity-kill below, so we only slide on intentional
     *  input and stand dead-still otherwise. */
    allowSliding: boolean;
};

export function initCharacter(physics: Physics): Character {
    // Offset the shape so the capsule sits ABOVE the character position (= feet):
    // the capsule centre is half the full height up.
    const shapeOffset = vec3.fromValues(0, CHARACTER_HEIGHT / 2, 0);
    const shape = transformed.create({
        shape: capsule.create({ halfHeightOfCylinder: HALF_HEIGHT_OF_CYLINDER, radius: CHARACTER_RADIUS }),
        position: shapeOffset,
        quaternion: quat.create(),
    });

    const character = kcc.create(
        {
            shape,
            // Inner kinematic body so raycasts/sensors can see the character. It
            // doesn't drive movement — the KCC's own sweeps do.
            innerRigidBody: { shape, objectLayer: OBJECT_LAYER_MOVING },
            up: vec3.fromValues(0, 1, 0),
            maxSlopeAngle: MAX_SLOPE_ANGLE,
            // Supporting plane passes through the bottom hemisphere centre (local space).
            supportingVolumePlane: vec4.fromValues(0, 1, 0, -CHARACTER_RADIUS),
            backFaceMode: kcc.BackFaceMode.COLLIDE,
        },
        vec3.fromValues(CHARACTER_SPAWN[0], CHARACTER_SPAWN[1], CHARACTER_SPAWN[2]),
        quat.create(),
    );

    kcc.add(physics.world, character);

    // Tell physics which body is us, so the interaction view ray skips it.
    physics.playerBodyId = character.innerRigidBodyId;

    const updateSettings = kcc.createDefaultUpdateSettings();

    // The player's movement filter starts with every layer enabled. Drop the GHOST object layer
    // so our capsule sweeps ignore the character + interactable raycast capsules (all on GHOST):
    // otherwise the crew/cats can physically wedge us in a hallway. They stay hittable by the
    // interaction view ray, which uses its own all-layers filter (see view-ray.ts). GHOST shares
    // the MOVING broadphase with OBJECT_LAYER_MOVING, so disabling it here leaves the broadphase
    // (and level collision) intact.
    const playerFilter = filter.create(physics.world.settings.layers);
    filter.disableObjectLayer(playerFilter, physics.world.settings.layers, OBJECT_LAYER_GHOST);

    const c: Character = {
        kcc: character,
        filter: playerFilter,
        updateSettings,
        allowSliding: false,
        listener: {},
    };

    // When the player isn't steering (no wish-dir), kill any velocity the KCC's
    // penetration recovery generates against a resting, not-too-steep contact. Without
    // this the character keeps a tiny residual velocity from the uneven collider each
    // frame — it reads as jittering / drifting while standing still. Mirrors the
    // crashcat KCC example's onContactSolve. We only clamp when `allowSliding` is false,
    // so intentional movement (and sliding down steep slopes) is untouched.
    c.listener.onContactSolve = (
        _character,
        _body,
        _subShapeId,
        _contactPosition,
        contactNormal,
        contactVelocity,
        _characterVelocity,
        ioCharacterVelocity,
    ) => {
        if (c.allowSliding) return;
        if (vec3.squaredLength(contactVelocity) < 1e-6 && !kcc.isSlopeTooSteep(character, contactNormal)) {
            vec3.zero(ioCharacterVelocity);
        }
    };

    return c;
}

// Whether the character is currently standing on the ground (vs. airborne / on a steep slope).
export function isOnGround(c: Character): boolean {
    return c.kcc.ground.state === kcc.GroundState.ON_GROUND;
}

// Scratch vectors — reused each frame to avoid per-frame allocation.
const _up = vec3.create();
const _lin = vec3.create();
const _vertical = vec3.create();
const _horizontal = vec3.create();
const _newVel = vec3.create();

/**
 * Quake-style ground friction: bleed off horizontal speed, with extra bite below
 * STOP_SPEED so you come to a clean stop. Operates in place on `vel`.
 */
function applyFriction(vel: Vec3, dt: number): void {
    const speed = vec3.length(vel);
    if (speed < 1e-4) {
        vec3.zero(vel);
        return;
    }
    const control = Math.max(speed, STOP_SPEED);
    const newSpeed = Math.max(speed - control * FRICTION * dt, 0);
    vec3.scale(vel, vel, newSpeed / speed);
}

/**
 * Quake-style acceleration: only adds speed along `wishDir` up to `wishSpeed`.
 * Because it clamps the *projected* speed (not total), aiming wishDir across your
 * velocity while airborne lets total speed climb — that's the air-strafe / bhop
 * trick. Operates in place on `vel`.
 */
function accelerate(vel: Vec3, wishDir: Vec3, wishSpeed: number, accel: number, dt: number): void {
    const currentSpeed = vec3.dot(vel, wishDir);
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
    vec3.scaleAndAdd(vel, vel, wishDir, accelSpeed);
}

/**
 * Advance the character one step, Quake-style. `moveDir` is a world-space
 * horizontal wish-direction (y≈0, any magnitude — normalized here); `jump`
 * requests a jump this frame (hold it to bunny-hop); `sprint` raises the ground
 * target speed (Shift).
 */
export function updateCharacter(physics: Physics, c: Character, moveDir: Vec3, jump: boolean, sprint: boolean, dt: number): void {
    const character = c.kcc;

    const moveLen = vec3.length(moveDir);
    if (moveLen > 1e-6) vec3.scale(moveDir, moveDir, 1 / moveLen);
    else vec3.zero(moveDir);

    // Only permit contact sliding when the player is actively steering — see the
    // onContactSolve listener in initCharacter. A jump also counts as intent so we
    // don't clamp the launch velocity.
    c.allowSliding = moveLen > 1e-6 || jump;

    // Account for moving platforms under the character (vertical follow + ground vel).
    kcc.updateGroundVelocity(physics.world, character, c.listener);

    // Split current velocity into vertical (along up) and horizontal components.
    vec3.copy(_up, character.up);
    vec3.copy(_lin, character.linearVelocity);
    const verticalSpeed = vec3.dot(_lin, _up);
    vec3.scale(_vertical, _up, verticalSpeed);
    vec3.sub(_horizontal, _lin, _vertical);

    // Grounded only if we're also settling toward the floor (not launching off it).
    const groundVerticalSpeed = vec3.dot(character.ground.velocity, _up);
    const movingTowardsGround = verticalSpeed - groundVerticalSpeed < 0.1;
    const onGround = character.ground.state === kcc.GroundState.ON_GROUND && movingTowardsGround;
    const willJump = onGround && jump;

    // --- Horizontal: friction (ground, unless jumping) + directional accel ---
    if (onGround) {
        if (!willJump) applyFriction(_horizontal, dt);
        const groundSpeed = sprint ? MAX_SPEED * SPRINT_MULTIPLIER : MAX_SPEED;
        accelerate(_horizontal, moveDir, groundSpeed, GROUND_ACCEL, dt);
    } else {
        // Capped wish-speed in the air is what makes air-strafing gain speed.
        accelerate(_horizontal, moveDir, Math.min(MAX_SPEED, AIR_SPEED_CAP), AIR_ACCEL, dt);
    }

    // --- Vertical: ground stick / jump, then gravity ---
    let newVerticalSpeed = onGround ? groundVerticalSpeed : verticalSpeed;
    if (willJump) newVerticalSpeed += JUMP_SPEED;
    newVerticalSpeed += vec3.dot(GRAVITY, _up) * dt;

    // Recombine horizontal + vertical and hand the velocity to the controller.
    vec3.scale(_vertical, _up, newVerticalSpeed);
    vec3.add(_newVel, _horizontal, _vertical);
    vec3.copy(character.linearVelocity, _newVel);

    // Stair step-up, plus floor-stick — but not on the jump frame, or we'd snap
    // straight back down and never leave the ground.
    vec3.scale(c.updateSettings.walkStairsStepUp, character.up, 0.4);
    if (willJump) vec3.zero(c.updateSettings.stickToFloorStepDown);
    else vec3.scale(c.updateSettings.stickToFloorStepDown, character.up, -0.5);

    kcc.update(physics.world, character, dt, GRAVITY, c.updateSettings, c.listener, c.filter);
}
