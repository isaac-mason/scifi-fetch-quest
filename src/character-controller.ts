import { capsule, type Filter, filter, type KCC, kcc, transformed } from 'crashcat';
import { quat, type Vec3, vec3, vec4 } from 'mathcat';
import type { Input } from './input';
import { OBJECT_LAYER_GHOST, OBJECT_LAYER_MOVING, type Physics } from './physics';
import { CHARACTER_SPAWN, GRAVITY } from './scene';

const CHARACTER_HEIGHT = 1.2;
const CHARACTER_RADIUS = 0.2;
const HALF_HEIGHT_OF_CYLINDER = CHARACTER_HEIGHT / 2 - CHARACTER_RADIUS;
const HEAD_CLEARANCE = 0.25;

export const EYE_HEIGHT = CHARACTER_HEIGHT - HEAD_CLEARANCE;

const MAX_SPEED = 3.5;
const SPRINT_MULTIPLIER = 1.6;
const JUMP_SPEED = 4.5;
const GROUND_ACCEL = 12;
const AIR_ACCEL = 12;
const AIR_SPEED_CAP = 1.0;
const FRICTION = 6;
const STOP_SPEED = 1.5;
const MAX_SLOPE_ANGLE = (50 * Math.PI) / 180;

export type Character = {
    kcc: KCC;
    filter: Filter;
    updateSettings: kcc.UpdateSettings;
    listener: kcc.CharacterListener;
    /** True only on frames the player is actively steering (has a wish-direction). Gates the
     *  contact-solve velocity-kill below, so we slide only on intentional input. */
    allowSliding: boolean;
};

