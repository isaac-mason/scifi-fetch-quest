/**
 * Splat-cloud → collision mesh, via voxel rasterisation then marching cubes.
 *
 * Pipeline (all steps tweakable — see ColliderParams):
 *   1. rasterise:  accumulate splats into a voxel grid — either one hit per centre
 *      ('centers') or each splat's opacity spread over its Gaussian footprint
 *      ('coverage', the truer density field; see RasterMode). The grid has SEPARATE
 *      horizontal (cellSize, XZ) and vertical (cellHeight, Y) resolutions — floors/
 *      ceilings usually want finer vertical sampling than the horizontal footprint.
 *   2. threshold:  a voxel is "solid" if its accumulated value ≥ densityThreshold.
 *      This rejects sparse floaters/fog (opacity-weighted in 'coverage' mode).
 *   3. morphology: optional dilate then erode (a morphological CLOSE) to seal
 *      pinholes and thin gaps so the player can't fall through a wall.
 *   3b. fill hollow slabs (per XZ column): splats only capture SURFACES, so a floor/
 *      platform is a hollow shell (top sheet + bottom sheet). fillGaps closes short
 *      enclosed vertical gaps (≤ maxGapFill) into solid slabs, leaving rooms (tall gaps) open.
 *   4. blur:       optional box-blur of the 0/1 solid field into a smooth 0..1
 *      scalar field, so marching cubes cuts a smooth surface instead of stair-steps.
 *   5. marching cubes: extract the isosurface at isoLevel as a welded triangle mesh.
 *
 * Everything past step 1 runs on dense typed arrays (no hashing) — fast for a filled
 * interior and the natural fit for the column-scan post-passes; the grid volume is capped
 * (DENSE_CAP) so memory stays bounded.
 *
 * This module is pure and environment-agnostic: the Node CLI
 * (scripts/build-collider-spz.ts) and the browser tuning tool (src/collider-gen.ts)
 * both import it, so params tuned in the browser transfer verbatim to the CLI bake.
 */

/**
 * How splats are accumulated into the voxel field:
 *  - 'centers'  — count one hit per splat centre (fast, simple; good when splats
 *                 densely tile surfaces and are smaller than a voxel).
 *  - 'coverage' — accumulate each splat's OPACITY, spread over its footprint (an
 *                 isotropic Gaussian of radius scale·splatRadius, floored at minRadius,
 *                 capped at maxRadius). Down-weights faint fog and lets a few confident
 *                 splats hold a sparse region solid — the "truest" density field.
 */
export type RasterMode = 'centers' | 'coverage';

export type ColliderParams = {
    /** Horizontal (XZ) voxel size, world units. */
    cellSize: number;
    /** Vertical (Y) voxel size, world units. */
    cellHeight: number;
    /** How splats accumulate into the field (see RasterMode). */
    mode: RasterMode;
    /** Solid threshold on the accumulated field: splat count ('centers') or opacity mass ('coverage'). */
    densityThreshold: number;
    // --- 'coverage' mode only ---
    /** Footprint radius as a multiple of the splat's scale (≈ Gaussian σ span). */
    splatRadius: number;
    /** Minimum footprint radius, world units. Inflates tiny splats to fill sparse areas (0 = off). */
    minRadius: number;
    /** Maximum footprint radius, world units. Splats larger than this are skipped (rejects sky/background blobs). */
    maxRadius: number;
    /** Skip splats fainter than this opacity (0..1). */
    minOpacity: number;
    // --- shared post-processing ---
    /** Morphological dilation passes (grow solid) — seals gaps. Applied before erode. */
    dilate: number;
    /** Morphological erosion passes (shrink solid) — with dilate forms a CLOSE. */
    erode: number;
    // --- fill hollow slabs (splats capture SURFACES only, so a captured floor/platform is
    //     a hollow shell: a top sheet + a bottom sheet with air between) ---
    /**
     * Per XZ column, fill enclosed vertical air-gaps no taller than maxGapFill. A captured
     * floor/platform/ceiling is a thin hollow slab, so its interior gap is short → it fills
     * into a solid slab (one walkable top, no fall-through). A room (floor↔ceiling) is a
     * TALL enclosed gap, so it's left open — which is why ceilings don't drag the collider
     * down. A gap must be capped by solid both above AND below to count (open headroom is ignored).
     */
    fillGaps: boolean;
    /** Max enclosed-gap height to fill, world units — roughly a slab's thickness (fills slabs, not rooms). */
    maxGapFill: number;
    /** Box-blur passes over the 0..1 field before marching cubes. Higher = smoother. */
    blur: number;
    /** Isosurface level in 0..1 for marching cubes (0.5 = halfway). */
    isoLevel: number;
    // --- crop bounds ---
    /** Crop the collider to boundsMin..boundsMax (world units). Off = use the full cloud bbox. */
    boundsEnabled: boolean;
    /** Lower corner of the crop box, world units. */
    boundsMin: [number, number, number];
    /** Upper corner of the crop box, world units. */
    boundsMax: [number, number, number];
}

export const DEFAULT_PARAMS: ColliderParams = {
    cellSize: 0.1,
    cellHeight: 0.05,
    mode: 'coverage',
    densityThreshold: 2,
    splatRadius: 1,
    minRadius: 0.01, // 0 = footprints stay true to each splat's size (no inflation)
    maxRadius: 0.5, // reject/clamp large splats so a few don't balloon into blobs
    minOpacity: 0.3,
    dilate: 0,
    erode: 0,
    // Fill hollow floor/ceiling slabs. maxGapFill ≈ a captured slab's thickness — big
    // enough to close floor/ceiling shells, small enough to leave rooms open.
    fillGaps: true,
    maxGapFill: 0.4,
    blur: 1,
    isoLevel: 0.5,
    // Crop to the playable region (the scifi_world deck around spawn).
    boundsEnabled: true,
    boundsMin: [-22, -2, -38],
    boundsMax: [38, 7, 11],
};

/** Input splat cloud for the collider pipeline (a subset of parseSpz's SplatCloud). */
export interface SplatInput {
    /** Flat xyz triples (length numPoints*3). */
    positions: Float32Array;
    /** Per-splat footprint radius in world units (length numPoints). Required for 'coverage'. */
    scales?: Float32Array;
    /** Per-splat opacity in [0,1] (length numPoints). Required for 'coverage'. */
    opacities?: Float32Array;
}

export interface VoxelGrid {
    nx: number;
    ny: number;
    nz: number;
    /** Horizontal voxel size (XZ). */
    cellSize: number;
    /** Vertical voxel size (Y). */
    cellHeight: number;
    /** World position of lattice point (0,0,0). */
    min: [number, number, number];
}

export interface ColliderMesh {
    /** Flat world-space xyz triples. */
    positions: Float32Array;
    /** Triangle indices into `positions`. */
    indices: Uint32Array;
}

