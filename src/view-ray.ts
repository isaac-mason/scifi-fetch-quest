import {
    type BodyId,
    CastRayStatus,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    filter,
} from 'crashcat';
import * as THREE from 'three';
import { type Physics, worldSettings } from './physics';

const collector = createClosestCastRayCollector();
const settings = createDefaultCastRaySettings();

const _origin: [number, number, number] = [0, 0, 0];
const _direction: [number, number, number] = [0, 0, 0];
const _forward = new THREE.Vector3();

// All layers enabled (walls occlude, so the closest hit is what matters), minus the player's own
// body so we don't self-interact.
const viewFilter = filter.create(worldSettings.layers);

/**
 * Cast a ray out of the camera and return the closest rigid body it hits (or null within
 * `maxDistance`). Walls occlude, so this is genuine line of sight. The caller resolves the body
 * to a character (physics.bodyToCharacter).
 */
export function castViewRay(physics: Physics, camera: THREE.Camera, maxDistance: number): BodyId | null {
    viewFilter.bodyFilter = (body) => body.id !== physics.playerBodyId;

    camera.getWorldDirection(_forward);

    _origin[0] = camera.position.x;
    _origin[1] = camera.position.y;
    _origin[2] = camera.position.z;
    _direction[0] = _forward.x;
    _direction[1] = _forward.y;
    _direction[2] = _forward.z;

    collector.reset();
    castRay(physics.world, collector, settings, _origin, _direction, maxDistance, viewFilter);
    if (collector.hit.status !== CastRayStatus.COLLIDING) return null;

    return collector.hit.bodyIdB;
}