export function initCharacter(physics: Physics): Character {
    // Offset the shape so the capsule sits above the character position (feet): its centre is
    // half the full height up.
    const shapeOffset = vec3.fromValues(0, CHARACTER_HEIGHT / 2, 0);
    const shape = transformed.create({
        shape: capsule.create({ halfHeightOfCylinder: HALF_HEIGHT_OF_CYLINDER, radius: CHARACTER_RADIUS }),
        position: shapeOffset,
        quaternion: quat.create(),
    });

    const character = kcc.create(
        {
            shape,
            // Inner kinematic body so raycasts/sensors can see the character. It doesn't drive
            // movement - the KCC's own sweeps do.
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

    // Drop the GHOST object layer from the player's filter so our sweeps ignore the crew/cat sensor
    // capsules (all on GHOST); otherwise they'd wedge us in a hallway. They stay hittable by the
    // interaction view ray (its own all-layers filter, see view-ray.ts). GHOST shares the MOVING
    // broadphase, so disabling it here leaves the broadphase and level collision intact.
    const playerFilter = filter.create(physics.world.settings.layers);
    filter.disableObjectLayer(playerFilter, physics.world.settings.layers, OBJECT_LAYER_GHOST);

    const c: Character = {
        kcc: character,
        filter: playerFilter,
        updateSettings,
        allowSliding: false,
        listener: {},
    };

    // When the player isn't steering, kill any velocity penetration recovery generates against a
    // resting, not-too-steep contact; otherwise the uneven collider leaves a residual velocity that
    // reads as jitter/drift while standing still. Mirrors the crashcat KCC example. Clamps only when
    // allowSliding is false, so intentional movement and steep-slope sliding are untouched.
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

const _up = vec3.create();
const _lin = vec3.create();
const _vertical = vec3.create();
const _horizontal = vec3.create();
const _newVel = vec3.create();

/** Quake-style ground friction: bleed off horizontal speed, with extra bite below STOP_SPEED for a
 *  clean stop. Operates in place on `vel`. */
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

/** Quake-style acceleration: only adds speed along `wishDir` up to `wishSpeed`. Clamps the projected
 *  speed (not total), so aiming across your velocity while airborne lets total speed climb - the
 *  air-strafe/bhop trick. Operates in place on `vel`. */
function accelerate(vel: Vec3, wishDir: Vec3, wishSpeed: number, accel: number, dt: number): void {
    const currentSpeed = vec3.dot(vel, wishDir);
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
    vec3.scaleAndAdd(vel, vel, wishDir, accelSpeed);
}

/** Advance the character one step, Quake-style. `moveDir` is a world-space horizontal wish-direction
 *  (y~0, any magnitude - normalized here); `input` supplies jump (hold to bunny-hop) + sprint intent.
 *  `moveDir` is derived from input + camera yaw by the caller, so this stays camera-agnostic. */
export function updateCharacterController(physics: Physics, character: Character, moveDir: Vec3, input: Input, dt: number): void {
    const { jump, sprint } = input;
    // moveDir carries the analog stick tilt. Split into a unit direction + a 0..1 speed scale so a
    // partial tilt walks slowly. Keyboard is always full-tilt (clamped to 1), so this is a no-op there.
    const moveLen = vec3.length(moveDir);
    const speedScale = Math.min(moveLen, 1);
    if (moveLen > 1e-6) vec3.scale(moveDir, moveDir, 1 / moveLen);
    else vec3.zero(moveDir);

    // Only permit contact sliding when actively steering (see onContactSolve in initCharacter);
    // a jump also counts as intent so we don't clamp the launch velocity.
    character.allowSliding = moveLen > 1e-6 || jump;

    // account for moving platforms under the character (vertical follow + ground vel).
    kcc.updateGroundVelocity(physics.world, character.kcc, character.listener);

    // split current velocity into vertical (along up) and horizontal components.
    vec3.copy(_up, character.kcc.up);
    vec3.copy(_lin, character.kcc.linearVelocity);
    const verticalSpeed = vec3.dot(_lin, _up);
    vec3.scale(_vertical, _up, verticalSpeed);
    vec3.sub(_horizontal, _lin, _vertical);

    // grounded only if we're also settling toward the floor (not launching off it).
    const groundVerticalSpeed = vec3.dot(character.kcc.ground.velocity, _up);
    const movingTowardsGround = verticalSpeed - groundVerticalSpeed < 0.1;
    const onGround = character.kcc.ground.state === kcc.GroundState.ON_GROUND && movingTowardsGround;
    const willJump = onGround && jump;

    // --- horizontal: friction (ground, unless jumping) + directional accel ---
    if (onGround) {
        if (!willJump) applyFriction(_horizontal, dt);
        const groundSpeed = (sprint ? MAX_SPEED * SPRINT_MULTIPLIER : MAX_SPEED) * speedScale;
        accelerate(_horizontal, moveDir, groundSpeed, GROUND_ACCEL, dt);
    } else {
        // capped wish-speed in the air is what makes air-strafing gain speed.
        accelerate(_horizontal, moveDir, Math.min(MAX_SPEED, AIR_SPEED_CAP), AIR_ACCEL, dt);
    }

    // --- vertical: ground stick / jump, then gravity ---
    let newVerticalSpeed = onGround ? groundVerticalSpeed : verticalSpeed;
    if (willJump) newVerticalSpeed += JUMP_SPEED;
    newVerticalSpeed += vec3.dot(GRAVITY, _up) * dt;

    // recombine horizontal + vertical and hand the velocity to the controller.
    vec3.scale(_vertical, _up, newVerticalSpeed);
    vec3.add(_newVel, _horizontal, _vertical);
    vec3.copy(character.kcc.linearVelocity, _newVel);

    // Stair step-up plus floor-stick - but not on the jump frame, or we'd snap straight back down.
    vec3.scale(character.updateSettings.walkStairsStepUp, character.kcc.up, 0.4);
    if (willJump) vec3.zero(character.updateSettings.stickToFloorStepDown);
    else vec3.scale(character.updateSettings.stickToFloorStepDown, character.kcc.up, -0.5);

    kcc.update(physics.world, character.kcc, dt, GRAVITY, character.updateSettings, character.listener, character.filter);
}