export interface ColliderResult {
    /** Grid metadata (dims + world placement). */
    grid: VoxelGrid;
    /** Dense 0/1 occupancy (length nx*ny*nz) after threshold + morphology + post-passes, for viz. */
    solid: Uint8Array;
    mesh: ColliderMesh;
    stats: {
        numPoints: number;
        dims: [number, number, number];
        solidVoxels: number;
        vertices: number;
        triangles: number;
        timeMs: number;
    };
}

// Sanity cap on total grid dimensions (independent of the memory-driven DENSE_CAP/tiling
// below): guards against a cell size so tiny the linear voxel index would exceed exact
// float-integer range. A grid this large would tile into an impractical number of pieces.
const MAX_DIM_PRODUCT = 2 ** 50;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Voxels are addressed by a single linear index `x + nx*y + nx*ny*z`. Decoding a
// single axis coordinate back out (for bounds checks) is all the neighbour ops need.

// A splat's Gaussian footprint is stamped out to this many σ; beyond it the weight is
// negligible. Also bounds the per-splat voxel extent (with MAX_STAMP_RADIUS) so a huge
// minRadius can't make every splat paint the whole grid.
const GAUSS_CUTOFF = 2.5;
const MAX_STAMP_RADIUS = 5; // voxels, per axis

/** The crop box from params, or null when disabled (use the full cloud). */
function cropBounds(params: ColliderParams): { min: [number, number, number]; max: [number, number, number] } | null {
    return params.boundsEnabled ? { min: params.boundsMin, max: params.boundsMax } : null;
}

/**
 * Compute the padded voxel grid (dims + world placement). Without `bounds` it encloses the
 * whole cloud; with `bounds` it's exactly the crop box — splats outside then fall off the
 * grid during rasterisation, so nothing beyond the box is meshed.
 */
function makeGrid(
    positions: Float32Array,
    cellSize: number,
    cellHeight: number,
    bounds?: { min: [number, number, number]; max: [number, number, number] } | null,
): VoxelGrid {
    let minx: number;
    let miny: number;
    let minz: number;
    let maxx: number;
    let maxy: number;
    let maxz: number;
    if (bounds) {
        [minx, miny, minz] = bounds.min;
        [maxx, maxy, maxz] = bounds.max;
    } else {
        const n = positions.length / 3;
        minx = miny = minz = Infinity;
        maxx = maxy = maxz = -Infinity;
        for (let i = 0; i < n; i++) {
            const x = positions[i * 3];
            const y = positions[i * 3 + 1];
            const z = positions[i * 3 + 2];
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (z < minz) minz = z;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
            if (z > maxz) maxz = z;
        }
    }
    if (!Number.isFinite(minx) || maxx < minx || maxy < miny || maxz < minz)
        throw new Error('makeGrid: empty or inverted bounds');

    const PAD = 2;
    const min: [number, number, number] = [minx - PAD * cellSize, miny - PAD * cellHeight, minz - PAD * cellSize];
    const nx = Math.ceil((maxx - minx) / cellSize) + PAD * 2 + 1;
    const ny = Math.ceil((maxy - miny) / cellHeight) + PAD * 2 + 1;
    const nz = Math.ceil((maxz - minz) / cellSize) + PAD * 2 + 1;
    if (nx * ny * nz > MAX_DIM_PRODUCT) {
        throw new Error(`Voxel grid dimensions too fine: ${nx}×${ny}×${nz}. Increase cellSize/cellHeight.`);
    }
    return { nx, ny, nz, cellSize, cellHeight, min };
}

// The pipeline runs on dense typed arrays (contiguous, no hashing) — far faster than
// hashed sparse maps for a filled interior, and the natural fit for the column-scan
// post-passes. A grid at/under DENSE_CAP is processed in one pass; a larger one is TILED
// in XZ (see generateTiled) so memory stays bounded by the tile, not the whole scene.
// The pipeline holds several buffers at once (~13 bytes/voxel at peak), so 128M ≈ 1.7GB.
// Both caps are overridable via env (Node only) to fit less RAM or to force the tiled path.
const envCap = (name: string, fallback: number): number => {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc ? Number(proc.env?.[name]) : Number.NaN;
    return Number.isFinite(v) && v > 0 ? v : fallback;
};
const DENSE_CAP = envCap('COLLIDER_DENSE_CAP', 128_000_000);
// Per-tile working volume budget (core + halo, full height) for the tiled path.
const TILE_WORKING_CAP = envCap('COLLIDER_TILE_CAP', 96_000_000);
// Drop Gaussian taps below this weight (at unit opacity) to keep each stamp small.
const KERNEL_EPS = 0.02;
// σ bucket size (world units) for kernel caching. Splats are quantised to buckets so the
// exp() cost is paid once per distinct σ, not per splat — and ~all splats share minRadius.
const SIGMA_QUANT = 0.01;

interface Kernel {
    rxv: number;
    ryv: number;
    rzv: number;
    dk: Int32Array; // linear-index delta per tap (valid for this grid's nx, nxny)
    dx: Int16Array;
    dy: Int16Array;
    dz: Int16Array;
    w: Float32Array; // Gaussian weight per tap, at unit opacity
}

/**
 * Precompute a voxel-centre-snapped Gaussian stamp for a given σ. Splats snap to their
 * nearest voxel (±½-voxel error, invisible after voxelisation), so the kernel is
 * position-independent and reusable — turning the per-voxel exp() into a table lookup.
 */
function buildKernel(sigma: number, cellSize: number, cellHeight: number, nx: number, nxny: number): Kernel {
    const inv2s2 = 1 / (2 * sigma * sigma);
    const rxv = Math.min(MAX_STAMP_RADIUS, Math.ceil((GAUSS_CUTOFF * sigma) / cellSize));
    const ryv = Math.min(MAX_STAMP_RADIUS, Math.ceil((GAUSS_CUTOFF * sigma) / cellHeight));
    const rzv = rxv;
    const dk: number[] = [];
    const dxs: number[] = [];
    const dys: number[] = [];
    const dzs: number[] = [];
    const ws: number[] = [];
    for (let dz = -rzv; dz <= rzv; dz++) {
        const wz = dz * cellSize;
        for (let dy = -ryv; dy <= ryv; dy++) {
            const wy = dy * cellHeight;
            for (let dx = -rxv; dx <= rxv; dx++) {
                const wx = dx * cellSize;
                const w = Math.exp(-(wx * wx + wy * wy + wz * wz) * inv2s2);
                if (w < KERNEL_EPS) continue;
                dk.push(dx + nx * dy + nxny * dz);
                dxs.push(dx);
                dys.push(dy);
                dzs.push(dz);
                ws.push(w);
            }
        }
    }
    return {
        rxv,
        ryv,
        rzv,
        dk: Int32Array.from(dk),
        dx: Int16Array.from(dxs),
        dy: Int16Array.from(dys),
        dz: Int16Array.from(dzs),
        w: Float32Array.from(ws),
    };
}

