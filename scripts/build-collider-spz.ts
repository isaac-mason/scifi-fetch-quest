/**
 * Bake a collision mesh straight from an SPZ splat cloud.
 *
 * Reads the .spz, rasterises the splats into a voxel grid (opacity-weighted footprints
 * by default), then marching-cubes a surface out of it (shared core:
 * src/collider/voxel-marching.ts) and packs the result into public/collider.bin with the
 * same packcat schema the browser reads back (src/collider-schema.ts).
 *
 * The parameters are inherently visual — tune them live in the browser tool
 * (collider.html), then pass the numbers you settled on here to bake the final .bin.
 *
 * Usage:
 *   pnpm build:collider [input.spz] [output.bin]
 *     [--cellSize 0.4] [--cellHeight 0.3] [--mode coverage|centers] [--density 2]
 *     [--iso 0.5] [--dilate 1] [--erode 1] [--blur 1]
 *     coverage-mode only: [--splatRadius 2] [--minRadius 0.15] [--maxRadius 1] [--minOpacity 0.3]
 *     fill hollow slabs: [--fillGaps true|false] [--maxGapFill 0.4]
 *     crop: [--bounds true|false] [--boundsMin x,y,z] [--boundsMax x,y,z]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseSpz } from '../src/collider/spz.ts';
import { type ColliderParams, DEFAULT_PARAMS, generateCollider } from '../src/collider/voxel-marching.ts';
import { type Collider, packCollider } from '../src/collider-schema.ts';

// Positional args come before flags; collect flags (--key value) separately.
const argv = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
        continue; // skip the npm/pnpm arg separator
    }
    if (a.startsWith('--')) {
        flags.set(a.slice(2), argv[++i]);
    } else {
        positional.push(a);
    }
}

const INPUT = positional[0] ?? 'assets/scifi_world.spz';
const OUTPUT = positional[1] ?? 'public/collider.bin';

const num = (key: string, fallback: number): number => {
    const v = flags.get(key);
    return v === undefined ? fallback : Number(v);
};

// Parse "x,y,z" into a Vec3, e.g. --boundsMin -59,-2,-36
const vec3 = (key: string, fallback: [number, number, number]): [number, number, number] => {
    const v = flags.get(key);
    if (v === undefined) return fallback;
    const p = v.split(',').map(Number);
    if (p.length !== 3 || p.some(Number.isNaN)) throw new Error(`--${key} must be "x,y,z", got '${v}'`);
    return [p[0], p[1], p[2]];
};

const mode = flags.get('mode') ?? DEFAULT_PARAMS.mode;
if (mode !== 'centers' && mode !== 'coverage') {
    throw new Error(`--mode must be 'centers' or 'coverage', got '${mode}'`);
}

const params: ColliderParams = {
    cellSize: num('cellSize', DEFAULT_PARAMS.cellSize),
    cellHeight: num('cellHeight', DEFAULT_PARAMS.cellHeight),
    mode,
    densityThreshold: num('density', DEFAULT_PARAMS.densityThreshold),
    splatRadius: num('splatRadius', DEFAULT_PARAMS.splatRadius),
    minRadius: num('minRadius', DEFAULT_PARAMS.minRadius),
    maxRadius: num('maxRadius', DEFAULT_PARAMS.maxRadius),
    minOpacity: num('minOpacity', DEFAULT_PARAMS.minOpacity),
    dilate: num('dilate', DEFAULT_PARAMS.dilate),
    erode: num('erode', DEFAULT_PARAMS.erode),
    fillGaps: flags.has('fillGaps') ? flags.get('fillGaps') !== 'false' : DEFAULT_PARAMS.fillGaps,
    maxGapFill: num('maxGapFill', DEFAULT_PARAMS.maxGapFill),
    blur: num('blur', DEFAULT_PARAMS.blur),
    isoLevel: num('iso', DEFAULT_PARAMS.isoLevel),
    boundsEnabled: flags.has('bounds') ? flags.get('bounds') !== 'false' : DEFAULT_PARAMS.boundsEnabled,
    boundsMin: vec3('boundsMin', DEFAULT_PARAMS.boundsMin),
    boundsMax: vec3('boundsMax', DEFAULT_PARAMS.boundsMax),
};

async function main() {
    console.log(`Reading splats from ${INPUT}`);
    const bytes = new Uint8Array(await readFile(resolve(INPUT)));
    const cloud = await parseSpz(bytes);
    console.log(`  ${cloud.numPoints.toLocaleString()} splats`);

    console.log(`Generating collider with`, params);
    let lastLog = 0;
    const { mesh, stats } = generateCollider(cloud, params, (msg, frac) => {
        // Throttle so per-tile updates don't spam; always show the first/last.
        const t = Date.now();
        if (t - lastLog < 500 && frac < 1 && frac > 0) return;
        lastLog = t;
        process.stdout.write(`\r  ${msg} — ${(frac * 100).toFixed(0)}%          `);
    });
    process.stdout.write('\n');
    console.log(
        `  grid ${stats.dims.join('×')}, ${stats.solidVoxels.toLocaleString()} solid voxels → ` +
            `${stats.vertices.toLocaleString()} verts / ${stats.triangles.toLocaleString()} tris in ${stats.timeMs.toFixed(0)}ms`,
    );

    if (mesh.positions.length === 0) {
        throw new Error('Collider is empty — lower --density or --iso, or shrink cell sizes.');
    }

    const collider: Collider = { positions: mesh.positions, indices: mesh.indices };
    const packed = packCollider(collider);

    await mkdir(dirname(resolve(OUTPUT)), { recursive: true });
    await writeFile(resolve(OUTPUT), packed);
    console.log(`Wrote ${OUTPUT}: ${packed.byteLength.toLocaleString()} bytes`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
