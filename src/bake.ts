/**
 * Offline light-probe bake harness.
 *
 * A deliberately minimal scene — the ship splat + the navmesh only. NO characters,
 * physics, controls, debug or fill lights — so the probe capture integrates JUST
 * the ship environment. The splat is loaded with `nonLod: true`, which decodes the
 * WHOLE splat into a non-paged PackedSplats set: `splat.initialized` resolving is
 * then a real "everything is in memory" guarantee, instead of the flaky,
 * view-culled `spark.activeSplats` counter we can't trust.
 *
 * scripts/bake-probes.mjs drives this page headed in real Chrome (Spark needs a real
 * GPU) and writes the result to public/light-probes.json via window.__saveProbes.
 * It also dumps a raw env-capture strip (window.__saveDebugPng) so we can eyeball
 * exactly what Spark captured. Opened manually in a browser it downloads instead.
 */
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';

import { loadCollider } from './collider-load';
import type { Collider } from './collider-schema';
import { bakeProbeGrid, captureCubeFacesAt, serializeProbeGrid } from './light-probes';
import { initNavigation, loadNavigation, snapToNavMesh } from './navigation';
import {
    COLLIDER_URL,
    PROBE_HEIGHTS,
    PROBE_KEEP_RADIUS,
    PROBE_MAX_XZ,
    PROBE_MIN_XZ,
    PROBE_SATURATION,
    PROBE_SPACING,
    SPLAT_URL,
} from './scene';

declare global {
    interface Window {
        __saveProbes?: (json: string) => void | Promise<void>;
        __saveDebugPng?: (dataUrl: string) => void | Promise<void>;
        __bakeError?: (msg: string) => void;
    }
}

const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Distance (m) from `pos` to the nearest collider triangle — the proximity metric
// for dropping probes that sit far from any ship surface.
function distToCollider(pos: Vec3, collider: Collider): number {
    const { positions, indices } = collider;
    const p = _v0.set(pos[0], pos[1], pos[2]);
    let best = Infinity;
    for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i] * 3;
        const ib = indices[i + 1] * 3;
        const ic = indices[i + 2] * 3;
        _tri.a.set(positions[ia], positions[ia + 1], positions[ia + 2]);
        _tri.b.set(positions[ib], positions[ib + 1], positions[ib + 2]);
        _tri.c.set(positions[ic], positions[ic + 1], positions[ic + 2]);
        _tri.closestPointToPoint(p, _closest);
        const d2 = p.distanceToSquared(_closest);
        if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
}
const _v0 = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _tri = new THREE.Triangle();

