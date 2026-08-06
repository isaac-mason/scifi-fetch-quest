/**
 * Build a solo navmesh from the Spark collider GLB, then FLOOD-FILL PRUNE it.
 *
 * Reads the collider .glb, extracts world-space walkable geometry via
 * gltf-transform, generates a solo navmesh with navcat, then keeps only the polys
 * reachable (by navmesh adjacency) from the poly nearest a seed point — every
 * unreachable poly is physically removed from what we save. This drops disconnected
 * islands (floaters, sealed-off voids, the exterior hull shell) so the runtime only
 * loads the one connected walkable volume the player actually occupies.
 *
 * The prune (sanitizeTilePolys / pruneNavMesh) follows navcat's flood-fill-pruning
 * example and uses only the public navcat API. The tile (+ origin / tile size) is
 * written to public/navmesh.json; the browser rebuilds the NavMesh in
 * src/navigation.ts.
 *
 * Usage:
 *   pnpm build:navmesh [input.glb] [output.json] [seedX] [seedY] [seedZ]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import {
    addTile,
    buildTile,
    createFindNearestPolyResult,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    type NavMesh,
    type NavMeshPoly,
    type NavMeshPolyDetail,
    type NavMeshTile,
    type NavMeshTileParams,
    type NodeRef,
    POLY_NEIS_FLAG_EXT_LINK,
    type Vec3,
} from 'navcat';
import { floodFillNavMesh, generateSoloNavMesh, type SoloNavMeshOptions } from 'navcat/blocks';
import { unpackCollider } from '../src/collider-schema.ts';

// Accepts the packed collider (public/collider.bin, world-space positions+indices) or a
// GLB. The .spz → collider pipeline (scripts/build-collider-spz.ts) writes the .bin.
const INPUT = process.argv[2] ?? 'public/collider.bin';
const OUTPUT = process.argv[3] ?? 'public/navmesh.json';

// Prune seed: keep only polys reachable from the poly nearest this world point.
// It must sit on the connected walkable area you want to keep (the playable deck).
// Kept in sync with CHARACTER_SPAWN in src/scene.ts (where the player actually stands).
const SEED: Vec3 = [3, 1, -14];
// Search box for snapping the seed onto a poly (world units). Generous in Y so the
// seed height doesn't have to be exact.
const SEED_HALF_EXTENTS: Vec3 = [1, 4, 1];

/* -------------------------------------------------------------------------- */
/*  Flood-fill prune: keep only polys reachable from the seed.                 */
/*  Copied from navcat's example-flood-fill-pruning (public API only).         */
/* -------------------------------------------------------------------------- */

/**
 * Produces sanitized params for `tile` containing only the polys whose
 * `keep[polyIndex]` is true. Removed polys are physically dropped: vertices,
 * detail meshes and adjacency are compacted and made internally consistent.
 * Portal edges (links to adjacent tiles) are preserved and re-stitched when the
 * tile is added back to a navmesh. Returns `null` if no polys survive.
 */