/**
 * Step 1: accumulate the splat cloud into `grid`'s dense scalar field. 'centers' counts
 * one hit per splat centre; 'coverage' stamps each splat's opacity over its Gaussian
 * footprint (kernel-cached, so exp() is paid once per distinct σ, not per voxel).
 *
 * `grid` may be a SUB-grid of the full scene (a tile): splats are mapped into its local
 * coordinates and anything outside is clipped, so the same code serves the single-pass
 * and tiled paths.
 */
function accumulateField(cloud: SplatInput, params: ColliderParams, grid: VoxelGrid): Float32Array {
    const { positions } = cloud;
    const { nx, ny, nz, cellSize, cellHeight, min } = grid;
    const nxny = nx * ny;
    const n = positions.length / 3;
    const invCS = 1 / cellSize;
    const invCH = 1 / cellHeight;
    const field = new Float32Array(nx * ny * nz);

    if (params.mode === 'centers') {
        for (let i = 0; i < n; i++) {
            const gx = Math.round((positions[i * 3] - min[0]) * invCS);
            const gy = Math.round((positions[i * 3 + 1] - min[1]) * invCH);
            const gz = Math.round((positions[i * 3 + 2] - min[2]) * invCS);
            if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) continue;
            field[gx + nx * gy + nxny * gz]++;
        }
        return field;
    }

    const { scales, opacities } = cloud;
    if (!scales || !opacities) throw new Error("'coverage' mode needs scales and opacities (parseSpz provides them)");
    const { splatRadius, minRadius, maxRadius, minOpacity } = params;
    const kernels = new Map<number, Kernel>();
    for (let i = 0; i < n; i++) {
        const op = opacities[i];
        if (op < minOpacity) continue;
        const scale = scales[i];
        if (scale > maxRadius) continue; // reject sky/background blobs
        const sigma = Math.min(maxRadius, Math.max(minRadius, splatRadius * scale));
        const gx0 = Math.round((positions[i * 3] - min[0]) * invCS);
        const gy0 = Math.round((positions[i * 3 + 1] - min[1]) * invCH);
        const gz0 = Math.round((positions[i * 3 + 2] - min[2]) * invCS);
        // Cheap reject: skip splats whose stamp can't reach this (sub-)grid at all.
        const rMax = MAX_STAMP_RADIUS + 1;
        if (gx0 < -rMax || gx0 >= nx + rMax || gy0 < -rMax || gy0 >= ny + rMax || gz0 < -rMax || gz0 >= nz + rMax) continue;
        const bucket = Math.round(sigma / SIGMA_QUANT);
        let kern = kernels.get(bucket);
        if (!kern) {
            kern = buildKernel(bucket * SIGMA_QUANT, cellSize, cellHeight, nx, nxny);
            kernels.set(bucket, kern);
        }

        const base = gx0 + nx * gy0 + nxny * gz0;
        const { dk, w, dx, dy, dz } = kern;
        // Fast path when the whole stamp is in-bounds (the common case, away from the
        // padded border): index by precomputed deltas, no per-tap bounds checks.
        if (
            gx0 - kern.rxv >= 0 &&
            gx0 + kern.rxv < nx &&
            gy0 - kern.ryv >= 0 &&
            gy0 + kern.ryv < ny &&
            gz0 - kern.rzv >= 0 &&
            gz0 + kern.rzv < nz
        ) {
            for (let t = 0; t < dk.length; t++) field[base + dk[t]] += op * w[t];
        } else {
            for (let t = 0; t < dk.length; t++) {
                const gx = gx0 + dx[t];
                if (gx < 0 || gx >= nx) continue;
                const gy = gy0 + dy[t];
                if (gy < 0 || gy >= ny) continue;
                const gz = gz0 + dz[t];
                if (gz < 0 || gz >= nz) continue;
                field[base + dk[t]] += op * w[t];
            }
        }
    }
    return field;
}

// --- Marching cubes lookup tables (Paul Bourke convention) ---
// Cube corner offsets, matching the edge/triangle tables below.
const CORNER: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
    [0, 1, 0],
    [1, 1, 0],
    [1, 1, 1],
    [0, 1, 1],
];
// The two corners each of the 12 edges connects.
const EDGE: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
];

