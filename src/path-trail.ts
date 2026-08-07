import type { Vec3 } from 'mathcat';
import * as THREE from 'three';

// A guide ribbon to the current objective: a flat strip along the navcat route, stamped with
// chevrons that scroll toward the goal. The route is recomputed every frame (so the ribbon tracks
// the player continuously), but the CHEVRON PLACEMENT is anchored to world space so individual
// chevrons hold their spot instead of jumping around as the path re-solves. Three things make that
// work:
//   1. resamplePath samples from the GOAL end → each sample sits at a fixed arc-length from the
//      (world-fixed) goal, so the sample positions are stable frame to frame.
//   2. UVs are anchored to the goal (v = -distance-to-goal / tile), so a chevron lands on a fixed
//      world position independent of the path's length or where the player end currently is.
//   3. Points are lightly eased frame-to-frame to absorb findPath's corner jitter.
//
// Chevrons are an ALPHA-CUTOUT texture (alphaTest, not blending): the gaps are discarded and the
// arrows write depth, so it stays crisp against the Gaussian splats.

const SAMPLE_SPACING = 0.3; // metres between centerline samples (denser = smoother ribbon)
const RIBBON_HALF = 0.075; // metres — half the ribbon width
const LIFT = 0.22; // metres above the floor
const MAX_POINTS = 160; // centerline samples cap (⇒ 2× verts, (n-1)×6 indices)
const CHEVRON_LEN = 0.85; // metres of path per chevron tile
const SCROLL = 0.8; // chevron tiles/sec scrolling toward the goal
const CHAIKIN_ITERS = 2; // corner-rounding passes (kills polygonal kinks in the navcat path)
const EASE = 0.3; // per-frame easing toward the fresh path (soaks up findPath jitter; 1 = none)
const FADE_LEN = 1.3; // metres over which each end dithers out (0 at the very tip → 1 by here)

export type PathTrail = {
    mesh: THREE.Mesh;
    geo: THREE.BufferGeometry;
    pos: THREE.BufferAttribute;
    uv: THREE.BufferAttribute;
    fade: THREE.BufferAttribute; // 1 in the body → 0 at each end; dithered in the shader
    tex: THREE.CanvasTexture;
    sampled: Vec3[]; // eased centerline actually rendered
};

// A single chevron ("^", pointing toward +v = toward the goal) drawn white-on-transparent, tiled
// along the ribbon's length. Alpha carries the shape; alphaTest cuts the gaps.
function makeChevronTexture(): THREE.CanvasTexture {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, S, S);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = S * 0.13; // thinner = more minimal
    ctx.lineCap = 'butt'; // sharp, square ends
    ctx.lineJoin = 'miter'; // crisp pointed tip
    ctx.miterLimit = 6;
    // Canvas y is down; CanvasTexture flips Y, so a smaller canvas-y ends up at a higher v.
    ctx.beginPath();
    ctx.moveTo(S * 0.16, S * 0.62); // left wing (low v)
    ctx.lineTo(S * 0.5, S * 0.34); // tip (high v → points at goal)
    ctx.lineTo(S * 0.84, S * 0.62); // right wing
    ctx.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8; // reduce edge shimmer/crawl on the moving cutout at grazing angles
    return tex;
}

