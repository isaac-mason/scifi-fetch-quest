import * as THREE from 'three';
import { LightProbeHelper } from 'three/addons/helpers/LightProbeHelper.js';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';

// light-probes.ts - a self-contained irradiance-probe VOLUME for three.js (+ Spark).
//
// One file, drop it in anywhere. Bake an order-2 SH probe per cell of a dense grid, pack the
// coefficients into a 3D-texture atlas, and sample it per-fragment at runtime so meshes pick
// up local, position-varying scene colour - varying across each surface, not one tint per mesh.
//
// Both halves of the texture-format contract live here, side by side: packProbeAtlas writes
// the atlas and the vendored GLSL (getProbeVolumeIrradiance) reads it back, so they can't
// drift. unpackProbeGrid is the exact inverse (used by the debug gizmos) and doubles as a
// roundtrip canary. We depend on neither three's LightProbeGrid addon nor its core shader.
//
// I/O stays OUT of this module: serializeProbeGridFile -> string and deserializeProbeGridFile <-
// string are pure; the CALLER does the fetch (runtime) and the file write (bake). No Node APIs
// - browser only (canvas/gl for capture, btoa/atob for the atlas). Tree-shakeable, so an app
// that only imports the RUNTIME bits drops the whole BAKE section it never calls.
//
// Sections:  FORMAT (shared) , RUNTIME (volume material) , DEBUG (gizmos) , BAKE (offline)

// ============================================================================
// FORMAT - pack / unpack / (de)serialize. Shared by BAKE (writes) + RUNTIME (reads).
// ============================================================================
//
// Atlas layout (packProbeAtlas and the GLSL unpack in the RUNTIME section MUST agree):
//   - 9 order-2 SH coefficients (vec3 each) are packed across 7 RGBA sub-volumes.
//   - The sub-volumes are stacked along Z into ONE Data3DTexture. Each occupies (nz + 2)
//     slices: 1 padding slice at each end (a copy of the nearest edge data slice) so the
//     hardware trilinear filter doesn't bleed across a sub-volume boundary.
//   - Total atlas depth = 7 * (nz + 2). For sub-volume t the first DATA slice sits at
//     atlas slice t*(nz+2) + 1.

const PADDING = 1; // padding slices at each end of every sub-volume (matches the GLSL unpack)
const SUBVOLUMES = 7; // 7 RGBA textures hold the 9 vec3 SH coefficients (28 of 36 lanes used)

// The 4 lanes each RGBA sub-volume `t` carries, as [coeffIndex, component] pairs
// (component 0=x/r, 1=y/g, 2=z/b). Mirrors the GLSL unpack (c1 = vec3(s0.w, s1.xy), etc.) so
// this stays the single source of truth for the format. A null lane is written as 0 (only the
// last lane of sub-volume 6 is unused).
type Lane = [number, number] | null;
const SUBVOLUME_LANES: Lane[][] = [
    [
        [0, 0],
        [0, 1],
        [0, 2],
        [1, 0],
    ], // t0: c0.rgb, c1.r
    [
        [1, 1],
        [1, 2],
        [2, 0],
        [2, 1],
    ], // t1: c1.gb, c2.rg
    [
        [2, 2],
        [3, 0],
        [3, 1],
        [3, 2],
    ], // t2: c2.b,  c3.rgb
    [
        [4, 0],
        [4, 1],
        [4, 2],
        [5, 0],
    ], // t3: c4.rgb, c5.r
    [
        [5, 1],
        [5, 2],
        [6, 0],
        [6, 1],
    ], // t4: c5.gb, c6.rg
    [
        [6, 2],
        [7, 0],
        [7, 1],
        [7, 2],
    ], // t5: c6.b,  c7.rgb
    [[8, 0], [8, 1], [8, 2], null], //   t6: c8.rgb, (unused)
];

export type ProbeAtlas = {
    data: Float32Array; // length nx*ny*(7*(nz+2))*4, RGBA float
    nx: number;
    ny: number;
    nz: number;
};

// Read one lane's scalar out of an SH probe (or 0 for the unused lane).
function laneValue(sh: THREE.SphericalHarmonics3, lane: Lane): number {
    if (lane === null) return 0;
    const c = sh.coefficients[lane[0]];
    return lane[1] === 0 ? c.x : lane[1] === 1 ? c.y : c.z;
}

