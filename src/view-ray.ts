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

const _direction: [number, number, number] = [0, 0, 0];
const _directionThree = new THREE.Vector3();
const _origin: [number, number, number] = [0, 0, 0];

const viewFilter = filter.create(worldSettings.layers);

export function castViewRay(physics: Physics, camera: THREE.Camera, maxDistance: number): BodyId | null {
    viewFilter.bodyFilter = (body) => body.id !== physics.playerBodyId;

    camera.getWorldDirection(_directionThree).toArray(_direction);
    camera.position.toArray(_origin);

    collector.reset();
    castRay(physics.world, collector, settings, _origin, _direction, maxDistance, viewFilter);
    if (collector.hit.status !== CastRayStatus.COLLIDING) return null;

    return collector.hit.bodyIdB;
}
