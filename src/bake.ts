/**
 * Offline light-probe VOLUME bake harness.
 *
 * A deliberately minimal scene — JUST the ship splat — so each probe capture integrates
 * only the environment (no characters, fill lights, or debug). The .spz is loaded with
 * `nonLod: true`, decoding the WHOLE splat into a non-paged set, so `splat.initialized`
 * resolving is a real "everything is in memory" guarantee — no per-probe streaming.
 *
 * The grid box is fit to the COLLIDER's AABB (the hand-authored collision mesh bounds the
 * playable interior tightly), inset a little, then filled with a DENSE lattice: every cell
 * is captured as an order-2 SH probe, packed into a 3D-texture atlas, and shipped as
 * light-probes.json. Intensity + saturation are baked straight into the SH.
 *
 * scripts/bake-probes.mjs drives this page headed in real Chrome (Spark needs a real GPU)
 * and writes the result to public/light-probes.json via window.__saveProbes. It also dumps a
 * raw six-face env-capture strip (window.__saveDebugPng) to eyeball what Spark captured.
 * Opened manually in a browser it downloads instead.
 */
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { loadCollider } from './collider-load';
import { bakeProbeGrid, buildDenseLattice, captureCubeFacesAt, packProbeAtlas, serializeProbeGridFile } from './light-probes';
import {
    CAMERA_TARGET,
    COLLIDER_URL,
    PROBE_BOX_INSET,
    PROBE_INTENSITY,
    PROBE_SATURATION,
    PROBE_SPACING,
    SPLAT_BAKE_URL,
} from './scene';

declare global {
    interface Window {
        __saveProbes?: (json: string) => void | Promise<void>;
        __saveDebugPng?: (dataUrl: string) => void | Promise<void>;
        __bakeError?: (msg: string) => void;
    }
}