function downloadText(filename: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// Capture the six per-face renders at `pos` (raw — no colour/flip/SH) and lay them
// out in a horizontal strip data URL: exactly what the SH sees, so we can confirm
// all six faces are now populated.
function captureFaceStrip(renderer: THREE.WebGLRenderer, scene: THREE.Scene, pos: Vec3, faceSize: number): string {
    const { faces, size } = captureCubeFacesAt(renderer, scene, pos, faceSize);
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
    // Square canvas at the capture resolution: we read the canvas framebuffer back
    // per face, so its size IS the face size. pixelRatio 1 so drawing buffer == size.
    const FACE_SIZE = 256;
    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(FACE_SIZE, FACE_SIZE);
    document.body.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    camera.position.set(-11, 5, -2); // scifi_world collider centre (warms up streaming)

    const spark = new SparkRenderer({ renderer, coneFoveate: 0 });
    scene.add(spark);

    // The .rad is a paged LOD file (nonLod decodes 0 splats for it), so we can't
    // fully preload it — instead we render at full detail (lod off, no foveation)
    // and rely on a per-probe stream-then-resettle in the capture (settleMs below)
    // so each probe's pages are resident before it's read.
    const splat = new SplatMesh({ url: encodeURI(SPLAT_URL), lod: false, coneFoveate: 0 });
    scene.add(splat);
    await splat.initialized;
    const total = splat.numSplats;
    console.log(`bake: splat has ${total.toLocaleString()} splats; streaming toward residency…`);

    // Drive frames until residency plateaus. On a real GPU this climbs toward
    // `total`; the logged ratio makes it obvious if it stalls far below.
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 600 && stable < 20; i++) {
        renderer.render(scene, camera);
        await waitMs(50);
        const a = spark.activeSplats;
        if (a === last) stable++;
        else {
            stable = 0;
            last = a;
        }
    }
    console.log(
        `bake: resident ${spark.activeSplats.toLocaleString()} / ${total.toLocaleString()} (view-culled; per-probe settle covers the rest)`,
    );

    // Navmesh drives probe placement (walkable floor only).
    const navigation = initNavigation();
    await loadNavigation(navigation);

    // Collider drives the proximity filter — only keep probes near a ship surface.
    const collider = await loadCollider(COLLIDER_URL);

    // Snap the XZ grid onto the navmesh floor, then place a probe at each
    // PROBE_HEIGHTS layer above it (vertical variation inside rooms).
    const candidates: Vec3[] = [];
    for (let x = PROBE_MIN_XZ[0]; x <= PROBE_MAX_XZ[0]; x += PROBE_SPACING) {
        for (let z = PROBE_MIN_XZ[1]; z <= PROBE_MAX_XZ[1]; z += PROBE_SPACING) {
            const out: Vec3 = [0, 0, 0];
            if (!snapToNavMesh(navigation, [x, 0, z], out)) continue;
            for (const h of PROBE_HEIGHTS) candidates.push([out[0], out[1] + h, out[2]]);
        }
    }
    // Distance-to-collider per candidate; drop those farther than PROBE_KEEP_RADIUS.
    const dists = candidates.map((c) => distToCollider(c, collider));
    const positions = candidates.filter((_, i) => dists[i] <= PROBE_KEEP_RADIUS);
    // Show how many would survive at a range of radii, so PROBE_KEEP_RADIUS is easy
    // to tune from data.
    const buckets = [0.4, 0.6, 0.8, 1.0, 1.25, 1.5, 2.0].map((r) => `${r}m:${dists.filter((d) => d <= r).length}`).join('  ');
    console.log(`bake: keep-count by radius -> ${buckets}  (of ${candidates.length} candidates)`);
    console.log(
        `bake: ${positions.length} probe samples kept at PROBE_KEEP_RADIUS=${PROBE_KEEP_RADIUS}m (${PROBE_HEIGHTS.length} heights)`,
    );

    // Diagnostic: dump the raw six per-face renders of a central probe so we can
    // confirm all six faces are populated + distinct.
    if (positions.length > 0) {
        const mid = positions[Math.floor(positions.length / 2)];
        const strip = captureFaceStrip(renderer, scene, mid, FACE_SIZE);
        if (window.__saveDebugPng) await window.__saveDebugPng(strip);
        console.log(`bake: dumped raw env faces at [${mid.map((v) => v.toFixed(1)).join(', ')}]`);
    }

    // Six per-face renderer.render() captures per probe. The blend radius spans the
    // XZ spacing and the vertical layer gap so 3D sampling stays smooth.
    // Bake PROBE_SATURATION straight into the grid so the shipped JSON carries the
    // chroma boost (runtime then tops up to a no-op). Retune it live first, then rebake.
    const grid = await bakeProbeGrid(renderer, scene, positions, {
        resolution: FACE_SIZE,
        blendRadius: PROBE_SPACING * 1.6,
        saturation: PROBE_SATURATION,
    });
    const dc = grid.sh.map((sh) => sh.coefficients[0].length());
    console.log(
        `bake: done ${grid.positions.length} probes, DC min ${Math.min(...dc).toFixed(3)} max ${Math.max(...dc).toFixed(3)}`,
    );

    const json = serializeProbeGrid(grid);
    if (window.__saveProbes) await window.__saveProbes(json);
    else downloadText('light-probes.json', json);
    console.log('bake: saved light-probes.json');
    document.title = 'bake complete';
}

main().catch((err) => {
    console.error(err);
    window.__bakeError?.(String((err as Error)?.stack ?? err));
});
