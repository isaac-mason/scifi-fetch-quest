import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';

// A baked grid of irradiance light probes. Each grid point holds an order-2 SH
// probe captured from the scene at that spot; at runtime we blend the nearby
// probes into a single scene LightProbe so the companions pick up the ship's
// local lighting as the group moves around. Splats are self-lit and ignore
// three lights, so this only affects the character meshes (MeshStandardMaterial).
export type ProbeGrid = {
    positions: Vec3[];
    sh: THREE.SphericalHarmonics3[];
    blendRadius: number; // world-space falloff for the inverse-distance blend
    saturation?: number; // chroma boost already baked into `sh` (undefined / 1 = raw)
};

export type BakeOptions = {
    resolution?: number; // per-face render size (px); 128 is plenty for order-2 SH
    near?: number;
    far?: number;
    hide?: THREE.Object3D[]; // hidden during capture so they don't light themselves
    blendRadius?: number;
    flipY?: boolean; // flip captured faces vertically (GL readback is bottom-up)
    saturation?: number; // chroma boost to bake into every probe (1 = raw); see saturateSphericalHarmonics
    onProgress?: (done: number, total: number) => void;
};

// Wrap Spark's six raw RGBA face buffers as a CubeTexture of canvases, which is
// what LightProbeGenerator.fromCubeTexture consumes (it drawImage()s each face).
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

// Capture the six cube faces at `center` by rendering each as its own 90° view to
// the CANVAS (renderer.render with target=null) — the only path that makes Spark
// draw splats (it won't render into an arbitrary render target; renderCubeMap only
// fills 2-3 faces; renderReadTarget reuses one viewpoint) — then reading the canvas
// framebuffer back with gl.readPixels. `size` = the renderer's square canvas size.
function captureCubeFaces(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    center: THREE.Vector3,
    near: number,
    far: number,
    size: number,
): Uint8Array[] {
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
        // Render twice: the first pass triggers Spark's (deferred) splat sort for
        // this camera; the second actually draws the sorted splats before readback.
        renderer.render(scene, cam);
        renderer.render(scene, cam);
        const buf = new Uint8Array(size * size * 4);
        // Spark leaves a PIXEL_PACK_BUFFER bound from its own GPU readback; if one is
        // bound, readPixels writes into THAT buffer (an offset) instead of `buf`, so the
        // faces come back all-zero (black probes, DC 0). Unbind it first.
        (gl as WebGL2RenderingContext).bindBuffer((gl as WebGL2RenderingContext).PIXEL_PACK_BUFFER, null);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf); // bottom-up (flipY handles it)
        faces.push(buf);
    }
    return faces;
}

// Capture an SH probe at each position: six per-face renders -> CubeTexture ->
// order-2 SH projection. Assumes the splats are already fully resident (the bake
// warms up to full residency first).
export async function bakeProbeGrid(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    positions: Vec3[],
    opts: BakeOptions = {},
): Promise<ProbeGrid> {
    const near = opts.near ?? 0.05;
    const far = opts.far ?? 100;
    const hide = opts.hide ?? [];
    const flipY = opts.flipY ?? true;
    const size = opts.resolution ?? 128;
    const saturation = opts.saturation ?? 1;

    // Hide non-splat meshes for the whole bake so they can't leak into any capture.
    const prevVisible = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;

    const center = new THREE.Vector3();
    const sh: THREE.SphericalHarmonics3[] = [];
    for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        center.set(p[0], p[1], p[2]);
        const faces = captureCubeFaces(renderer, scene, center, near, far, size);
        const cube = facesToCubeTexture(faces, size, flipY);
        const probeSh = LightProbeGenerator.fromCubeTexture(cube).sh;
        // Bake the chroma boost straight into the SH so the shipped grid (and the
        // debug spheres) already carry it — the runtime then does no per-frame work.
        saturateSphericalHarmonics(probeSh, saturation);
        sh.push(probeSh);
        cube.dispose();
        opts.onProgress?.(i + 1, positions.length);
    }

    for (let i = 0; i < hide.length; i++) hide[i].visible = prevVisible[i];
    return { positions, sh, blendRadius: opts.blendRadius ?? 4, saturation };
}