export function createPathTrail(scene: THREE.Scene): PathTrail {
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3);
    const uv = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * 2), 2);
    const fade = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2), 1);
    pos.setUsage(THREE.DynamicDrawUsage);
    uv.setUsage(THREE.DynamicDrawUsage);
    fade.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('uv', uv);
    geo.setAttribute('fade', fade);

    // Static index buffer — a quad (two tris) between each pair of adjacent centerline samples.
    const idx = new Uint16Array((MAX_POINTS - 1) * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++) {
        const a = i * 2; // left  of sample i
        const b = i * 2 + 1; // right of sample i
        const c = a + 2; // left  of sample i+1
        const d = a + 3; // right of sample i+1
        const o = i * 6;
        idx[o] = a;
        idx[o + 1] = b;
        idx[o + 2] = c;
        idx[o + 3] = c;
        idx[o + 4] = b;
        idx[o + 5] = d;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);

    const tex = makeChevronTexture();
    const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xffffff,
        side: THREE.DoubleSide,
        alphaTest: 0.5, // cutout: discard the gaps, keep the arrows opaque + depth-writing
        depthWrite: true,
        depthTest: true,
    });
    // Dither the ends out WITHOUT transparency: an ordered (screen-door) discard keyed to the per-
    // vertex `fade` (1 in the body → 0 at the tips). Surviving pixels stay fully opaque + depth-
    // writing (so no splat-blending issues); the ends just dissolve pixel-by-pixel. Interleaved
    // gradient noise (Jimenez) is the dither threshold — cheap, stable, no lookup table.
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float fade;\nvarying float vFade;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFade = fade;');
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                '#include <common>\nvarying float vFade;\nfloat _ign(vec2 p){return fract(52.9829189189*fract(dot(p,vec2(0.06711056,0.00583715))));}',
            )
            .replace(
                '#include <alphatest_fragment>',
                '#include <alphatest_fragment>\n  if (vFade < _ign(gl_FragCoord.xy)) discard;',
            );
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, geo, pos, uv, fade, tex, sampled: [] };
}

// Chaikin corner-cutting — rounds the polygonal navcat path so the ribbon flows through corners
// instead of kinking. Endpoints (player + goal) are preserved.
function chaikin(pts: Vec3[], iters: number): Vec3[] {
    let cur = pts;
    for (let it = 0; it < iters && cur.length >= 3; it++) {
        const next: Vec3[] = [cur[0]];
        for (let i = 0; i < cur.length - 1; i++) {
            const a = cur[i];
            const b = cur[i + 1];
            next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2] * 0.75 + b[2] * 0.25]);
            next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, a[2] * 0.25 + b[2] * 0.75]);
        }
        next.push(cur[cur.length - 1]);
        cur = next;
    }
    return cur;
}

// Resample a (Chaikin-smoothed) corner path into evenly spaced points, sampling from the GOAL end
// so each sample sits at a fixed arc-length from the goal → world-stable positions frame to frame.
// The leftover partial step lands at the player end (under your feet). Output is ordered
// player → goal. The caller grounds these before handing them to setPathTrail.
export function resamplePath(corners: Vec3[]): Vec3[] {
    if (corners.length === 0) return [];
    const rev = chaikin(corners, CHAIKIN_ITERS).reverse(); // goal → player
    const out: Vec3[] = [[rev[0][0], rev[0][1], rev[0][2]]]; // goal
    let carry = 0; // leftover distance from the previous segment
    for (let i = 1; i < rev.length && out.length < MAX_POINTS; i++) {
        const a = rev[i - 1];
        const b = rev[i];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const dz = b[2] - a[2];
        const segLen = Math.hypot(dx, dy, dz) || 1e-6;
        let d = SAMPLE_SPACING - carry;
        while (d < segLen && out.length < MAX_POINTS) {
            const t = d / segLen;
            out.push([a[0] + dx * t, a[1] + dy * t, a[2] + dz * t]);
            d += SAMPLE_SPACING;
        }
        carry = (carry + segLen) % SAMPLE_SPACING;
    }
    const player = rev[rev.length - 1];
    const tail = out[out.length - 1];
    if (out.length < MAX_POINTS && Math.hypot(player[0] - tail[0], player[1] - tail[1], player[2] - tail[2]) > 0.05) {
        out.push([player[0], player[1], player[2]]);
    }
    return out.reverse(); // player → goal
}

