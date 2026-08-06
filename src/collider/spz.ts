/**
 * Minimal SPZ (Niantic Gaussian-splat) reader — the fields the collider pipeline needs.
 *
 * We roll our own tiny parser (rather than pulling in a splat library) because the
 * collider only cares about where the scene is solid: splat CENTRES, plus — for the
 * opacity-weighted "coverage" rasteriser (see ./voxel-marching.ts) — each splat's SIZE
 * and OPACITY. Colour, spherical harmonics and rotation are irrelevant and skipped.
 *
 * The same function runs in Node (the CLI) and the browser (the tuning tool): gzip is
 * handled by the global `DecompressionStream`, present in Node ≥18 and every modern
 * browser, so this file has zero dependencies and no environment branches.
 *
 * Format (SPZ v3, https://github.com/nianticlabs/spz): a gzip stream wrapping a 16-byte
 * header followed by struct-of-arrays splat data. Header:
 *   u32 magic (0x5053474e "NGSP") · u32 version · u32 numPoints ·
 *   u8 shDegree · u8 fractionalBits · u8 flags · u8 reserved
 * Then, for N points (offsets verified against a reference decoder for this v3 file):
 *   positions  @16       9 bytes/pt  — xyz, each a 24-bit LE signed fixed-point value
 *                                       with `fractionalBits` fractional bits
 *   opacity    @16+9N    1 byte/pt   — linear alpha = byte/255
 *   colour     @16+10N   3 bytes/pt  — (skipped)
 *   scale      @16+13N   3 bytes/pt  — per-axis LOG scale; linear = exp(byte/16 − 10)
 *   rotation   @16+16N   4 bytes/pt  — (skipped; nonstandard v3 quaternion packing)
 *
 * Positions are decoded in the file's native axes (right/up/back — the same convention
 * three.js and Spark render in), NOT flipped to the PLY/RDF convention some tools use.
 */

const SPZ_MAGIC = 0x5053474e; // "NGSP", little-endian

export interface SplatCloud {
    /** Number of splats. */
    numPoints: number;
    /** Splat centres as flat xyz triples in the file's world units (length numPoints*3). */
    positions: Float32Array;
    /** Per-splat footprint radius: the largest of the 3 axis scales, in world units (length numPoints). */
    scales: Float32Array;
    /** Per-splat linear opacity in [0,1] (length numPoints). */
    opacities: Float32Array;
}

/** True if the buffer starts with the gzip magic (0x1f 0x8b). */
function isGzip(bytes: Uint8Array): boolean {
    return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse an SPZ file (gzip-compressed or already inflated) into splat centres, footprint
 * radii and opacities.
 */
export async function parseSpz(bytes: Uint8Array): Promise<SplatCloud> {
    const raw = isGzip(bytes) ? await gunzip(bytes) : bytes;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    const magic = dv.getUint32(0, true);
    if (magic !== SPZ_MAGIC) {
        throw new Error(`Not an SPZ file: magic 0x${magic.toString(16)} (expected 0x${SPZ_MAGIC.toString(16)})`);
    }
    const numPoints = dv.getUint32(8, true);
    const fractionalBits = raw[13];

    // Block offsets within the struct-of-arrays payload.
    const posOff = 16;
    const opacityOff = posOff + numPoints * 9;
    const scaleOff = opacityOff + numPoints * 4; // after opacity (1B) + colour (3B)
    const end = scaleOff + numPoints * 3;
    if (end > raw.length) {
        throw new Error(`SPZ truncated: expected ≥ ${end} bytes for ${numPoints} points, got ${raw.length}`);
    }

    const invScale = 1 / (1 << fractionalBits);
    const positions = new Float32Array(numPoints * 3);
    const scales = new Float32Array(numPoints);
    const opacities = new Float32Array(numPoints);

    for (let i = 0; i < numPoints; i++) {
        // Position: three 24-bit LE signed fixed-point values.
        const p = posOff + i * 9;
        for (let j = 0; j < 3; j++) {
            const o = p + j * 3;
            let v = raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16);
            if (v & 0x800000) v |= ~0xffffff; // sign-extend 24→32
            positions[i * 3 + j] = v * invScale;
        }

        opacities[i] = raw[opacityOff + i] / 255;

        // Footprint radius = largest of the 3 axis scales (linear = exp(byte/16 − 10)).
        const s = scaleOff + i * 3;
        let maxLog = raw[s];
        if (raw[s + 1] > maxLog) maxLog = raw[s + 1];
        if (raw[s + 2] > maxLog) maxLog = raw[s + 2];
        scales[i] = Math.exp(maxLog / 16 - 10);
    }

    return { numPoints, positions, scales, opacities };
}