function sanitizeTilePolys(tile: NavMeshTile, keep: boolean[]): NavMeshTileParams | null {
    const polyRemap = new Array<number>(tile.polys.length).fill(-1);
    const survivors: number[] = [];
    for (let i = 0; i < tile.polys.length; i++) {
        if (keep[i]) {
            polyRemap[i] = survivors.length;
            survivors.push(i);
        }
    }
    if (survivors.length === 0) return null;

    const vertexRemap = new Map<number, number>();
    const vertices: number[] = [];
    const remapVertex = (oldVert: number): number => {
        let newVert = vertexRemap.get(oldVert);
        if (newVert === undefined) {
            newVert = vertices.length / 3;
            vertexRemap.set(oldVert, newVert);
            vertices.push(tile.vertices[oldVert * 3], tile.vertices[oldVert * 3 + 1], tile.vertices[oldVert * 3 + 2]);
        }
        return newVert;
    };

    const polys: NavMeshPoly[] = [];
    const detailMeshes: NavMeshPolyDetail[] = [];
    const detailVertices: number[] = [];
    const detailTriangles: number[] = [];

    for (const oldPoly of survivors) {
        const poly = tile.polys[oldPoly];

        polys.push({
            vertices: poly.vertices.map(remapVertex),
            neis: poly.neis.map((nei) => {
                if (nei === 0) return 0; // boundary edge
                if (nei & POLY_NEIS_FLAG_EXT_LINK) return nei; // portal to adjacent tile
                const newNeighbour = polyRemap[nei - 1]; // internal edge (1-based)
                return newNeighbour === -1 ? 0 : newNeighbour + 1; // removed neighbour -> boundary
            }),
            flags: poly.flags,
            area: poly.area,
        });

        // detail triangle indices are poly-local, so they stay valid; only the base
        // offsets change.
        const detail = tile.detailMeshes[oldPoly];
        const verticesBase = detailVertices.length / 3;
        const trianglesBase = detailTriangles.length / 4;

        for (let v = 0; v < detail.verticesCount; v++) {
            const src = (detail.verticesBase + v) * 3;
            detailVertices.push(tile.detailVertices[src], tile.detailVertices[src + 1], tile.detailVertices[src + 2]);
        }
        for (let t = 0; t < detail.trianglesCount; t++) {
            const src = (detail.trianglesBase + t) * 4;
            detailTriangles.push(
                tile.detailTriangles[src],
                tile.detailTriangles[src + 1],
                tile.detailTriangles[src + 2],
                tile.detailTriangles[src + 3],
            );
        }

        detailMeshes.push({
            verticesBase,
            verticesCount: detail.verticesCount,
            trianglesBase,
            trianglesCount: detail.trianglesCount,
        });
    }

    return {
        tileX: tile.tileX,
        tileY: tile.tileY,
        tileLayer: tile.tileLayer,
        bounds: [...tile.bounds] as NavMeshTileParams['bounds'],
        vertices,
        polys,
        detailMeshes,
        detailVertices,
        detailTriangles,
        cellSize: tile.cellSize,
        cellHeight: tile.cellHeight,
        walkableHeight: tile.walkableHeight,
        walkableRadius: tile.walkableRadius,
        walkableClimb: tile.walkableClimb,
    };
}

/**
 * Re-assembles a brand-new navmesh containing only the polys whose node ref is in
 * `keep`; every other poly is pruned. `addTile` rebuilds the internal + cross-tile
 * portal links from scratch.
 */
function pruneNavMesh(navMesh: NavMesh, keep: Set<NodeRef>): NavMesh {
    const result = createNavMesh();
    result.origin = [...navMesh.origin] as Vec3;
    result.tileWidth = navMesh.tileWidth;
    result.tileHeight = navMesh.tileHeight;

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        const keepPoly = tile.polyNodes.map((nodeIndex) => keep.has(navMesh.nodes[nodeIndex].ref));
        const params = sanitizeTilePolys(tile, keepPoly);
        if (params) addTile(result, buildTile(params));
    }

    return result;
}

function countPolys(navMesh: NavMesh): number {
    let count = 0;
    for (const tileId in navMesh.tiles) count += navMesh.tiles[tileId].polys.length;
    return count;
}

