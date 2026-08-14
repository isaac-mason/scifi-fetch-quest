/**
 * Build a compact collision mesh from the Spark collider GLB.
 *
 * Reads the collider .glb, extracts just world-space positions + triangle
 * indices via gltf-transform (dropping normals/uvs/materials/etc.), and packs
 * them into public/collider.bin using the shared packcat schema (collider-schema.ts).
 * The navmesh build (scripts/build-navmesh.ts) reads the .bin back with unpackCollider().
 * (The runtime loads the collider .glb directly — see src/collider-load.ts — not this .bin.)
 *
 * Usage:
 *   pnpm build:collider [input.glb] [output.bin]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { type Collider, packCollider } from '../src/collider-schema.ts';

const TRIANGLES = 4; // glTF primitive mode

const INPUT = process.argv[2] ?? 'assets/colliders.glb';
const OUTPUT = process.argv[3] ?? 'public/collider.bin';

async function main() {
    const io = new NodeIO();
    const doc = await io.read(resolve(INPUT));
    const root = doc.getRoot();

    const positionChunks: Float32Array[] = [];
    const indexChunks: Uint32Array[] = [];
    let vertBase = 0;

    for (const node of root.listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;

        // Bake the node's world transform into the positions so the collider
        // lines up with the splat in world space.
        const m = node.getWorldMatrix();

        for (const prim of mesh.listPrimitives()) {
            if (prim.getMode() !== TRIANGLES) {
                console.warn(`Skipping non-triangle primitive (mode ${prim.getMode()})`);
                continue;
            }

            const posAcc = prim.getAttribute('POSITION');
            if (!posAcc) continue;

            const src = posAcc.getArray();
            if (!src) continue;
            const count = posAcc.getCount();

            const world = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                const x = src[i * 3];
                const y = src[i * 3 + 1];
                const z = src[i * 3 + 2];
                world[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
                world[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                world[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            }
            positionChunks.push(world);

            const idxAcc = prim.getIndices();
            const indices = new Uint32Array(idxAcc ? idxAcc.getCount() : count);
            if (idxAcc) {
                const ia = idxAcc.getArray();
                if (!ia) continue;
                for (let i = 0; i < ia.length; i++) indices[i] = ia[i] + vertBase;
            } else {
                for (let i = 0; i < count; i++) indices[i] = vertBase + i;
            }
            indexChunks.push(indices);

            vertBase += count;
        }
    }

    const positions = concat(Float32Array, positionChunks);
    const indices = concat(Uint32Array, indexChunks);

    if (positions.length === 0) {
        throw new Error(`No triangle geometry found in ${INPUT}`);
    }

    const collider: Collider = { positions, indices };
    const bytes = packCollider(collider);

    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, bytes);

    console.log(`Wrote ${OUTPUT}: ${positions.length / 3} verts, ${indices.length / 3} tris, ${bytes.byteLength} bytes`);
}

type TypedArrayCtor<T> = { new (length: number): T; BYTES_PER_ELEMENT: number };

function concat<T extends Float32Array | Uint32Array>(Ctor: TypedArrayCtor<T>, chunks: T[]): T {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Ctor(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c as unknown as ArrayLike<number>, offset);
        offset += c.length;
    }
    return out;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