// Pack a dense grid of SH probes (cell-ordered: idx = ix + iy*nx + iz*nx*ny) into the
// padded 3D atlas. `sh.length` must equal nx*ny*nz.
export function packProbeAtlas(sh: THREE.SphericalHarmonics3[], nx: number, ny: number, nz: number): ProbeAtlas {
    if (sh.length !== nx * ny * nz) {
        throw new Error(`packProbeAtlas: got ${sh.length} probes, expected ${nx * ny * nz} (${nx}x${ny}x${nz})`);
    }
    const paddedSlices = nz + 2 * PADDING;
    const atlasDepth = SUBVOLUMES * paddedSlices;
    const data = new Float32Array(nx * ny * atlasDepth * 4);

    // Index of the first float of texel (ix,iy) on atlas slice `slice`.
    const texel = (ix: number, iy: number, slice: number) => ((slice * ny + iy) * nx + ix) * 4;

    for (let t = 0; t < SUBVOLUMES; t++) {
        const lanes = SUBVOLUME_LANES[t];
        const base = t * paddedSlices;
        // Data slices.
        for (let iz = 0; iz < nz; iz++) {
            const slice = base + PADDING + iz;
            for (let iy = 0; iy < ny; iy++) {
                for (let ix = 0; ix < nx; ix++) {
                    const probe = sh[ix + iy * nx + iz * nx * ny];
                    const o = texel(ix, iy, slice);
                    data[o] = laneValue(probe, lanes[0]);
                    data[o + 1] = laneValue(probe, lanes[1]);
                    data[o + 2] = laneValue(probe, lanes[2]);
                    data[o + 3] = laneValue(probe, lanes[3]);
                }
            }
        }
        // Padding slices: copy the nearest edge data slice (iz 0 and iz nz-1) so the
        // trilinear filter reads a flat value at the boundary instead of bleeding.
        copySlice(data, texel, nx, ny, base + PADDING + 0, base); // leading  = copy of iz 0
        copySlice(data, texel, nx, ny, base + PADDING + (nz - 1), base + PADDING + nz); // trailing = copy of iz nz-1
    }

    return { data, nx, ny, nz };
}

function copySlice(
    data: Float32Array,
    texel: (ix: number, iy: number, slice: number) => number,
    nx: number,
    ny: number,
    srcSlice: number,
    dstSlice: number,
): void {
    for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
            const s = texel(ix, iy, srcSlice);
            const d = texel(ix, iy, dstSlice);
            data[d] = data[s];
            data[d + 1] = data[s + 1];
            data[d + 2] = data[s + 2];
            data[d + 3] = data[s + 3];
        }
    }
}

// Wrap a packed atlas in a Data3DTexture bound as the `probesSH` sampler3D uniform by
// createProbeVolumeMaterial. FloatType + LinearFilter gives hardware trilinear interpolation
// between probes; linear filtering of a float 3D texture needs OES_texture_float_linear
// (standard on desktop WebGL2).
export function buildProbeAtlasTexture(atlas: ProbeAtlas): THREE.Data3DTexture {
    const paddedSlices = atlas.nz + 2 * PADDING;
    const depth = SUBVOLUMES * paddedSlices;
    const tex = new THREE.Data3DTexture(atlas.data, atlas.nx, atlas.ny, depth);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

// The world-space position of grid cell (ix,iy,iz), matching where the bake captured it
// and how the volume shader maps world position -> texel (min -> max spans res-1 steps).
export function cellPosition(
    box: THREE.Box3,
    res: THREE.Vector3,
    ix: number,
    iy: number,
    iz: number,
    target: THREE.Vector3,
): THREE.Vector3 {
    const t = (lo: number, hi: number, i: number, n: number) => (n > 1 ? lo + (i * (hi - lo)) / (n - 1) : lo);
    return target.set(t(box.min.x, box.max.x, ix, res.x), t(box.min.y, box.max.y, iy, res.y), t(box.min.z, box.max.z, iz, res.z));
}

// Inverse of packProbeAtlas: read the 9 SH coefficients for every DATA cell back out of a
// loaded atlas (padding slices skipped). Used by the debug gizmos to shade a sphere per
// cell - and, because it's the exact inverse, it doubles as a pack/unpack roundtrip check.
export function unpackProbeGrid(loaded: LoadedProbeGrid): { positions: THREE.Vector3[]; sh: THREE.SphericalHarmonics3[] } {
    const nx = loaded.resolution.x;
    const ny = loaded.resolution.y;
    const nz = loaded.resolution.z;
    const data = loaded.texture.image.data as Float32Array;
    const paddedSlices = nz + 2 * PADDING;
    const texel = (ix: number, iy: number, slice: number) => ((slice * ny + iy) * nx + ix) * 4;

    const positions: THREE.Vector3[] = [];
    const sh: THREE.SphericalHarmonics3[] = [];
    for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
                const probe = new THREE.SphericalHarmonics3();
                for (let t = 0; t < SUBVOLUMES; t++) {
                    const o = texel(ix, iy, t * paddedSlices + PADDING + iz);
                    const lanes = SUBVOLUME_LANES[t];
                    for (let l = 0; l < 4; l++) {
                        const lane = lanes[l];
                        if (lane === null) continue;
                        const c = probe.coefficients[lane[0]];
                        const v = data[o + l];
                        if (lane[1] === 0) c.x = v;
                        else if (lane[1] === 1) c.y = v;
                        else c.z = v;
                    }
                }
                sh.push(probe);
                positions.push(cellPosition(loaded.boundingBox, loaded.resolution, ix, iy, iz, new THREE.Vector3()));
            }
        }
    }
    return { positions, sh };
}