// triTable[cubeindex] lists triangles as edge-index triples (empty = no surface).
// biome-ignore format: 256-row marching-cubes triangle table, kept compact
const TRI: ReadonlyArray<ReadonlyArray<number>> = [
    [], [0,8,3], [0,1,9], [1,8,3,9,8,1], [1,2,10], [0,8,3,1,2,10], [9,2,10,0,2,9], [2,8,3,2,10,8,10,9,8],
    [3,11,2], [0,11,2,8,11,0], [1,9,0,2,3,11], [1,11,2,1,9,11,9,8,11], [3,10,1,11,10,3], [0,10,1,0,8,10,8,11,10], [3,9,0,3,11,9,11,10,9], [9,8,10,10,8,11],
    [4,7,8], [4,3,0,7,3,4], [0,1,9,8,4,7], [4,1,9,4,7,1,7,3,1], [1,2,10,8,4,7], [3,4,7,3,0,4,1,2,10], [9,2,10,9,0,2,8,4,7], [2,10,9,2,9,7,2,7,3,7,9,4],
    [8,4,7,3,11,2], [11,4,7,11,2,4,2,0,4], [9,0,1,8,4,7,2,3,11], [4,7,11,9,4,11,9,11,2,9,2,1], [3,10,1,3,11,10,7,8,4], [1,11,10,1,4,11,1,0,4,7,11,4], [4,7,8,9,0,11,9,11,10,11,0,3], [4,7,11,4,11,9,9,11,10],
    [9,5,4], [9,5,4,0,8,3], [0,5,4,1,5,0], [8,5,4,8,3,5,3,1,5], [1,2,10,9,5,4], [3,0,8,1,2,10,4,9,5], [5,2,10,5,4,2,4,0,2], [2,10,5,3,2,5,3,5,4,3,4,8],
    [9,5,4,2,3,11], [0,11,2,0,8,11,4,9,5], [0,5,4,0,1,5,2,3,11], [2,1,5,2,5,8,2,8,11,4,8,5], [10,3,11,10,1,3,9,5,4], [4,9,5,0,8,1,8,10,1,8,11,10], [5,4,0,5,0,11,5,11,10,11,0,3], [5,4,8,5,8,10,10,8,11],
    [9,7,8,5,7,9], [9,3,0,9,5,3,5,7,3], [0,7,8,0,1,7,1,5,7], [1,5,3,3,5,7], [9,7,8,9,5,7,10,1,2], [10,1,2,9,5,0,5,3,0,5,7,3], [8,0,2,8,2,5,8,5,7,10,5,2], [2,10,5,2,5,3,3,5,7],
    [7,9,5,7,8,9,3,11,2], [9,5,7,9,7,2,9,2,0,2,7,11], [2,3,11,0,1,8,1,7,8,1,5,7], [11,2,1,11,1,7,7,1,5], [9,5,8,8,5,7,10,1,3,10,3,11], [5,7,0,5,0,9,7,11,0,1,0,10,11,10,0], [11,10,0,11,0,3,10,5,0,8,0,7,5,7,0], [11,10,5,7,11,5],
    [10,6,5], [0,8,3,5,10,6], [9,0,1,5,10,6], [1,8,3,1,9,8,5,10,6], [1,6,5,2,6,1], [1,6,5,1,2,6,3,0,8], [9,6,5,9,0,6,0,2,6], [5,9,8,5,8,2,5,2,6,3,2,8],
    [2,3,11,10,6,5], [11,0,8,11,2,0,10,6,5], [0,1,9,2,3,11,5,10,6], [5,10,6,1,9,2,9,11,2,9,8,11], [6,3,11,6,5,3,5,1,3], [0,8,11,0,11,5,0,5,1,5,11,6], [3,11,6,0,3,6,0,6,5,0,5,9], [6,5,9,6,9,11,11,9,8],
    [5,10,6,4,7,8], [4,3,0,4,7,3,6,5,10], [1,9,0,5,10,6,8,4,7], [10,6,5,1,9,7,1,7,3,7,9,4], [6,1,2,6,5,1,4,7,8], [1,2,5,5,2,6,3,0,4,3,4,7], [8,4,7,9,0,5,0,6,5,0,2,6], [7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],
    [3,11,2,7,8,4,10,6,5], [5,10,6,4,7,2,4,2,0,2,7,11], [0,1,9,4,7,8,2,3,11,5,10,6], [9,2,1,9,11,2,9,4,11,7,11,4,5,10,6], [8,4,7,3,11,5,3,5,1,5,11,6], [5,1,11,5,11,6,1,0,11,7,11,4,0,4,11], [0,5,9,0,6,5,0,3,6,11,6,3,8,4,7], [6,5,9,6,9,11,4,7,9,7,11,9],
    [10,4,9,6,4,10], [4,10,6,4,9,10,0,8,3], [10,0,1,10,6,0,6,4,0], [8,3,1,8,1,6,8,6,4,6,1,10], [1,4,9,1,2,4,2,6,4], [3,0,8,1,2,9,2,4,9,2,6,4], [0,2,4,4,2,6], [8,3,2,8,2,4,4,2,6],
    [10,4,9,10,6,4,11,2,3], [0,8,2,2,8,11,4,9,10,4,10,6], [3,11,2,0,1,6,0,6,4,6,1,10], [6,4,1,6,1,10,4,8,1,2,1,11,8,11,1], [9,6,4,9,3,6,9,1,3,11,6,3], [8,11,1,8,1,0,11,6,1,9,1,4,6,4,1], [3,11,6,3,6,0,0,6,4], [6,4,8,11,6,8],
    [7,10,6,7,8,10,8,9,10], [0,7,3,0,10,7,0,9,10,6,7,10], [10,6,7,1,10,7,1,7,8,1,8,0], [10,6,7,10,7,1,1,7,3], [1,2,6,1,6,8,1,8,9,8,6,7], [2,6,9,2,9,1,6,7,9,0,9,3,7,3,9], [7,8,0,7,0,6,6,0,2], [7,3,2,6,7,2],
    [2,3,11,10,6,8,10,8,9,8,6,7], [2,0,7,2,7,11,0,9,7,6,7,10,9,10,7], [1,8,0,1,7,8,1,10,7,6,7,10,2,3,11], [11,2,1,11,1,7,10,6,1,6,7,1], [8,9,6,8,6,7,9,1,6,11,6,3,1,3,6], [0,9,1,11,6,7], [7,8,0,7,0,6,3,11,0,11,6,0], [7,11,6],
    [7,6,11], [3,0,8,11,7,6], [0,1,9,11,7,6], [8,1,9,8,3,1,11,7,6], [10,1,2,6,11,7], [1,2,10,3,0,8,6,11,7], [2,9,0,2,10,9,6,11,7], [6,11,7,2,10,3,10,8,3,10,9,8],
    [7,2,3,6,2,7], [7,0,8,7,6,0,6,2,0], [2,7,6,2,3,7,0,1,9], [1,6,2,1,8,6,1,9,8,8,7,6], [10,7,6,10,1,7,1,3,7], [10,7,6,1,7,10,1,8,7,1,0,8], [0,3,7,0,7,10,0,10,9,6,10,7], [7,6,10,7,10,8,8,10,9],
    [6,8,4,11,8,6], [3,6,11,3,0,6,0,4,6], [8,6,11,8,4,6,9,0,1], [9,4,6,9,6,3,9,3,1,11,3,6], [6,8,4,6,11,8,2,10,1], [1,2,10,3,0,11,0,6,11,0,4,6], [4,11,8,4,6,11,0,2,9,2,10,9], [10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],
    [8,2,3,8,4,2,4,6,2], [0,4,2,4,6,2], [1,9,0,2,3,4,2,4,6,4,3,8], [1,9,4,1,4,2,2,4,6], [8,1,3,8,6,1,8,4,6,6,10,1], [10,1,0,10,0,6,6,0,4], [4,6,3,4,3,8,6,10,3,0,3,9,10,9,3], [10,9,4,6,10,4],
    [4,9,5,7,6,11], [0,8,3,4,9,5,11,7,6], [5,0,1,5,4,0,7,6,11], [11,7,6,8,3,4,3,5,4,3,1,5], [9,5,4,10,1,2,7,6,11], [6,11,7,1,2,10,0,8,3,4,9,5], [7,6,11,5,4,10,4,2,10,4,0,2], [3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],
    [7,2,3,7,6,2,5,4,9], [9,5,4,0,8,6,0,6,2,6,8,7], [3,6,2,3,7,6,1,5,0,5,4,0], [6,2,8,6,8,7,2,1,8,4,8,5,1,5,8], [9,5,4,10,1,6,1,7,6,1,3,7], [1,6,10,1,7,6,1,0,7,8,7,0,9,5,4], [4,0,10,4,10,5,0,3,10,6,10,7,3,7,10], [7,6,10,7,10,8,5,4,10,4,8,10],
    [6,9,5,6,11,9,11,8,9], [3,6,11,0,6,3,0,5,6,0,9,5], [0,11,8,0,5,11,0,1,5,5,6,11], [6,11,3,6,3,5,5,3,1], [1,2,10,9,5,11,9,11,8,11,5,6], [0,11,3,0,6,11,0,9,6,5,6,9,1,2,10], [11,8,5,11,5,6,8,0,5,10,5,2,0,2,5], [6,11,3,6,3,5,2,10,3,10,5,3],
    [5,8,9,5,2,8,5,6,2,3,8,2], [9,5,6,9,6,0,0,6,2], [1,5,8,1,8,0,5,6,8,3,8,2,6,2,8], [1,5,6,2,1,6], [1,3,6,1,6,10,3,8,6,5,6,9,8,9,6], [10,1,0,10,0,6,9,5,0,5,6,0], [0,3,8,5,6,10], [10,5,6],
    [11,5,10,7,5,11], [11,5,10,11,7,5,8,3,0], [5,11,7,5,10,11,1,9,0], [10,7,5,10,11,7,9,8,1,8,3,1], [11,1,2,11,7,1,7,5,1], [0,8,3,1,2,7,1,7,5,7,2,11], [9,7,5,9,2,7,9,0,2,2,11,7], [7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],
    [2,5,10,2,3,5,3,7,5], [8,2,0,8,5,2,8,7,5,10,2,5], [9,0,1,5,10,3,5,3,7,3,10,2], [9,8,2,9,2,1,8,7,2,10,2,5,7,5,2], [1,3,5,3,7,5], [0,8,7,0,7,1,1,7,5], [9,0,3,9,3,5,5,3,7], [9,8,7,5,9,7],
    [5,8,4,5,10,8,10,11,8], [5,0,4,5,11,0,5,10,11,11,3,0], [0,1,9,8,4,10,8,10,11,10,4,5], [10,11,4,10,4,5,11,3,4,9,4,1,3,1,4], [2,5,1,2,8,5,2,11,8,4,5,8], [0,4,11,0,11,3,4,5,11,2,11,1,5,1,11], [0,2,5,0,5,9,2,11,5,4,5,8,11,8,5], [9,4,5,2,11,3],
    [2,5,10,3,5,2,3,4,5,3,8,4], [5,10,2,5,2,4,4,2,0], [3,10,2,3,5,10,3,8,5,4,5,8,0,1,9], [5,10,2,5,2,4,1,9,2,9,4,2], [8,4,5,8,5,3,3,5,1], [0,4,5,1,0,5], [8,4,5,8,5,3,9,0,5,0,3,5], [9,4,5],
    [4,11,7,4,9,11,9,10,11], [0,8,3,4,9,7,9,11,7,9,10,11], [1,10,11,1,11,4,1,4,0,7,4,11], [3,1,4,3,4,8,1,10,4,7,4,11,10,11,4], [4,11,7,9,11,4,9,2,11,9,1,2], [9,7,4,9,11,7,9,1,11,2,11,1,0,8,3], [11,7,4,11,4,2,2,4,0], [11,7,4,11,4,2,8,3,4,3,2,4],
    [2,9,10,2,7,9,2,3,7,7,4,9], [9,10,7,9,7,4,10,2,7,8,7,0,2,0,7], [3,7,10,3,10,2,7,4,10,1,10,0,4,0,10], [1,10,2,8,7,4], [4,9,1,4,1,7,7,1,3], [4,9,1,4,1,7,0,8,1,8,7,1], [4,0,3,7,4,3], [4,8,7],
    [9,10,8,10,11,8], [3,0,9,3,9,11,11,9,10], [0,1,10,0,10,8,8,10,11], [3,1,10,11,3,10], [1,2,11,1,11,9,9,11,8], [3,0,9,3,9,11,1,2,9,2,11,9], [0,2,11,8,0,11], [3,2,11],
    [2,3,8,2,8,10,10,8,9], [9,10,2,0,9,2], [2,3,8,2,8,10,0,1,8,1,10,8], [1,10,2], [1,3,8,9,1,8], [0,9,1], [0,3,8], [],
];