function downloadText(filename: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// Capture the six per-face renders at `pos` (raw — no colour/flip/SH) and lay them out in a
// horizontal strip data URL: exactly what the SH sees, so we can confirm all six faces are
// populated + distinct.
async function captureFaceStrip(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    pos: THREE.Vector3,
    faceSize: number,
): Promise<string> {
    const { faces, size } = await captureCubeFacesAt(renderer, scene, pos, faceSize);
    const canvas = document.createElement('canvas');
    canvas.width = size * faces.length;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    faces.forEach((buf, i) => {
        const img = ctx.createImageData(size, size);
        img.data.set(buf.subarray(0, size * size * 4));
        ctx.putImageData(img, i * size, 0);
    });
    return canvas.toDataURL('image/png');
}

async function main(): Promise<void> {
    // Square canvas at the capture resolution: we render each cube face to the canvas and read
    // the framebuffer back, so its size IS the face size. 128 is plenty for order-2 SH.
    const FACE_SIZE = 128;
    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(FACE_SIZE, FACE_SIZE);
    document.body.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    camera.position.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);

    const spark = new SparkRenderer({ renderer, coneFoveate: 0 });
    scene.add(spark);

    // nonLod: true decodes the whole source .spz into a non-paged PackedSplats set, so
    // `splat.initialized` resolving means every splat is resident — exactly the guarantee the
    // bake needs. We bake from the .spz, not the runtime .rad, precisely for full residency.
    const splat = new SplatMesh({ url: encodeURI(SPLAT_BAKE_URL), nonLod: true });
    scene.add(splat);
    await splat.initialized;
    console.log(`bake: splat fully resident — ${splat.numSplats.toLocaleString()} splats`);

    // Warm-up: render real frames (yielding to the event loop each time) so Spark builds its
    // splat instances + first sort before we start capturing. The per-face settle in
    // captureCubeFaces handles the rest; this just primes the pump.
    for (let i = 0; i < 30; i++) {
        renderer.render(scene, camera);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }

    // Fit the probe box to the collider's AABB, then inset so edge cells sit just inside the
    // hull. The collider is the hand-authored collision mesh, so its bounds already frame the
    // playable interior — no splat-occupancy fitting needed.
    const collider = await loadCollider(COLLIDER_URL);
    const bbox = new THREE.Box3().setFromArray(collider.positions);
    const min = bbox.min.clone().addScalar(PROBE_BOX_INSET);
    const max = bbox.max.clone().addScalar(-PROBE_BOX_INSET);
    const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
    console.log(`bake: collider AABB ${fmt(bbox.min)} -> ${fmt(bbox.max)}`);
    console.log(`bake: probe box    ${fmt(min)} -> ${fmt(max)}  (inset ${PROBE_BOX_INSET}m)`);

    // DENSE regular grid: every cell is baked (a 3D-texture volume can't ship holes — a void
    // cell just captures dark). Fixed resolution + cell order match the atlas packer; the
    // effective box is what the runtime shader samples against.
    const { positions, nx, ny, nz, box } = buildDenseLattice(min, max, PROBE_SPACING);
    console.log(`bake: dense ${nx}x${ny}x${nz} = ${positions.length} probes on a ${PROBE_SPACING}m grid`);

    // Guard: a mis-fit box blows up a DENSE grid fast (nx*ny*nz). Bail loudly instead — raise
    // PROBE_SPACING to coarsen the grid, or shrink the collider/inset.
    const MAX_PROBES = 20000;
    if (positions.length > MAX_PROBES) {
        throw new Error(
            `dense grid is ${nx}x${ny}x${nz} = ${positions.length} cells (> ${MAX_PROBES}). ` +
                `The box ${fmt(min)}->${fmt(max)} is probably too big — raise PROBE_SPACING in src/scene.ts.`,
        );
    }

    // Diagnostic: dump the raw six per-face renders of a central probe so we can confirm all
    // six faces are populated + distinct.
    if (positions.length > 0) {
        const mid = positions[Math.floor(positions.length / 2)];
        const strip = await captureFaceStrip(renderer, scene, mid, FACE_SIZE);
        if (window.__saveDebugPng) await window.__saveDebugPng(strip);
        console.log(
            `bake: dumped raw env faces at [${mid
                .toArray()
                .map((v) => v.toFixed(1))
                .join(', ')}]`,
        );
    }

    // Six per-face canvas renders per probe. Bake PROBE_SATURATION straight into the SH so the
    // shipped atlas carries the chroma boost. Coefficients come back in `positions` order.
    const probeSH = await bakeProbeGrid(renderer, scene, positions, {
        resolution: FACE_SIZE,
        saturation: PROBE_SATURATION,
        onProgress: (done, total) => {
            if (done % 64 === 0 || done === total) console.log(`bake: ${done}/${total} probes`);
        },
    });

    // Bake the runtime intensity into the coefficients too: the volume shader has no per-probe
    // multiplier (unlike the old per-mesh LightProbe path), so it must live in the atlas.
    for (const sh of probeSH) for (const c of sh.coefficients) c.multiplyScalar(PROBE_INTENSITY);

    const dc = probeSH.map((sh) => sh.coefficients[0].length());
    console.log(`bake: done ${probeSH.length} probes, DC min ${Math.min(...dc).toFixed(3)} max ${Math.max(...dc).toFixed(3)}`);

    // Pack into the 3D-texture atlas layout the volume shader reads (see light-probes.ts). No
    // debris in this scene, so no seed points.
    const atlas = packProbeAtlas(probeSH, nx, ny, nz);
    const json = serializeProbeGridFile(atlas, box, {
        intensity: PROBE_INTENSITY,
        saturation: PROBE_SATURATION,
        seedPositions: [],
    });
    if (window.__saveProbes) await window.__saveProbes(json);
    else downloadText('light-probes.json', json);
    console.log(`bake: saved light-probes.json (${(json.length / 1024).toFixed(0)} KB, ${nx}x${ny}x${nz} atlas)`);
    document.title = 'bake complete';
}

main().catch((err) => {
    console.error(err);
    window.__bakeError?.(String((err as Error)?.stack ?? err));
});