// The committed artifact: header (grid geometry + bake metadata + debris seed points) plus the
// base64-encoded float atlas. One JSON file - bake once, commit, load at runtime. The fetch /
// file write is the CALLER's job; these two functions are pure string <-> data.
export type ProbeGridFile = {
    version: 2;
    resolution: [number, number, number]; // nx, ny, nz
    boundingBox: { min: [number, number, number]; max: [number, number, number] };
    intensity: number; // baked into the atlas SH; recorded for reference/rebake
    saturation: number; // baked into the atlas SH; recorded for reference/rebake
    seedPositions: [number, number, number][]; // open spots near geometry, for debris scatter
    atlas: string; // base64 of the Float32Array
};

export type LoadedProbeGrid = {
    texture: THREE.Data3DTexture;
    boundingBox: THREE.Box3;
    resolution: THREE.Vector3;
    seedPositions: THREE.Vector3[];
};

function floatsToBase64(data: Float32Array): string {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let binary = '';
    const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToFloats(b64: string): Float32Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
}

export function serializeProbeGridFile(
    atlas: ProbeAtlas,
    box: THREE.Box3,
    meta: { intensity: number; saturation: number; seedPositions: THREE.Vector3[] },
): string {
    const file: ProbeGridFile = {
        version: 2,
        resolution: [atlas.nx, atlas.ny, atlas.nz],
        boundingBox: { min: box.min.toArray() as [number, number, number], max: box.max.toArray() as [number, number, number] },
        intensity: meta.intensity,
        saturation: meta.saturation,
        seedPositions: meta.seedPositions.map((p) => p.toArray() as [number, number, number]),
        atlas: floatsToBase64(atlas.data),
    };
    return JSON.stringify(file);
}

export function deserializeProbeGridFile(text: string): LoadedProbeGrid {
    const file = JSON.parse(text) as ProbeGridFile;
    const [nx, ny, nz] = file.resolution;
    const atlas: ProbeAtlas = { data: base64ToFloats(file.atlas), nx, ny, nz };
    return {
        texture: buildProbeAtlasTexture(atlas),
        boundingBox: new THREE.Box3(
            new THREE.Vector3().fromArray(file.boundingBox.min),
            new THREE.Vector3().fromArray(file.boundingBox.max),
        ),
        resolution: new THREE.Vector3(nx, ny, nz),
        seedPositions: file.seedPositions.map((p) => new THREE.Vector3().fromArray(p)),
    };
}

// ============================================================================
// RUNTIME - the probe-volume material (self-contained shader, no three grid feature).
// ============================================================================
//
// We inject our own copy of the SH sampling shader via onBeforeCompile rather than depend on
// three core's USE_LIGHT_PROBES_GRID path, so the CONSUMER of the format sits right next to
// packProbeAtlas above. The GLSL is vendored (adapted) from three r185's
// src/renderers/shaders/ShaderChunk/lightprobes_pars_fragment.glsl.js - keep it in lockstep
// with SUBVOLUME_LANES; unpackProbeGrid's roundtrip is the canary.

// Shared across every volume material: one atlas texture + one box, uploaded once. Each
// material's onBeforeCompile points its uniforms at these same objects, so setProbeVolume
// updates them all at once with no per-material bookkeeping.
const uniforms = {
    probesSH: { value: null as THREE.Data3DTexture | null },
    probesMin: { value: new THREE.Vector3() },
    probesMax: { value: new THREE.Vector3() },
    probesResolution: { value: new THREE.Vector3() },
    // Runtime brightness multiply on the sampled irradiance, ON TOP OF the intensity already
    // baked into the atlas SH at bake time. 1 = the baked look; raise/lower to retune live
    // without a re-bake. Shared across every volume material, so setProbeVolumeIntensity moves
    // them all at once. (For a permanent change, fold it into PROBE_INTENSITY and re-bake.)
    probesIntensity: { value: 1 },
};

let volumeReady = false;

// Point the shared uniforms at a loaded grid. Call before creating volume materials so the
// sampler3D is bound by first compile.
export function setProbeVolume(loaded: LoadedProbeGrid): void {
    uniforms.probesSH.value = loaded.texture;
    uniforms.probesMin.value.copy(loaded.boundingBox.min);
    uniforms.probesMax.value.copy(loaded.boundingBox.max);
    uniforms.probesResolution.value.copy(loaded.resolution);
    volumeReady = true;
}

export function isProbeVolumeReady(): boolean {
    return volumeReady;
}

// Live brightness multiply on the volume irradiance (default 1 = the baked intensity). Applied
// on top of the atlas's baked-in PROBE_INTENSITY, so this retunes companion lighting without a
// re-bake. Affects every volume material at once (shared uniform).
export function setProbeVolumeIntensity(intensity: number): void {
    uniforms.probesIntensity.value = intensity;
}