// --- Brick acceleration ------------------------------------------------------------
// Splat scenes are sparse (surfaces are thin shells in a big volume), yet threshold/morph/
// blur/MC are O(volume). We tag occupied bricks during a single field scan, then run those
// passes over only the ACTIVE bricks (occupied + a small margin), touching ~active% of the
// cells. Dense arrays still back everything (trivial indexing) — we just skip empty bricks.
// Small bricks keep the margin tight (the active set hugs the surface) at a little more
// per-brick bookkeeping.
const BRICK = 8;
const BRICK_SHIFT = 3; // log2(BRICK)

/** Brick occupancy of a dense field: occ[brick]=1 if any cell in it is non-zero. */
export interface Occupancy {
    occ: Uint8Array;
    nbx: number;
    nby: number;
    nbz: number;
}

function buildOcc(field: Float32Array, nx: number, ny: number, nz: number): Occupancy {
    const nbx = Math.ceil(nx / BRICK);
    const nby = Math.ceil(ny / BRICK);
    const nbz = Math.ceil(nz / BRICK);
    const occ = new Uint8Array(nbx * nby * nbz);
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < field.length; k++) {
        if (field[k] > 0) occ[(x >> BRICK_SHIFT) + nbx * ((y >> BRICK_SHIFT) + nby * (z >> BRICK_SHIFT))] = 1;
        if (++x === nx) {
            x = 0;
            if (++y === ny) {
                y = 0;
                z++;
            }
        }
    }
    return { occ, nbx, nby, nbz };
}

interface Active {
    cells: Uint32Array; // linear indices of every cell in an active brick
    colKeys: Int32Array; // active brick-columns, packed bx + nbx*bz (for column passes)
    colYmin: Int32Array; // per brick-column: lowest / highest active brick-y
    colYmax: Int32Array;
    nbx: number;
}

/** Active brick set = occupancy dilated by `margin` bricks (Chebyshev), flattened to cells. */
function activeRegion(o: Occupancy, margin: number, nx: number, ny: number, nz: number): Active {
    const { occ, nbx, nby, nbz } = o;
    const act = new Uint8Array(occ.length);
    for (let bz = 0; bz < nbz; bz++) {
        for (let by = 0; by < nby; by++) {
            for (let bx = 0; bx < nbx; bx++) {
                if (!occ[bx + nbx * (by + nby * bz)]) continue;
                const z0 = Math.max(0, bz - margin);
                const z1 = Math.min(nbz - 1, bz + margin);
                const y0 = Math.max(0, by - margin);
                const y1 = Math.min(nby - 1, by + margin);
                const x0 = Math.max(0, bx - margin);
                const x1 = Math.min(nbx - 1, bx + margin);
                for (let z = z0; z <= z1; z++)
                    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) act[x + nbx * (y + nby * z)] = 1;
            }
        }
    }

    const nxny = nx * ny;
    let cellCount = 0;
    for (let i = 0; i < act.length; i++) cellCount += act[i];
    const cells = new Uint32Array(cellCount * BRICK * BRICK * BRICK);
    const colYmin = new Int32Array(nbx * nbz).fill(nby);
    const colYmax = new Int32Array(nbx * nbz).fill(-1);
    let n = 0;
    for (let bz = 0; bz < nbz; bz++) {
        for (let by = 0; by < nby; by++) {
            for (let bx = 0; bx < nbx; bx++) {
                if (!act[bx + nbx * (by + nby * bz)]) continue;
                const col = bx + nbx * bz;
                if (by < colYmin[col]) colYmin[col] = by;
                if (by > colYmax[col]) colYmax[col] = by;
                const xe = Math.min(nx, bx * BRICK + BRICK);
                const ye = Math.min(ny, by * BRICK + BRICK);
                const ze = Math.min(nz, bz * BRICK + BRICK);
                for (let z = bz * BRICK; z < ze; z++) {
                    for (let y = by * BRICK; y < ye; y++) {
                        const row = nx * y + nxny * z;
                        for (let x = bx * BRICK; x < xe; x++) cells[n++] = row + x;
                    }
                }
            }
        }
    }

    let colCount = 0;
    for (let c = 0; c < colYmax.length; c++) if (colYmax[c] >= 0) colCount++;
    const colKeys = new Int32Array(colCount);
    let ci = 0;
    for (let c = 0; c < colYmax.length; c++) if (colYmax[c] >= 0) colKeys[ci++] = c;

    return { cells: cells.subarray(0, n), colKeys, colYmin, colYmax, nbx };
}