async function main() {
    /* read input mesh (world-space positions + indices) */

    console.log('Reading walkable mesh from', INPUT);
    const positions: number[] = [];
    const indices: number[] = [];

    if (INPUT.endsWith('.bin')) {
        // Packed collider (world-space positions + triangle indices).
        const collider = unpackCollider(new Uint8Array(await readFile(resolve(INPUT))));
        for (let i = 0; i < collider.positions.length; i++) positions.push(collider.positions[i]);
        for (let i = 0; i < collider.indices.length; i++) indices.push(collider.indices[i]);
    } else {
        const io = new NodeIO();
        const doc = await io.read(resolve(INPUT));
        const root = doc.getRoot();
        for (const node of root.listNodes()) {
            const mesh = node.getMesh();
            if (!mesh) continue;

            // Bake the node's world transform so the navmesh lines up with the splat
            // and the physics collider (which bakes transforms the same way).
            const m = node.getWorldMatrix();

            for (const prim of mesh.listPrimitives()) {
                const posAccessor = prim.getAttribute('POSITION');
                const indexAccessor = prim.getIndices();
                if (!posAccessor || !indexAccessor) continue;

                const baseVertex = positions.length / 3;

                const src = posAccessor.getArray();
                if (!src) continue;
                for (let i = 0; i < posAccessor.getCount(); i++) {
                    const x = src[i * 3];
                    const y = src[i * 3 + 1];
                    const z = src[i * 3 + 2];
                    positions.push(m[0] * x + m[4] * y + m[8] * z + m[12]);
                    positions.push(m[1] * x + m[5] * y + m[9] * z + m[13]);
                    positions.push(m[2] * x + m[6] * y + m[10] * z + m[14]);
                }

                const idx = indexAccessor.getArray();
                if (!idx) continue;
                for (let i = 0; i < idx.length; i++) {
                    indices.push(idx[i] + baseVertex);
                }
            }
        }
    }

    console.log(`  ${positions.length / 3} vertices, ${indices.length / 3} triangles`);

    /* generate solo navmesh */

    const cs = 0.04;
    const ch = 0.02;

    const walkableRadiusWorld = 0.2;
    // Match the character's stair step-up (walkStairsStepUp = 0.4 in src/character.ts) so
    // the navmesh connects the same ledges the player can walk up, not fewer.
    const walkableClimbWorld = 0.2;
    const walkableHeightWorld = 1;

    const options: SoloNavMeshOptions = {
        cellSize: cs,
        cellHeight: ch,
        walkableRadiusVoxels: Math.ceil(walkableRadiusWorld / cs),
        walkableRadiusWorld,
        walkableClimbVoxels: Math.ceil(walkableClimbWorld / ch),
        walkableClimbWorld,
        walkableHeightVoxels: Math.ceil(walkableHeightWorld / ch),
        walkableHeightWorld,
        walkableSlopeAngleDegrees: 70,
        borderSize: 1,
        minRegionArea: 8,
        mergeRegionArea: 20,
        maxSimplificationError: 1,
        maxEdgeLength: 12,
        maxVerticesPerPoly: 6,
        detailSampleDistance: 6,
        detailSampleMaxError: 1,
    };

    console.log('Generating solo navmesh...');
    const { navMesh } = generateSoloNavMesh({ positions, indices }, options);

    /* flood-fill prune: keep only what's reachable from the seed poly. If the seed
       can't snap (e.g. moved off the deck), keep the full navmesh rather than fail. */

    const PRUNE = true;
    const beforePolys = countPolys(navMesh);
    const seedResult = findNearestPoly(createFindNearestPolyResult(), navMesh, SEED, SEED_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    let pruned = navMesh;
    if (PRUNE && !seedResult.success) {
        console.warn(
            `Prune seed [${SEED.join(', ')}] snapped to no poly within ±[${SEED_HALF_EXTENTS.join(', ')}] — ` +
                'keeping the full navmesh (unpruned). Move the seed onto the walkable deck to prune.',
        );
    } else if (PRUNE) {
        const { reachable } = floodFillNavMesh(navMesh, [seedResult.nodeRef]);
        pruned = pruneNavMesh(navMesh, new Set(reachable));
        console.log(
            `Pruned from seed [${SEED.join(', ')}] (poly ${seedResult.nodeRef}): ` +
                `polys ${beforePolys} -> ${countPolys(pruned)} (removed ${beforePolys - countPolys(pruned)}), ` +
                `tiles ${Object.keys(navMesh.tiles).length} -> ${Object.keys(pruned.tiles).length}`,
        );
    }
    const afterPolys = countPolys(pruned);

    /* write result to file */

    const tiles = Object.values(pruned.tiles);
    const result = {
        origin: pruned.origin,
        tileWidth: pruned.tileWidth,
        tileHeight: pruned.tileHeight,
        tiles,
    };

    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, JSON.stringify(result));

    console.log(`Wrote ${OUTPUT}: ${tiles.length} tiles, ${afterPolys} polys`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