// Declarations + the vendored sampler. Injected after <lights_pars_begin>. Requires WebGL2
// (sampler3D / texture(vec3) is GLSL ES 3.0, which every MeshStandardMaterial compiles to
// under three's WebGL2 renderer).
const PARS_GLSL = /* glsl */ `
uniform highp sampler3D probesSH;
uniform vec3 probesMin;
uniform vec3 probesMax;
uniform vec3 probesResolution;
uniform float probesIntensity;

// Sample the packed 3D SH atlas at a world position and evaluate L2 irradiance along
// worldNormal. The 9 vec3 coefficients are packed across 7 RGBA sub-volumes stacked on Z,
// each padded by 1 slice at both ends (see packProbeAtlas above).
vec3 getProbeVolumeIrradiance( vec3 worldPos, vec3 worldNormal ) {

    vec3 res = probesResolution;
    vec3 gridRange = probesMax - probesMin;
    vec3 resMinusOne = res - 1.0;
    vec3 probeSpacing = gridRange / resMinusOne;

    // Offset the sample along the normal by half a probe spacing (matches three).
    vec3 samplePos = worldPos + worldNormal * probeSpacing * 0.5;
    vec3 uvw = clamp( ( samplePos - probesMin ) / gridRange, 0.0, 1.0 );

    // Remap to texel centres of the probe grid.
    uvw = uvw * resMinusOne / res + 0.5 / res;

    float nz           = res.z;
    float paddedSlices = nz + 2.0;
    float atlasDepth   = 7.0 * paddedSlices;
    float uvZBase      = uvw.z * nz + 1.0;

    vec4 s0 = texture( probesSH, vec3( uvw.xy, ( uvZBase                     ) / atlasDepth ) );
    vec4 s1 = texture( probesSH, vec3( uvw.xy, ( uvZBase +       paddedSlices ) / atlasDepth ) );
    vec4 s2 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 2.0 * paddedSlices ) / atlasDepth ) );
    vec4 s3 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 3.0 * paddedSlices ) / atlasDepth ) );
    vec4 s4 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 4.0 * paddedSlices ) / atlasDepth ) );
    vec4 s5 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 5.0 * paddedSlices ) / atlasDepth ) );
    vec4 s6 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 6.0 * paddedSlices ) / atlasDepth ) );

    // Unpack 9 vec3 SH coefficients (must mirror packProbeAtlas's SUBVOLUME_LANES).
    vec3 c0 = s0.xyz;
    vec3 c1 = vec3( s0.w, s1.xy );
    vec3 c2 = vec3( s1.zw, s2.x );
    vec3 c3 = s2.yzw;
    vec3 c4 = s3.xyz;
    vec3 c5 = vec3( s3.w, s4.xy );
    vec3 c6 = vec3( s4.zw, s5.x );
    vec3 c7 = s5.yzw;
    vec3 c8 = s6.xyz;

    // Evaluate L2 irradiance.
    float x = worldNormal.x, y = worldNormal.y, z = worldNormal.z;

    vec3 result = c0 * 0.886227;
    result += c1 * 2.0 * 0.511664 * y;
    result += c2 * 2.0 * 0.511664 * z;
    result += c3 * 2.0 * 0.511664 * x;
    result += c4 * 2.0 * 0.429043 * x * y;
    result += c5 * 2.0 * 0.429043 * y * z;
    result += c6 * ( 0.743125 * z * z - 0.247708 );
    result += c7 * 2.0 * 0.429043 * x * z;
    result += c8 * 0.429043 * ( x * x - y * y );

    return max( result, vec3( 0.0 ) );

}
`;

// Injected after <lights_fragment_begin>, where three has just defined geometryPosition
// (= -vViewPosition, view space) and geometryNormal (view space). We reconstruct the
// world-space position/normal (inverse-view; the normal transform is transformNormalBy-
// InverseViewMatrix inlined so we don't lean on a core helper) and add the volume's
// irradiance exactly where three adds a global light probe's.
const IRRADIANCE_ADD = /* glsl */ `
{
    vec3 probeWorldPos = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
    vec3 probeWorldNormal = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
    irradiance += getProbeVolumeIrradiance( probeWorldPos, probeWorldNormal ) * probesIntensity;
}
`;

// Inject the probe-volume sampling into an EXISTING MeshStandardMaterial (e.g. a textured,
// skinned character material) so it picks up the volume's irradiance exactly like a fresh
// white box does — the volume adds on top of whatever fill lights the material already sees.
// All injected sources are identical, so instances that share defines also share one compiled
// program; only the uniform VALUES differ, and those are the shared module-level ones anyway.
export function applyProbeVolume(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.probesSH = uniforms.probesSH;
        shader.uniforms.probesMin = uniforms.probesMin;
        shader.uniforms.probesMax = uniforms.probesMax;
        shader.uniforms.probesResolution = uniforms.probesResolution;
        shader.uniforms.probesIntensity = uniforms.probesIntensity;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>\n${PARS_GLSL}`)
            .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n${IRRADIANCE_ADD}`);
    };
}

