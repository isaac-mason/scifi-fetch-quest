/**
 * Collider generation worker. Owns the parsed splat cloud and the cached rasterised field,
 * and runs the (blocking) voxel→marching-cubes pipeline off the main thread so the tuning
 * tool's camera stays smooth while a regenerate is in flight.
 *
 * Protocol (main ↔ worker):
 *   → { type: 'load', bytes }                  load + parse the .spz
 *   ← { type: 'ready', numPoints, min, max }   parsed; bbox for camera framing
 *   → { type: 'generate', reqId, params }      build a collider with these params
 *   ← { type: 'result', reqId, positions, indices, solid, grid, stats }
 *   ← { type: 'error', reqId, message }
 *
 * The field cache lives here: rasterisation (the expensive step) is reused across tweaks
 * that only change "shape" params (threshold/morph/blur/iso/post-passes).
 */
import { parseSpz, type SplatCloud } from './collider/spz';
import {
    type ColliderParams,
    colliderFromField,
    generateCollider,
    type Occupancy,
    rasterizeField,
    type VoxelGrid,
} from './collider/voxel-marching';

// The default lib types `self` as a Window; alias it to the worker's postMessage/onmessage
// shape (message + transfer list) without pulling in the WebWorker lib.
const ctx = self as unknown as {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};

let cloud: SplatCloud | null = null;
let cache: { sig: string; grid: VoxelGrid; field: Float32Array; occupancy: Occupancy } | null = null;

// Params that change the rasterised field (vs. the cheap "shape" params reused from cache).
const rasterSig = (p: ColliderParams): string =>
    `${p.cellSize}|${p.cellHeight}|${p.mode}|${p.splatRadius}|${p.minRadius}|${p.maxRadius}|${p.minOpacity}|` +
    `${p.boundsEnabled}|${p.boundsMin.join(',')}|${p.boundsMax.join(',')}`;

ctx.onmessage = async (e: MessageEvent) => {
    const msg = e.data;

    if (msg.type === 'load') {
        cloud = await parseSpz(new Uint8Array(msg.bytes));
        const p = cloud.positions;
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) {
            for (let a = 0; a < 3; a++) {
                if (p[i + a] < min[a]) min[a] = p[i + a];
                if (p[i + a] > max[a]) max[a] = p[i + a];
            }
        }
        ctx.postMessage({ type: 'ready', numPoints: cloud.numPoints, min, max });
        return;
    }

    if (msg.type === 'generate') {
        if (!cloud) return;
        const params = msg.params as ColliderParams;
        const progress = (message: string, fraction: number) =>
            ctx.postMessage({ type: 'progress', reqId: msg.reqId, message, fraction });
        try {
            const t0 = performance.now();
            let result: ReturnType<typeof colliderFromField>;
            try {
                const sig = rasterSig(params);
                if (!cache || cache.sig !== sig) {
                    progress('rasterising', 0);
                    const r = rasterizeField(cloud, params);
                    cache = { sig, grid: r.grid, field: r.field, occupancy: r.occupancy };
                }
                progress('meshing', 0.5);
                result = colliderFromField(cache.field, cache.grid, params, cache.occupancy, t0);
                result.stats.numPoints = cloud.numPoints;
            } catch {
                // Grid too large for the single-pass cache → tiled path (no field cache).
                cache = null;
                result = generateCollider(cloud, params, progress);
            }
            const { positions, indices } = result.mesh;
            const solid = result.solid;
            ctx.postMessage(
                { type: 'result', reqId: msg.reqId, positions, indices, solid, grid: result.grid, stats: result.stats },
                [positions.buffer, indices.buffer, solid.buffer],
            );
        } catch (err) {
            ctx.postMessage({ type: 'error', reqId: msg.reqId, message: (err as Error).message });
        }
    }
};
