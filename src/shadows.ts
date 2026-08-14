import type { Vec3 } from 'mathcat';
import * as THREE from 'three';

import { type Physics, raycastCollider } from './physics';
import { KEY_LIGHT_INTENSITY } from './scene';

// Sun shadows for the crowd. Splats can't cast/receive shadows, so a classic shadow-map trick:
// the directional sun casts, the crew + cats are the casters, and the collision mesh (aligned to
// the world) is reused as an invisible ShadowMaterial receiver - so shadows land on the splat
// floor and conform to the real terrain. The ortho frustum follows the player (updateShadows) to
// keep a modest map high-res around the action.
//
// Through-wall bleed (a phantom shadow of a hidden character) is cheaply approximated: each frame
// raycast camera->caster; if a wall blocks the view, ramp that caster's whole shadow out
// (updateShadowCasters). The catcher shader scales each fragment by the nearest caster's visibility.
// Coarse (per-character) but smooth and near-free - one ray per character.

const SHADOW_MAP_SIZE = 1024;
const SHADOW_HALF_EXTENT = 12; // world metres the shadow frustum spans around the player
const SUN_OFFSET = new THREE.Vector3(8, 20, 8); // sun position relative to the followed point

const SHADOW_OPACITY = 0.32;
const SHADOW_CATCHER_RENDER_ORDER = 1000; // after the splats, so the shadow lands on the splat floor
const MAX_SHADOW_CASTERS = 24; // crew + cats
const VIS_RAMP_RATE = 6; // per second - how fast a shadow fades in/out as the caster is seen/hidden
const VIS_RAY_HEIGHT = 0.5; // metres above the feet the visibility ray aims (chest height)

// Per-caster feet XZ + player-visibility (0 hidden .. 1 seen), fed by updateShadowCasters.
// Module-level shared uniforms so there's no per-material bookkeeping.
const casterUniforms = {
    uCasters: { value: Array.from({ length: MAX_SHADOW_CASTERS }, () => new THREE.Vector2()) },
    uCasterVis: { value: new Array<number>(MAX_SHADOW_CASTERS).fill(1) },
    uCasterCount: { value: 0 },
};
const visSmoothed = new Array<number>(MAX_SHADOW_CASTERS).fill(1); // eased visibility, persisted across frames

export type Shadows = {
    /** The shadow-casting key light; also the scene's main directional light. */
    sun: THREE.DirectionalLight;
};

// Enable shadow mapping + create the shadow-casting sun. Catcher attached later (attachShadowCatcher).
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

// Build the collider geometry into an invisible ShadowMaterial receiver so shadows land on the real
// world surface. Patched to fade each fragment by the nearest caster's visibility (see module header).
export function attachShadowCatcher(scene: THREE.Scene, positions: Float32Array, indices: Uint32Array): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals(); // for the receiver's normalBias offset

    // depthWrite:false so it doesn't punch holes in the splats; renderOrder puts it in the
    // transparent pass AFTER the splats, while depthTest still lets the characters occlude it.
    const mat = new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY });
    mat.depthWrite = false;
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uCasters = casterUniforms.uCasters;
        shader.uniforms.uCasterVis = casterUniforms.uCasterVis;
        shader.uniforms.uCasterCount = casterUniforms.uCasterCount;

        // Carry world position through so the fragment can find its nearest caster.
        shader.vertexShader = `varying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
            'void main() {',
            'void main() {\n\tvWorldPos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;',
        );

        // Scale the shadow by the nearest caster's visibility so an occluded character's shadow fades.
        // Guarded on NUM_DIR_LIGHT_SHADOWS so it compiles out when shadows are toggled off.
        shader.fragmentShader = `
            varying vec3 vWorldPos;
            #define MAX_SHADOW_CASTERS ${MAX_SHADOW_CASTERS}
            uniform vec2 uCasters[ MAX_SHADOW_CASTERS ];
            uniform float uCasterVis[ MAX_SHADOW_CASTERS ];
            uniform int uCasterCount;
            ${shader.fragmentShader}`.replace(
            'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
            /* glsl */ `
                float shadow = 1.0 - getShadowMask();
                #if NUM_DIR_LIGHT_SHADOWS > 0
                    float vis = 1.0;
                    float best = 1.0e9;
                    for ( int i = 0; i < MAX_SHADOW_CASTERS; i++ ) {
                        if ( i >= uCasterCount ) break;
                        vec2 o = vWorldPos.xz - uCasters[ i ];
                        float dd = dot( o, o );
                        if ( dd < best ) { best = dd; vis = uCasterVis[ i ]; }
                    }
                    shadow *= vis;
                #endif
                gl_FragColor = vec4( color, opacity * shadow );`,
        );
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = SHADOW_CATCHER_RENDER_ORDER;
    mesh.frustumCulled = false;
    scene.add(mesh);
}

const _camPos: Vec3 = [0, 0, 0];
const _rayDir: Vec3 = [0, 0, 0];

// Feed caster feet positions + ramp visibility: raycast camera->caster, ease its shadow off when a
// wall blocks the view. Call each frame before the render, after the characters have moved.
export function updateShadowCasters(
    physics: Physics,
    camera: THREE.Camera,
    casters: readonly { position: Vec3 }[],
    dt: number,
): void {
    _camPos[0] = camera.position.x;
    _camPos[1] = camera.position.y;
    _camPos[2] = camera.position.z;
    const step = Math.min(1, VIS_RAMP_RATE * dt);

    const n = Math.min(casters.length, MAX_SHADOW_CASTERS);
    for (let i = 0; i < n; i++) {
        const p = casters[i].position;
        casterUniforms.uCasters.value[i].set(p[0], p[2]);

        // Ray from the camera to the caster's chest; a hit before it means a wall is in the way.
        _rayDir[0] = p[0] - _camPos[0];
        _rayDir[1] = p[1] + VIS_RAY_HEIGHT - _camPos[1];
        _rayDir[2] = p[2] - _camPos[2];
        const dist = Math.hypot(_rayDir[0], _rayDir[1], _rayDir[2]) || 1;
        _rayDir[0] /= dist;
        _rayDir[1] /= dist;
        _rayDir[2] /= dist;
        const hit = raycastCollider(physics, _camPos, _rayDir, dist);
        const target = hit < dist - 0.1 ? 0 : 1; // occluded -> fade out

        visSmoothed[i] += (target - visSmoothed[i]) * step;
        casterUniforms.uCasterVis.value[i] = visSmoothed[i];
    }
    casterUniforms.uCasterCount.value = n;
}

// Enable/disable sun shadows at runtime. Toggling castShadow changes the shadow-light count, so
// three recompiles the affected materials next render - shadows fully vanish and come back cleanly.
// Also flips shadowMap.enabled to skip the shadow pass while off. Safe to call every frame.
export function setShadowsEnabled(shadows: Shadows, renderer: THREE.WebGLRenderer, enabled: boolean): void {
    renderer.shadowMap.enabled = enabled;
    shadows.sun.castShadow = enabled;
}

// Re-centre the sun (and its shadow frustum) on the player each frame while the light direction
// stays fixed. `y` should be the grounded feet Y so the frustum doesn't ride up on a jump.
export function updateShadows(shadows: Shadows, x: number, y: number, z: number): void {
    shadows.sun.position.set(x + SUN_OFFSET.x, y + SUN_OFFSET.y, z + SUN_OFFSET.z);
    shadows.sun.target.position.set(x, y, z);
    shadows.sun.target.updateMatrixWorld();
}