// A white MeshStandardMaterial that samples the shared probe volume — the debris/box case.
export function createProbeVolumeMaterial(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.0 });
    applyProbeVolume(material);
    return material;
}

// ============================================================================
// DEBUG - one shaded sphere per cell (imports the LightProbeHelper addon).
// ============================================================================

const GIZMO_SIZE = 0.06; // radius (m) of each probe helper sphere

// Visualize a baked probe VOLUME: one THREE.LightProbeHelper per grid cell - a small sphere
// shaded by that cell's actual SH (unpacked straight from the atlas we ship, so what you see
// is exactly what the volume shader samples). Warm near the boiler, cool/dark in the corners;
// a pure-black sphere means that cell captured nothing (buried in geometry or a truly unlit
// spot). The backing LightProbes are NOT added to the scene, so they light nothing - the
// helpers only draw them. Toggled by the debug panel's "light probes" box.
export function buildProbeGizmos(loaded: LoadedProbeGrid): THREE.Group {
    const group = new THREE.Group();
    const { positions, sh } = unpackProbeGrid(loaded);
    for (let i = 0; i < positions.length; i++) {
        const probe = new THREE.LightProbe(); // detached (not added to scene -> lights nothing)
        probe.sh.copy(sh[i]);
        probe.position.copy(positions[i]);
        group.add(new LightProbeHelper(probe, GIZMO_SIZE));
    }
    return group;
}

// ============================================================================
// BAKE - offline capture + probe placement. Runs only on the bake page; the app
// bundle tree-shakes this whole section away (nothing below is imported at runtime).
// ============================================================================

export type BakeOptions = {
    resolution?: number; // per-face render size (px); 128 is plenty for order-2 SH
    near?: number;
    far?: number;
    saturation?: number; // chroma boost to bake into every probe (1 = raw); see saturateSphericalHarmonics
    flipY?: boolean; // flip captured faces vertically (GL readback is bottom-up)
    settleFrames?: number; // frames waited per face for Spark's sort/instances to catch up (default 2)
    onProgress?: (done: number, total: number) => void;
};

// Wrap six raw RGBA face buffers as a CubeTexture of canvases, which is what
// LightProbeGenerator.fromCubeTexture consumes (it drawImage()s each face).
function facesToCubeTexture(faces: Uint8Array[], size: number, flipY: boolean): THREE.CubeTexture {
    const row = size * 4;
    const images = faces.map((buf) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return canvas;
        const img = ctx.createImageData(size, size);
        if (flipY) {
            for (let y = 0; y < size; y++) img.data.set(buf.subarray((size - 1 - y) * row, (size - y) * row), y * row);
        } else {
            img.data.set(buf);
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    });
    const tex = new THREE.CubeTexture(images as unknown as HTMLImageElement[]);
    tex.needsUpdate = true;
    return tex;
}

// The six cube-map faces, in three's CubeTexture order (px, nx, py, ny, pz, nz):
// look direction + camera up, matching three's CubeCamera so fromCubeTexture reads
// them in the right orientation.
const CUBE_FACES: { look: [number, number, number]; up: [number, number, number] }[] = [
    { look: [1, 0, 0], up: [0, -1, 0] }, // +X
    { look: [-1, 0, 0], up: [0, -1, 0] }, // -X
    { look: [0, 1, 0], up: [0, 0, 1] }, // +Y
    { look: [0, -1, 0], up: [0, 0, -1] }, // -Y
    { look: [0, 0, 1], up: [0, -1, 0] }, // +Z
    { look: [0, 0, -1], up: [0, -1, 0] }, // -Z
];

// Yield to the event loop for one animation frame. Spark prepares splat instances
// and runs its depth sort in a worker whose result lands on a LATER tick - so we
// MUST let real frames pass between renders, or nothing is drawn yet and the readback
// comes back black. (A tight synchronous render loop never lets that work complete.)
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