/** Threshold over active cells → dense 0/1 occupancy (inactive cells stay 0). */
function bThreshold(field: Float32Array, active: Active, minValue: number): Uint8Array {
    const solid = new Uint8Array(field.length);
    const cells = active.cells;
    for (let i = 0; i < cells.length; i++) {
        const k = cells[i];
        if (field[k] >= minValue) solid[k] = 1;
    }
    return solid;
}

function bDilate(src: Uint8Array, active: Active, nx: number, ny: number, nz: number): Uint8Array {
    const out = new Uint8Array(src.length);
    const nxny = nx * ny;
    const cells = active.cells;
    for (let i = 0; i < cells.length; i++) {
        const k = cells[i];
        if (src[k]) {
            out[k] = 1;
            continue;
        }
        const x = k % nx;
        const t = (k / nx) | 0;
        const y = t % ny;
        const z = (t / ny) | 0;
        if (
            (x > 0 && src[k - 1]) ||
            (x < nx - 1 && src[k + 1]) ||
            (y > 0 && src[k - nx]) ||
            (y < ny - 1 && src[k + nx]) ||
            (z > 0 && src[k - nxny]) ||
            (z < nz - 1 && src[k + nxny])
        ) {
            out[k] = 1;
        }
    }
    return out;
}

function bErode(src: Uint8Array, active: Active, nx: number, ny: number, nz: number): Uint8Array {
    const out = new Uint8Array(src.length);
    const nxny = nx * ny;
    const cells = active.cells;
    for (let i = 0; i < cells.length; i++) {
        const k = cells[i];
        if (!src[k]) continue;
        const x = k % nx;
        const t = (k / nx) | 0;
        const y = t % ny;
        const z = (t / ny) | 0;
        if (
            x > 0 &&
            src[k - 1] &&
            x < nx - 1 &&
            src[k + 1] &&
            y > 0 &&
            src[k - nx] &&
            y < ny - 1 &&
            src[k + nx] &&
            z > 0 &&
            src[k - nxny] &&
            z < nz - 1 &&
            src[k + nxny]
        ) {
            out[k] = 1;
        }
    }
    return out;
}

/**
 * Fill enclosed vertical air-gaps ≤ maxGapVox tall, per active brick-column (scanning only
 * the active Y range). Solidifies thin captured slabs (floors/platforms/ceilings) while
 * leaving tall gaps (rooms) open. A gap counts only if capped by solid both below AND above.
 */
function bFillGaps(solid: Uint8Array, active: Active, nx: number, ny: number, nz: number, maxGapVox: number): void {
    const nxny = nx * ny;
    const { colKeys, colYmin, colYmax, nbx } = active;
    for (let ci = 0; ci < colKeys.length; ci++) {
        const col = colKeys[ci];
        const bx = col % nbx;
        const bz = (col / nbx) | 0;
        const yLo = colYmin[col] * BRICK;
        const yHi = Math.min(ny, (colYmax[col] + 1) * BRICK);
        const xe = Math.min(nx, bx * BRICK + BRICK);
        const ze = Math.min(nz, bz * BRICK + BRICK);
        for (let z = bz * BRICK; z < ze; z++) {
            for (let x = bx * BRICK; x < xe; x++) {
                const colBase = x + nxny * z;
                let y = yLo;
                while (y < yHi) {
                    if (solid[colBase + nx * y]) {
                        y++;
                        continue;
                    }
                    let e = y;
                    while (e < yHi && !solid[colBase + nx * e]) e++;
                    // capped below (y>yLo ⇒ solid[y-1]) AND above (e<yHi ⇒ solid[e]).
                    if (y > yLo && e < yHi && e - y <= maxGapVox) for (let f = y; f < e; f++) solid[colBase + nx * f] = 1;
                    y = e;
                }
            }
        }
    }
}

/** One separable [1,2,1]/4 blur pass over active cells (dense arrays, edge-clamped). */
function bBlur(src: Float32Array, active: Active, nx: number, ny: number, nz: number): Float32Array {
    const nxny = nx * ny;
    const cells = active.cells;
    const a = new Float32Array(src.length);
    const b = new Float32Array(src.length);
    for (let i = 0; i < cells.length; i++) {
        const k = cells[i];
        const x = k % nx;
        const l = x > 0 ? src[k - 1] : src[k];
        const r = x < nx - 1 ? src[k + 1] : src[k];
        a[k] = (l + 2 * src[k] + r) * 0.25;
    }
    for (let i = 0; i < cells.length; i++) {
        const k = cells[i];
        const y = ((k / nx) | 0) % ny;
        const l = y > 0 ? a[k - nx] : a[k];
        const r = y < ny - 1 ? a[k + nx] : a[k];
        b[k] = (l + 2 * a[k] + r) * 0.25;
    }
    for (let i = 0; i < cells.length; i++) {
        const k = cells[i];
        const z = (k / nxny) | 0;
        const l = z > 0 ? b[k - nxny] : b[k];
        const r = z < nz - 1 ? b[k + nxny] : b[k];
        a[k] = (l + 2 * b[k] + r) * 0.25;
    }
    return a;
}

/**
 * Marching cubes over active cells as cube bases (dense field reads; welded). Cubes are
 * emitted only in [xLo,xHi) × [zLo,zHi) so tiles emit just their CORE (default: whole grid).
 */