// Exposed for the bake's diagnostic (raw face strip): capture the six faces at a
// point and return the flat RGBA buffers + their side length.
export function captureCubeFacesAt(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    pos: Vec3,
    size = 128,
    near = 0.05,
    far = 100,
): { faces: Uint8Array[]; size: number } {
    const faces = captureCubeFaces(renderer, scene, new THREE.Vector3(pos[0], pos[1], pos[2]), near, far, size);
    return { faces, size };
}

// Serialize a baked grid to JSON: positions + the 9 SH coefficients (x,y,z each)
// per probe, flattened. Small — a few hundred probes is tens of KB. Bake once,
// commit the file, load it at runtime (deserializeProbeGrid).
export function serializeProbeGrid(grid: ProbeGrid): string {
    return JSON.stringify({
        blendRadius: grid.blendRadius,
        saturation: grid.saturation,
        positions: grid.positions,
        sh: grid.sh.map((s) => s.coefficients.flatMap((c) => [c.x, c.y, c.z])),
    });
}

export function deserializeProbeGrid(text: string): ProbeGrid {
    const d = JSON.parse(text) as { blendRadius: number; saturation?: number; positions: Vec3[]; sh: number[][] };
    const sh = d.sh.map((arr) => {
        const s = new THREE.SphericalHarmonics3();
        for (let i = 0; i < 9; i++) s.coefficients[i].set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
        return s;
    });
    return { positions: d.positions, sh, blendRadius: d.blendRadius, saturation: d.saturation };
}

// Rec.709 luma weights — a colour's perceived brightness, the axis saturation
// pivots around.
const LUMA = { x: 0.2126, y: 0.7152, z: 0.0722 };
const ZERO = new THREE.Vector3(0, 0, 0);

// Push an SH probe's colours away from grey. A diffuse irradiance probe integrates
// the whole hemisphere, so the ship's grey walls average the localized emissive
// primaries (magenta glow, cyan panels, plants) down toward grey. Boosting saturation
// amplifies whatever chroma the probe *did* capture so those colours read on the
// companions. Exact on SH: the saturation map is linear in RGB, so applying it
// per-coefficient equals applying it to the final evaluated irradiance.
// saturation = 1 is a no-op; > 1 boosts. Baked into every grid probe offline (see
// bakeProbeGrid), so the shipped grid carries it and the runtime does no per-frame work.
export function saturateSphericalHarmonics(sh: THREE.SphericalHarmonics3, saturation: number): void {
    if (saturation === 1) return;
    const coeffs = sh.coefficients;
    for (const c of coeffs) {
        const lum = c.x * LUMA.x + c.y * LUMA.y + c.z * LUMA.z;
        c.x = lum + (c.x - lum) * saturation;
        c.y = lum + (c.y - lum) * saturation;
        c.z = lum + (c.z - lum) * saturation;
    }
    // Keep the average (DC) irradiance non-negative — a strong boost on a channel far
    // below the luminance could otherwise push it slightly negative (unphysical).
    coeffs[0].max(ZERO);
}

// Blend the grid's probes near (x, y, z) into `out` via compact-support inverse-
// distance weighting (smooth, local, 3D so vertical layers resolve). Falls back to
// the single nearest probe when nothing is in range. Cheap for a small grid.
export function sampleProbeGrid(grid: ProbeGrid, x: number, y: number, z: number, out: THREE.LightProbe): void {
    const R = grid.blendRadius;
    const coeffs = out.sh.coefficients;
    for (let c = 0; c < coeffs.length; c++) coeffs[c].set(0, 0, 0);

    let sumW = 0;
    let nearest = -1;
    let nearestD2 = Infinity;
    for (let i = 0; i < grid.positions.length; i++) {
        const dx = grid.positions[i][0] - x;
        const dy = grid.positions[i][1] - y;
        const dz = grid.positions[i][2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearestD2) {
            nearestD2 = d2;
            nearest = i;
        }
        const d = Math.sqrt(d2);
        if (d >= R) continue;
        let w = 1 - d / R;
        w *= w; // smoother falloff
        sumW += w;
        const src = grid.sh[i].coefficients;
        for (let c = 0; c < coeffs.length; c++) coeffs[c].addScaledVector(src[c], w);
    }

    if (sumW > 0) {
        const inv = 1 / sumW;
        for (let c = 0; c < coeffs.length; c++) coeffs[c].multiplyScalar(inv);
    } else if (nearest >= 0) {
        out.sh.copy(grid.sh[nearest]);
    }
}