// Capture the six cube faces at `center` by rendering each as its own 90 deg view to the CANVAS
// (renderer.render with target=null) - the ONLY path that reliably makes Spark draw all six
// faces. spark.renderCubeMap renders into an offscreen cube target and comes back black / only
// partly filled here (its per-face render-target juggling clobbers Spark's compositing), so we
// stick with the canvas + gl.readPixels approach. `settleFrames` = frames waited after pointing
// the camera so Spark's worker sort/instances catch up before readback.
async function captureCubeFaces(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    center: THREE.Vector3,
    near: number,
    far: number,
    size: number,
    settleFrames: number,
): Promise<Uint8Array[]> {
    const gl = renderer.getContext();
    const cam = new THREE.PerspectiveCamera(90, 1, near, far);
    cam.updateProjectionMatrix();
    const target = new THREE.Vector3();
    const faces: Uint8Array[] = [];
    for (const f of CUBE_FACES) {
        cam.position.copy(center);
        cam.up.set(f.up[0], f.up[1], f.up[2]);
        target.set(center.x + f.look[0], center.y + f.look[1], center.z + f.look[2]);
        cam.lookAt(target);
        cam.updateMatrixWorld(true);
        renderer.setRenderTarget(null); // canvas
        // Render, then let real frames pass so Spark's worker sort + instance upload
        // for this viewpoint completes; render once more and read the finished frame.
        for (let s = 0; s < settleFrames; s++) {
            renderer.render(scene, cam);
            await nextFrame();
        }
        renderer.render(scene, cam);
        const buf = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf); // bottom-up (flipY handles it)
        faces.push(buf);
    }
    return faces;
}

// Capture an SH probe at each position: six per-face renders -> CubeTexture -> order-2 SH
// projection. Returns the coefficients in the SAME order as `positions` (the caller relies on
// that to pack the atlas). Assumes the splat is already fully resident (bake loads it nonLod).
export async function bakeProbeGrid(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    positions: THREE.Vector3[],
    opts: BakeOptions = {},
): Promise<THREE.SphericalHarmonics3[]> {
    const near = opts.near ?? 0.05;
    const far = opts.far ?? 100;
    const flipY = opts.flipY ?? true;
    const size = opts.resolution ?? 128;
    const saturation = opts.saturation ?? 1;
    const settleFrames = opts.settleFrames ?? 2;

    const sh: THREE.SphericalHarmonics3[] = [];
    for (let i = 0; i < positions.length; i++) {
        const faces = await captureCubeFaces(renderer, scene, positions[i], near, far, size, settleFrames);
        const cube = facesToCubeTexture(faces, size, flipY);
        const probeSh = LightProbeGenerator.fromCubeTexture(cube).sh;
        // Bake the chroma boost straight into the SH so the shipped atlas (and the debug
        // spheres) already carry it - the runtime then does no per-frame work.
        saturateSphericalHarmonics(probeSh, saturation);
        sh.push(probeSh);
        cube.dispose();
        opts.onProgress?.(i + 1, positions.length);
    }

    return sh;
}

// Capture the six faces at a point and return the flat RGBA buffers + their side length -
// used by the bake's diagnostic (a raw six-face env-capture strip).
export async function captureCubeFacesAt(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    pos: THREE.Vector3,
    size = 128,
    near = 0.05,
    far = 100,
    settleFrames = 2,
): Promise<{ faces: Uint8Array[]; size: number }> {
    const faces = await captureCubeFaces(renderer, scene, pos, near, far, size, settleFrames);
    return { faces, size };
}

// Rec.709 luma weights - a colour's perceived brightness, the axis saturation pivots around.
const LUMA = { x: 0.2126, y: 0.7152, z: 0.0722 };
const ZERO = new THREE.Vector3(0, 0, 0);

// Push an SH probe's colours away from grey. A diffuse irradiance probe integrates the whole
// hemisphere, so localized coloured light averages toward grey. Boosting saturation amplifies
// whatever chroma the probe *did* capture so it reads on the lit meshes. Exact on SH: the
// saturation map is linear in RGB, so applying it per-coefficient equals applying it to the
// final evaluated irradiance. saturation = 1 is a no-op; > 1 boosts. Baked into every probe
// offline (bakeProbeGrid), so the shipped atlas carries it and the runtime does no work.
export function saturateSphericalHarmonics(sh: THREE.SphericalHarmonics3, saturation: number): void {
    if (saturation === 1) return;
    const coeffs = sh.coefficients;
    for (const c of coeffs) {
        const lum = c.x * LUMA.x + c.y * LUMA.y + c.z * LUMA.z;
        c.x = lum + (c.x - lum) * saturation;
        c.y = lum + (c.y - lum) * saturation;
        c.z = lum + (c.z - lum) * saturation;
    }
    // Keep the average (DC) irradiance non-negative - a strong boost on a channel far
    // below the luminance could otherwise push it slightly negative (unphysical).
    coeffs[0].max(ZERO);
}

// A DENSE regular grid for the probe-volume texture: a fixed resolution per axis and positions
// emitted in the exact cell order packProbeAtlas expects (idx = ix + iy*nx + iz*nx*ny, ix
// fastest). Pins an integer resolution and returns the EFFECTIVE box (min -> min + (n-1)*spacing)
// so the runtime shader's probesMin/probesMax line up precisely with where we captured. No
// culling - every cell is baked (a volume can't ship holes; a void cell just captures dark),
// which is the point of moving to a volume.
export type DenseLattice = { positions: THREE.Vector3[]; nx: number; ny: number; nz: number; box: THREE.Box3 };