function bMarchingCubes(
    field: Float32Array,
    grid: VoxelGrid,
    isoLevel: number,
    active: Active,
    xLo = 0,
    xHi = grid.nx - 1,
    zLo = 0,
    zHi = grid.nz - 1,
): ColliderMesh {
    const { nx, ny, nz, cellSize, cellHeight, min } = grid;
    const nxny = nx * ny;
    const total = nx * ny * nz;
    const positions: number[] = [];
    const indices: number[] = [];
    const edgeVerts = new Map<number, number>();
    const cv = new Float64Array(8);
    const cx = new Int32Array(8);
    const cy = new Int32Array(8);
    const cz = new Int32Array(8);

    const vertexForEdge = (e: number): number => {
        const [a, b] = EDGE[e];
        const ax = cx[a];
        const ay = cy[a];
        const az = cz[a];
        const bx = cx[b];
        const by = cy[b];
        const bz = cz[b];
        const lx = Math.min(ax, bx);
        const ly = Math.min(ay, by);
        const lz = Math.min(az, bz);
        const axis = ax !== bx ? 0 : ay !== by ? 1 : 2;
        const key = axis * total + (lx + nx * (ly + ny * lz));
        const cached = edgeVerts.get(key);
        if (cached !== undefined) return cached;
        const t = (isoLevel - cv[a]) / (cv[b] - cv[a]);
        const vi = positions.length / 3;
        positions.push(
            min[0] + (ax + (bx - ax) * t) * cellSize,
            min[1] + (ay + (by - ay) * t) * cellHeight,
            min[2] + (az + (bz - az) * t) * cellSize,
        );
        edgeVerts.set(key, vi);
        return vi;
    };

    const cells = active.cells;
    for (let i = 0; i < cells.length; i++) {
        const base = cells[i];
        const x = base % nx;
        const t = (base / nx) | 0;
        const y = t % ny;
        const z = (t / ny) | 0;
        if (x >= nx - 1 || y >= ny - 1 || z >= nz - 1) continue;
        if (x < xLo || x >= xHi || z < zLo || z >= zHi) continue; // outside this tile's core
        let cubeindex = 0;
        for (let c = 0; c < 8; c++) {
            const px = x + CORNER[c][0];
            const py = y + CORNER[c][1];
            const pz = z + CORNER[c][2];
            const v = field[px + nx * py + nxny * pz];
            cv[c] = v;
            cx[c] = px;
            cy[c] = py;
            cz[c] = pz;
            if (v > isoLevel) cubeindex |= 1 << c;
        }
        if (cubeindex === 0 || cubeindex === 0xff) continue;
        const tris = TRI[cubeindex];
        for (let tt = 0; tt < tris.length; tt += 3) {
            indices.push(vertexForEdge(tris[tt]), vertexForEdge(tris[tt + 1]), vertexForEdge(tris[tt + 2]));
        }
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Bricks the shape passes must cover: occupancy plus the outward reach of dilate+blur+MC. */
function marginBricks(params: ColliderParams): number {
    return Math.max(1, Math.ceil((params.dilate + params.erode + params.blur + 1) / BRICK));
}

/**
 * Rasterise the cloud into a single dense field plus its brick occupancy (the expensive
 * step, and the ONLY one that depends on cellSize/cellHeight + coverage params). The tuning
 * tool caches this and reuses it via colliderFromField while tuning shape params. Throws if
 * the grid needs tiling (use generateCollider for that).
 */
export function rasterizeField(
    cloud: SplatInput,
    params: ColliderParams,
): { grid: VoxelGrid; field: Float32Array; occupancy: Occupancy } {
    const grid = makeGrid(cloud.positions, params.cellSize, params.cellHeight, cropBounds(params));
    if (grid.nx * grid.ny * grid.nz > DENSE_CAP) {
        throw new Error(`Grid ${grid.nx}×${grid.ny}×${grid.nz} exceeds the single-pass cap — call generateCollider (tiled).`);
    }
    const field = accumulateField(cloud, params, grid);
    return { grid, field, occupancy: buildOcc(field, grid.nx, grid.ny, grid.nz) };
}

/** Steps 2–4 over active bricks: threshold → morph → fillGaps → blur. Returns the active set too. */
function bFieldToSolid(
    field: Float32Array,
    grid: VoxelGrid,
    params: ColliderParams,
    occ: Occupancy,
): { solid: Uint8Array; blurred: Float32Array; active: Active } {
    const { nx, ny, nz, cellHeight } = grid;
    const active = activeRegion(occ, marginBricks(params), nx, ny, nz);
    let solid = bThreshold(field, active, params.densityThreshold);
    for (let i = 0; i < params.dilate; i++) solid = bDilate(solid, active, nx, ny, nz);
    for (let i = 0; i < params.erode; i++) solid = bErode(solid, active, nx, ny, nz);
    if (params.fillGaps) bFillGaps(solid, active, nx, ny, nz, Math.max(1, Math.round(params.maxGapFill / cellHeight)));

    const cells = active.cells;
    let blurred: Float32Array = new Float32Array(field.length);
    for (let i = 0; i < cells.length; i++) if (solid[cells[i]]) blurred[cells[i]] = 1;
    for (let i = 0; i < params.blur; i++) blurred = bBlur(blurred, active, nx, ny, nz);
    return { solid, blurred, active };
}

/**
 * Build the collider from a pre-accumulated field (steps 2–5), skipping empty bricks so
 * cost scales with the occupied surface, not the grid volume. Pass the cached `occupancy`
 * (from rasterizeField) to skip rebuilding it.
 */
export function colliderFromField(
    field: Float32Array,
    grid: VoxelGrid,
    params: ColliderParams,
    occupancy?: Occupancy,
    t0: number = now(),
): ColliderResult {
    const { nx, ny, nz } = grid;
    const occ = occupancy ?? buildOcc(field, nx, ny, nz);
    const { solid, blurred, active } = bFieldToSolid(field, grid, params, occ);
    let solidVoxels = 0;
    for (let i = 0; i < active.cells.length; i++) solidVoxels += solid[active.cells[i]];
    const blurredMesh = bMarchingCubes(blurred, grid, params.isoLevel, active);

    return {
        grid,
        solid,
        mesh: blurredMesh,
        stats: {
            numPoints: -1, // caller fills in (field carries no splat count)
            dims: [nx, ny, nz],
            solidVoxels,
            vertices: blurredMesh.positions.length / 3,
            triangles: blurredMesh.indices.length / 3,
            timeMs: now() - t0,
        },
    };
}

/**
 * Halo (overlap) each tile needs so its CORE is seam-exact. Every pass that reads
 * neighbours widens the dependency: rasterisation footprint (kernel radius), then dilate,
 * erode and blur (±1 each), plus 1 for the marching-cubes corner read. Computed for the
 * XZ (horizontal) axes, which is where we tile.
 */
function haloWidth(params: ColliderParams): number {
    let kernelR = 0;
    if (params.mode === 'coverage') {
        kernelR = Math.min(MAX_STAMP_RADIUS, Math.ceil((GAUSS_CUTOFF * params.maxRadius) / params.cellSize));
    }
    return kernelR + params.dilate + params.erode + params.blur + 1;
}

/** Optional progress reporter for long (tiled) bakes: (message, fraction in 0..1). */
export type ProgressFn = (message: string, fraction: number) => void;

/** Run the full splat-cloud → collision-mesh pipeline (single brick-accelerated grid, or tiled). */
export function generateCollider(cloud: SplatInput, params: ColliderParams, onProgress?: ProgressFn): ColliderResult {
    const t0 = now();
    const grid = makeGrid(cloud.positions, params.cellSize, params.cellHeight, cropBounds(params));
    if (grid.nx * grid.ny * grid.nz > DENSE_CAP) return generateTiled(cloud, params, grid, t0, onProgress);

    onProgress?.('rasterising', 0);
    const field = accumulateField(cloud, params, grid);
    const occupancy = buildOcc(field, grid.nx, grid.ny, grid.nz);
    onProgress?.('meshing', 0.5);
    const result = colliderFromField(field, grid, params, occupancy, t0);
    result.stats.numPoints = cloud.positions.length / 3;
    onProgress?.('done', 1);
    return result;
}

/**
 * Tiled path for grids that exceed DENSE_CAP: split the scene into XZ tiles (full-height
 * columns, so the column post-passes stay whole), brick-accelerate each tile (skips empty
 * bricks — crucially the tall empty vertical space), and marching-cubes only each tile's
 * CORE so the pieces tessellate without cracks. Empty tiles (no splats in reach) are
 * skipped outright. The full-grid solid is not materialised, so `result.solid` is empty.
 */
function generateTiled(
    cloud: SplatInput,
    params: ColliderParams,
    grid: VoxelGrid,
    t0: number,
    onProgress?: ProgressFn,
): ColliderResult {
    const { nx, ny, nz, cellSize, cellHeight, min } = grid;
    const H = haloWidth(params);

    // Pick a square-ish tile whose working volume (core + halo, full height) fits the budget.
    const maxFootprint = Math.floor(TILE_WORKING_CAP / ny);
    if (maxFootprint < (2 * H + 2) * (2 * H + 2)) {
        throw new Error(`Scene too tall to tile at this resolution (height ${ny} voxels). Increase cellHeight.`);
    }
    const coreSide = Math.max(1, Math.floor(Math.sqrt(maxFootprint)) - 2 * H);
    const tilesX = Math.ceil(nx / coreSide);
    const tilesZ = Math.ceil(nz / coreSide);

    // One O(splats) pass: which tiles contain any splat? A tile is worth processing if it or
    // an XZ neighbour has splats (a neighbour's splats can reach into this tile's halo).
    const hasSplat = new Uint8Array(tilesX * tilesZ);
    const positions0 = cloud.positions;
    const invCS = 1 / cellSize;
    for (let i = 0; i < positions0.length; i += 3) {
        const gx = Math.round((positions0[i] - min[0]) * invCS);
        const gz = Math.round((positions0[i + 2] - min[2]) * invCS);
        if (gx < 0 || gx >= nx || gz < 0 || gz >= nz) continue;
        hasSplat[Math.min(tilesX - 1, (gx / coreSide) | 0) + tilesX * Math.min(tilesZ - 1, (gz / coreSide) | 0)] = 1;
    }
    const tileActive = (tx: number, tz: number): boolean => {
        for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
                const x = tx + dx;
                const z = tz + dz;
                if (x >= 0 && x < tilesX && z >= 0 && z < tilesZ && hasSplat[x + tilesX * z]) return true;
            }
        return false;
    };

    const posChunks: Float32Array[] = [];
    const idxChunks: Uint32Array[] = [];
    let vertBase = 0;
    let solidVoxels = 0;
    const totalTiles = tilesX * tilesZ;
    let doneTiles = 0;

    for (let tz = 0; tz < tilesZ; tz++) {
        const cz0 = tz * coreSide;
        const cz1 = Math.min(nz, cz0 + coreSide);
        const wz0 = Math.max(0, cz0 - H);
        const wz1 = Math.min(nz, cz1 + H);
        const lnz = wz1 - wz0;
        for (let tx = 0; tx < tilesX; tx++) {
            doneTiles++;
            onProgress?.(`tile ${doneTiles}/${totalTiles}`, doneTiles / totalTiles);
            if (!tileActive(tx, tz)) continue; // empty region — nothing to mesh

            const cx0 = tx * coreSide;
            const cx1 = Math.min(nx, cx0 + coreSide);
            const wx0 = Math.max(0, cx0 - H);
            const wx1 = Math.min(nx, cx1 + H);
            const lnx = wx1 - wx0;

            const localGrid: VoxelGrid = {
                nx: lnx,
                ny,
                nz: lnz,
                cellSize,
                cellHeight,
                min: [min[0] + wx0 * cellSize, min[1], min[2] + wz0 * cellSize],
            };

            // CORE cube range in local coords (a cube's low corner in the core belongs here).
            const cubeXlo = cx0 - wx0;
            const cubeXhi = Math.min(cx1, nx - 1) - wx0;
            const cubeZlo = cz0 - wz0;
            const cubeZhi = Math.min(cz1, nz - 1) - wz0;

            const field = accumulateField(cloud, params, localGrid);
            const occ = buildOcc(field, lnx, ny, lnz);
            const { solid, blurred, active } = bFieldToSolid(field, localGrid, params, occ);
            const mesh = bMarchingCubes(blurred, localGrid, params.isoLevel, active, cubeXlo, cubeXhi, cubeZlo, cubeZhi);

            if (mesh.indices.length > 0) {
                const offset = mesh.indices.slice();
                for (let i = 0; i < offset.length; i++) offset[i] += vertBase;
                posChunks.push(mesh.positions);
                idxChunks.push(offset);
                vertBase += mesh.positions.length / 3;
            }

            // Count core solids (halo belongs to neighbours) from the active cells.
            const cells = active.cells;
            for (let i = 0; i < cells.length; i++) {
                const k = cells[i];
                const lx = k % lnx;
                const lz = (k / (lnx * ny)) | 0;
                if (lx >= cubeXlo && lx < cubeXhi + 1 && lz >= cubeZlo && lz < cubeZhi + 1) solidVoxels += solid[k];
            }
        }
    }

    const positions = concatFloat32(posChunks);
    const indices = concatUint32(idxChunks);
    return {
        grid,
        solid: new Uint8Array(0),
        mesh: { positions, indices },
        stats: {
            numPoints: cloud.positions.length / 3,
            dims: [nx, ny, nz],
            solidVoxels,
            vertices: positions.length / 3,
            triangles: indices.length / 3,
            timeMs: now() - t0,
        },
    };
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}

function concatUint32(chunks: Uint32Array[]): Uint32Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint32Array(total);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}
