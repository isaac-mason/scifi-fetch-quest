import {
    type BodyId,
    CastRayStatus,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    type Filter,
    filter,
} from 'crashcat';
import * as THREE from 'three';

import type { Physics } from './physics';

// Reused across frames — a single closest-hit ray cast forward from the camera.
const collector = createClosestCastRayCollector();
const settings = createDefaultCastRaySettings();
const _origin: [number, number, number] = [0, 0, 0];
const _direction: [number, number, number] = [0, 0, 0];
const _forward = new THREE.Vector3();

// Built lazily (needs the world's layers). All layers enabled — walls occlude, so the
// CLOSEST hit is what matters — minus the player's own body so we don't self-interact.
let viewFilter: Filter | null = null;

/**
 * Cast a ray straight out of the camera and return the id of the closest rigid body it hits
 * (or null if it hits nothing within `maxDistance`). Walls occlude, so this is genuine line of
 * sight. The caller resolves the body to a character (physics.bodyToCharacter) or an
 * interactable (physics.bodyToInteractable).
 */
export function castViewRay(physics: Physics, camera: THREE.Camera, maxDistance: number): BodyId | null {
    if (!viewFilter) {
        viewFilter = filter.forWorld(physics.world);
        viewFilter.bodyFilter = (body) => body.id !== physics.playerBodyId;
    }

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