export function buildDenseLattice(min: THREE.Vector3, max: THREE.Vector3, spacing: number): DenseLattice {
    const axis = (lo: number, hi: number) => Math.max(2, Math.round((hi - lo) / spacing) + 1);
    const nx = axis(min.x, max.x);
    const ny = axis(min.y, max.y);
    const nz = axis(min.z, max.z);
    const effMax = new THREE.Vector3(min.x + (nx - 1) * spacing, min.y + (ny - 1) * spacing, min.z + (nz - 1) * spacing);
    const positions: THREE.Vector3[] = [];
    for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
                positions.push(new THREE.Vector3(min.x + ix * spacing, min.y + iy * spacing, min.z + iz * spacing));
            }
        }
    }
    return { positions, nx, ny, nz, box: new THREE.Box3(min.clone(), effMax) };
}

// A coarse cubic-voxel occupancy grid over the splat centers. Each cell stores how many splat
// centers fall in it, so we can answer "how far is the nearest splat to this point?"
// (nearestSplatDistance) without an O(probes x splats) brute scan. Built once at bake time from
// the flat [x,y,z, x,y,z, ...] center buffer.
export type SplatGrid = {
    cell: number;
    min: THREE.Vector3; // world position of voxel (0,0,0)'s min corner
    nx: number;
    ny: number;
    nz: number;
    counts: Uint32Array; // length nx*ny*nz, row-major (x outer, z inner)
};

// Bin `count` splat centers (flat xyz triples in `centers`) into a voxel grid spanning
// [min, max]. Centers outside the box are clamped to the edge voxels - we only use this
// for a coarse proximity test near the probe box, so out-of-box floaters don't matter.
export function buildSplatGrid(
    centers: Float32Array,
    count: number,
    min: THREE.Vector3,
    max: THREE.Vector3,
    cell: number,
): SplatGrid {
    const nx = Math.max(1, Math.ceil((max.x - min.x) / cell) + 1);
    const ny = Math.max(1, Math.ceil((max.y - min.y) / cell) + 1);
    const nz = Math.max(1, Math.ceil((max.z - min.z) / cell) + 1);
    const counts = new Uint32Array(nx * ny * nz);
    const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
    for (let i = 0; i < count; i++) {
        const gx = clamp(Math.floor((centers[i * 3] - min.x) / cell), nx - 1);
        const gy = clamp(Math.floor((centers[i * 3 + 1] - min.y) / cell), ny - 1);
        const gz = clamp(Math.floor((centers[i * 3 + 2] - min.z) / cell), nz - 1);
        counts[(gx * ny + gy) * nz + gz]++;
    }
    return { cell, min: min.clone(), nx, ny, nz, counts };
}

// Robust probe-box bounds from local splat OCCUPANCY rather than a per-axis percentile.
// Returns the box around every voxel of `grid` holding at least `minCount` splats. Unlike a
// percentile trim, this is per-VOXEL, so it can reject sparse floaters on every axis AND
// keep sparsely-sampled-but-real geometry on a lopsided axis at the same time - a single
// per-axis percentile knife can't do both (it over-includes floaters on the dense side while
// cutting real geometry on the sparse side). Pass a coarse full-extent grid (bounds need no
// detail). Falls back to the grid's full span if nothing clears the threshold.
export function occupancyBounds(grid: SplatGrid, minCount: number): THREE.Box3 {
    const { cell, min, nx, ny, nz, counts } = grid;
    const bmin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let gx = 0; gx < nx; gx++) {
        for (let gy = 0; gy < ny; gy++) {
            for (let gz = 0; gz < nz; gz++) {
                if (counts[(gx * ny + gy) * nz + gz] < minCount) continue;
                // Grow the box to this voxel's outer corners (min corner + one cell).
                bmin.min(_bv.set(min.x + gx * cell, min.y + gy * cell, min.z + gz * cell));
                bmax.max(_bv.addScalar(cell));
            }
        }
    }
    // Nothing cleared the threshold (minCount too high) - fall back to the grid's full span
    // so the bake still produces a grid instead of an empty box.
    if (bmin.x > bmax.x) {
        bmin.copy(min);
        bmax.set(min.x + nx * cell, min.y + ny * cell, min.z + nz * cell);
    }
    return new THREE.Box3(bmin, bmax);
}
const _bv = new THREE.Vector3(); // scratch for occupancyBounds