// Called every frame with the fresh (grounded) centerline. Eases toward it — aligned from the GOAL
// end so each eased point tracks the same world spot — then rebuilds the ribbon geometry with
// goal-anchored UVs so the chevrons hold their world positions.
export function setPathTrail(trail: PathTrail, points: Vec3[]): void {
    const prev = trail.sampled;
    const eased: Vec3[] = points.map((p) => [p[0], p[1], p[2]] as Vec3);
    const m = Math.min(eased.length, prev.length);
    for (let k = 0; k < m; k++) {
        const a = eased[eased.length - 1 - k]; // from the goal end
        const b = prev[prev.length - 1 - k];
        a[0] = b[0] + (a[0] - b[0]) * EASE;
        a[1] = b[1] + (a[1] - b[1]) * EASE;
        a[2] = b[2] + (a[2] - b[2]) * EASE;
    }
    trail.sampled = eased;

    const n = Math.min(eased.length, MAX_POINTS);
    if (n < 2) {
        hidePathTrail(trail);
        return;
    }

    const posArr = trail.pos.array as Float32Array;
    const uvArr = trail.uv.array as Float32Array;
    const fadeArr = trail.fade.array as Float32Array;

    // Total arc-length up front so UVs can be anchored to the GOAL end (v = -distance-to-goal / tile).
    // A given world point keeps the same v as the path re-solves, so its chevron doesn't jump.
    let total = 0;
    for (let i = 1; i < n; i++) {
        const a = eased[i - 1];
        const b = eased[i];
        total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }

    let dist = 0; // cumulative arc-length from the player end
    for (let i = 0; i < n; i++) {
        const p = eased[i];
        const prevP = eased[Math.max(0, i - 1)];
        const nextP = eased[Math.min(n - 1, i + 1)];

        // Floor-plane tangent, then perpendicular (tangent × up) for the ribbon's width axis.
        let tx = nextP[0] - prevP[0];
        let tz = nextP[2] - prevP[2];
        const tl = Math.hypot(tx, tz) || 1e-6;
        tx /= tl;
        tz /= tl;
        const px = -tz * RIBBON_HALF;
        const pz = tx * RIBBON_HALF;

        if (i > 0) {
            const q = eased[i - 1];
            dist += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        }
        const y = p[1] + LIFT;
        const vp = i * 6;
        posArr[vp] = p[0] + px; // left
        posArr[vp + 1] = y;
        posArr[vp + 2] = p[2] + pz;
        posArr[vp + 3] = p[0] - px; // right
        posArr[vp + 4] = y;
        posArr[vp + 5] = p[2] - pz;

        const v = (dist - total) / CHEVRON_LEN; // -distance-to-goal → goal-anchored, world-stable
        const vt = i * 4;
        uvArr[vt] = 0; // left
        uvArr[vt + 1] = v;
        uvArr[vt + 2] = 1; // right
        uvArr[vt + 3] = v;

        // Dither fade: 0 at either tip, ramping to 1 by FADE_LEN in (smoothstep). Same for both verts.
        const edge = Math.min(dist, total - dist) / FADE_LEN;
        const f = edge <= 0 ? 0 : edge >= 1 ? 1 : edge * edge * (3 - 2 * edge);
        fadeArr[i * 2] = f;
        fadeArr[i * 2 + 1] = f;
    }

    trail.pos.needsUpdate = true;
    trail.uv.needsUpdate = true;
    trail.fade.needsUpdate = true;
    trail.geo.setDrawRange(0, (n - 1) * 6);
    trail.mesh.visible = true;
}

export function hidePathTrail(trail: PathTrail): void {
    trail.mesh.visible = false;
    trail.geo.setDrawRange(0, 0);
    trail.sampled = []; // drop history so it doesn't ease from a stale path when it reappears
}

// Per-frame: scroll the chevrons toward the goal. Sampled v = vertex v + offset; decreasing the
// offset slides the chevrons toward higher v (the goal end).
export function updatePathTrail(trail: PathTrail, time: number): void {
    if (!trail.mesh.visible) return;
    trail.tex.offset.y = -(time * SCROLL);
}
