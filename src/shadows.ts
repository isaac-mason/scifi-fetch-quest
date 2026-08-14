import * as THREE from 'three';

import { KEY_LIGHT_INTENSITY } from './scene';

// Sun shadows for the crowd. Gaussian splats can't cast or receive shadows (Spark renders them
// outside the standard material pipeline), so this works around it with a classic shadow-map trick:
//   - the directional sun casts; the crew + cats (character-visuals.ts / cats.ts) are the casters,
//   - the COLLISION MESH — which lines up exactly with the world — is reused as an invisible
//     ShadowMaterial receiver, so the shadows appear to land on the splat floor AND conform to the
//     real terrain shape (slopes, steps), not a flat plane.
// The orthographic shadow frustum follows the player each frame (updateShadows) so a modest map
// stays high-res around the action rather than covering the whole ship at once.
//
// Caveat: only the casters are in the shadow pass (not the collider), so a shadow can bleed through
// a wall onto floor beyond it (shadow maps don't self-occlude). If that reads badly, make the
// collider cast too (castShadow=true in attachShadowCatcher) so walls block the sun.

const SHADOW_MAP_SIZE = 2048;
const SHADOW_HALF_EXTENT = 12; // world metres the shadow frustum spans around the player
const SUN_OFFSET = new THREE.Vector3(8, 20, 8); // sun position relative to the followed point

// Catcher tuning. depthWrite:false so it doesn't punch holes in the splats drawn behind it; the
// render order puts it in the transparent pass AFTER the splats, while depthTest still lets the
// characters occlude it.
const SHADOW_CATCHER_OPACITY = 0.32;
const SHADOW_CATCHER_RENDER_ORDER = 1000;

export type Shadows = {
    /** The shadow-casting key light; also the scene's main directional light. */
    sun: THREE.DirectionalLight;
};

// Enable shadow mapping + create the shadow-casting sun. The catcher is attached later
// (attachShadowCatcher) once the collider has loaded.
export function initShadows(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Shadows {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const sun = new THREE.DirectionalLight(0xfff0dc, KEY_LIGHT_INTENSITY);
    sun.position.copy(SUN_OFFSET); // overwritten each frame by updateShadows
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.bias = -0.0005; // pull shadows back to kill acne on near-flat floor
    sun.shadow.normalBias = 0.02;

    const cam = sun.shadow.camera; // OrthographicCamera
    cam.near = 1;
    cam.far = SUN_OFFSET.length() + SHADOW_HALF_EXTENT * 2; // reach from the light down past the floor
    cam.left = cam.bottom = -SHADOW_HALF_EXTENT;
    cam.right = cam.top = SHADOW_HALF_EXTENT;
    cam.updateProjectionMatrix();

    scene.add(sun);
    scene.add(sun.target); // a directional light aims at its target; we follow the player

    return { sun };
}

// Build the collider geometry into an invisible ShadowMaterial receiver and add it to the scene, so
// shadows land on the real world surface (conforming to slopes/steps). Call once the collider loads.
export function attachShadowCatcher(scene: THREE.Scene, positions: Float32Array, indices: Uint32Array): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals(); // for the receiver's normalBias offset

    const mat = new THREE.ShadowMaterial({ opacity: SHADOW_CATCHER_OPACITY });
    mat.depthWrite = false; // overlay only — don't punch holes in the splats

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = SHADOW_CATCHER_RENDER_ORDER;
    mesh.frustumCulled = false;
    scene.add(mesh);
}

// Enable/disable sun shadows at runtime (debug panel "shadows" toggle). Turning the sun's
// castShadow off changes the scene's shadow-light count, which three detects and recompiles the
// affected materials for on the next render — so the cast shadows fully vanish (not just freeze)
// and come back cleanly. Also flips renderer.shadowMap.enabled so the shadow pass is skipped
// entirely while off. Safe to call every frame — a no-op when the value is unchanged.
export function setShadowsEnabled(shadows: Shadows, renderer: THREE.WebGLRenderer, enabled: boolean): void {
    renderer.shadowMap.enabled = enabled;
    shadows.sun.castShadow = enabled;
}

// Re-centre the sun (and thus its shadow frustum) on the player each frame, keeping the map tight
// and high-res near the action while the light DIRECTION stays fixed (shadows always fall the same
// way). `y` should be the grounded feet Y so the frustum doesn't ride up on a jump.
export function updateShadows(shadows: Shadows, x: number, y: number, z: number): void {
    shadows.sun.position.set(x + SUN_OFFSET.x, y + SUN_OFFSET.y, z + SUN_OFFSET.z);
    shadows.sun.target.position.set(x, y, z);
    shadows.sun.target.updateMatrixWorld();
}