// Distance (m) from (x,y,z) to the nearest occupied voxel's center, searching voxel shells
// outward from the query point and stopping once no closer cell can exist. Quantized to ~cell
// resolution - enough for a keep/drop band decision. Returns Infinity if nothing is occupied
// within `maxDist`.
export function nearestSplatDistance(grid: SplatGrid, x: number, y: number, z: number, maxDist: number): number {
    const { cell, min, nx, ny, nz, counts } = grid;
    const gx = Math.floor((x - min.x) / cell);
    const gy = Math.floor((y - min.y) / cell);
    const gz = Math.floor((z - min.z) / cell);
    const maxR = Math.ceil(maxDist / cell) + 1;
    let best2 = Infinity;
    for (let r = 0; r <= maxR; r++) {
        // Every unsearched cell is at least (r-1)*cell away, so once that exceeds the
        // best distance found, no closer splat remains - stop expanding.
        if (best2 < Infinity && (r - 1) * cell > Math.sqrt(best2)) break;
        for (let dx = -r; dx <= r; dx++) {
            const cx = gx + dx;
            if (cx < 0 || cx >= nx) continue;
            const ax = Math.abs(dx);
            for (let dy = -r; dy <= r; dy++) {
                const cy = gy + dy;
                if (cy < 0 || cy >= ny) continue;
                const ay = Math.abs(dy);
                // Only visit the shell surface at Chebyshev radius r (cells already
                // covered by a smaller r were handled on an earlier iteration).
                const edgeXY = ax === r || ay === r;
                for (let dz = -r; dz <= r; dz++) {
                    if (!edgeXY && Math.abs(dz) !== r) continue;
                    const cz = gz + dz;
                    if (cz < 0 || cz >= nz) continue;
                    if (counts[(cx * ny + cy) * nz + cz] === 0) continue;
                    const px = min.x + (cx + 0.5) * cell;
                    const py = min.y + (cy + 0.5) * cell;
                    const pz = min.z + (cz + 0.5) * cell;
                    const d2 = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
                    if (d2 < best2) best2 = d2;
                }
            }
        }
    }
    return best2 === Infinity ? Infinity : Math.sqrt(best2);
}

// Fraction (0..1) of the voxels within `radius` of (x,y,z) that contain at least one splat - a
// NORMALIZED local density, independent of absolute splat counts and scene scale. This is the
// key difference from nearestSplatDistance: a lone floater within range barely moves it (1
// occupied voxel out of a few hundred), whereas a real surface nearby fills a whole slab of
// voxels and pushes it up. So it distinguishes "next to substantial geometry" (keep) from
// "next to a stray speck / in open void" (drop) - which a nearest-splat test cannot.
export function localSplatDensity(grid: SplatGrid, x: number, y: number, z: number, radius: number): number {
    const { cell, min, nx, ny, nz, counts } = grid;
    const gx = Math.floor((x - min.x) / cell);
    const gy = Math.floor((y - min.y) / cell);
    const gz = Math.floor((z - min.z) / cell);
    const rV = Math.ceil(radius / cell);
    const r2 = radius * radius;
    let total = 0;
    let occupied = 0;
    for (let dx = -rV; dx <= rV; dx++) {
        const cx = gx + dx;
        const wx = (dx + 0.5) * cell - (x - (min.x + gx * cell)); // probe->voxel-center x offset
        for (let dy = -rV; dy <= rV; dy++) {
            const cy = gy + dy;
            const wy = (dy + 0.5) * cell - (y - (min.y + gy * cell));
            for (let dz = -rV; dz <= rV; dz++) {
                const wz = (dz + 0.5) * cell - (z - (min.z + gz * cell));
                if (wx * wx + wy * wy + wz * wz > r2) continue; // sphere, not box
                const cz = gz + dz;
                total++;
                if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) continue;
                if (counts[(cx * ny + cy) * nz + cz] > 0) occupied++;
            }
        }
    }
    return total === 0 ? 0 : occupied / total;
}

export type SplatProximityFilter = {
    minClearance: number; // drop probes with nearest splat closer than this (jammed in a surface); 0 = off
    densityRadius: number; // radius (m) the local density is measured over
    minDensity: number; // drop probes whose local occupied-voxel fraction is below this
};

// Keep only lattice points that sit near real, substantial geometry: enough splat DENSITY
// nearby (not a sparse/floater region), and not jammed inside a surface. In the volume bake
// this NO LONGER gates lighting (every cell is baked) - it only picks where debris spawns.
// Returns the survivors plus per-probe nearest-distance and density (for logging).
export function filterProbesBySplatProximity(
    positions: THREE.Vector3[],
    grid: SplatGrid,
    { minClearance, densityRadius, minDensity }: SplatProximityFilter,
): { kept: THREE.Vector3[]; distances: number[]; densities: number[] } {
    const kept: THREE.Vector3[] = [];
    const distances: number[] = [];
    const densities: number[] = [];
    for (const p of positions) {
        const density = localSplatDensity(grid, p.x, p.y, p.z, densityRadius);
        if (density < minDensity) continue; // sparse region / open void - no local geometry to light from
        // Only search as far as the clearance we care about; Infinity (nothing that
        // close) passes. Skip the search entirely when the near cull is disabled.
        const d = minClearance > 0 ? nearestSplatDistance(grid, p.x, p.y, p.z, minClearance) : Infinity;
        if (d < minClearance) continue; // jammed against / inside a surface - captures black
        kept.push(p);
        distances.push(d);
        densities.push(density);
    }
    return { kept, distances, densities };
}
