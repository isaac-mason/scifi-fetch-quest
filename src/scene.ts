import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; per-system "feel"
// constants stay in their own files.

// --- Assets (served from public/; see the README's asset pipeline) ---
// BASE_URL is '/' in dev and '/<repo>/' for the GitHub Pages build (vite.config.ts),
// so these resolve whether served from the domain root or a project subpath.
const BASE = import.meta.env.BASE_URL;
export const SPLAT_URL = `${BASE}scifi_world-lod.rad`;
// Hand-authored collision mesh (a plain glTF triangle mesh, world-space, identity
// transform) — loaded at runtime and fed straight into physics/shadows/debug.
export const COLLIDER_URL = `${BASE}scifi_world_collider.glb`;
export const NAVMESH_URL = `${BASE}navmesh.json`;

// The collider is a hand-authored glTF triangle mesh (scifi_world_collider.glb), loaded
// straight into physics/shadows/debug at runtime (src/collider-load.ts). The navmesh is
// then baked from it: pnpm build:navmesh public/scifi_world_collider.glb → navmesh.json.
// Collider bounds (world units): x[-10.5, 26.7], y[-1.0, 6.9], z[-36.0, 9.0]; floor ≈ y0.
export const PROBE_URL = `${BASE}light-probes.json`;

// --- Light-probe grid (baked offline: pnpm bake:probes, or press B in-app) ---
// XZ extent to scatter probe samples over (~the collider bounds). Each sample snaps
// onto the navmesh floor, then lifts to torso height. Shared by the runtime, the
// in-app bake (index.ts), and the offline bake (src/bake.ts).
export const PROBE_MIN_XZ: [number, number] = [-59, -36];
export const PROBE_MAX_XZ: [number, number] = [37, 32];
export const PROBE_SPACING = 1.0; // metres between XZ samples (denser = more local colour)
// Multiple heights above the floor so lighting varies vertically inside a room
// (floor bounce low, ceiling/fixtures high) instead of one probe per room. The
// runtime blends in 3D, so a companion picks up the layer nearest its torso.
export const PROBE_HEIGHTS = [0.4, 1.0, 1.7];
// Keep a probe only if it's within this distance (m) of a collider triangle, so we
// don't waste probes in open volume, far from any surface. This ship is compact —
// everything's within ~1m of a surface — so the useful range is ~0.4-0.9m (lower =
// hug surfaces tighter / fewer probes). The bake logs keep-counts per radius.
export const PROBE_KEEP_RADIUS = 0.8;
// Multiplier on the SH LightProbe irradiance lighting the companions (sampled at the player
// each frame). SH shades by normal, so this reads as directional local light, not a flat
// wash — raise for punchier ship colour on them, lower toward the flat ambient/hemi fill.
export const PROBE_INTENSITY = 3.5;

// Saturation boost on the probe lighting the companions, baked into the grid by the
// offline bake (pnpm bake:probes → light-probes.json). The probe averages the whole
// hemisphere, so the ship's grey surfaces wash the localized emissive primaries
// (magenta/cyan/green) toward grey; >1 amplifies the captured chroma so those colours
// read as a companion moves past a light. 1 = raw (dull, greyish); ~2 = punchy.
// Independent of PROBE_INTENSITY (brightness) — only colourfulness. Change this, then
// rebake for it to take effect (the committed grid records the value it was baked at).
export const PROBE_SATURATION = 2.0;

// --- Companion fill lighting (affects the non-splat meshes only; splats are
// self-lit). Balance these against PROBE_INTENSITY: LOWER the fill so the probe's
// coloured, position-varying light carries the look; RAISE it for flatter, safer
// lighting that doesn't depend on the baked grid. Kept low so the flat ambient
// doesn't wash out the probe — it's a floor that stops shadowed sides going black,
// not the main light. ---
export const AMBIENT_INTENSITY = 0.2;
export const HEMI_INTENSITY = 0.18;
export const KEY_LIGHT_INTENSITY = 0.9; // directional key (gives shape/highlights + casts shadows)

// Cap on the renderer device-pixel-ratio. Splats are soft-edged so high DPR buys
// little; capping cuts Spark's per-pixel sort/blend cost on Retina/hi-DPI screens.
export const MAX_DPR = 1.5;

// Whole-splat brightness multiplier (Spark `splat.recolor`, a free HDR rgb multiply).
// 1 = the splat's baked colour as-is; >1 brightens, <1 darkens. NOTE: the renderer has no
// tone mapping, so output hard-clamps at white — this lifts the mid/dark tones; already-
// bright areas cap out. Crank it (2–4) until it reads, then back off.
export const SPLAT_BRIGHTNESS = 2.0;

// --- Camera framing (world-space) — used by orbit-mode controls ---
// TODO(scifi_world): retune to taste in-app — framed on the collider centre (≈ -11, y, -2) for now.
export const CAMERA_POSITION: Vec3 = [-11, 22, 55];
export const CAMERA_TARGET: Vec3 = [-11, 8, -2];

// --- First-person character ---
// TODO(scifi_world): spawn is a best guess (collider centre, just above the y0–2 floor); tune
// in-app with the debug panel's feet readout so you drop onto solid floor, not into a wall/void.
export const CHARACTER_SPAWN: Vec3 = [3, 1, -14]; // feet position the player drops in at
export const CHARACTER_LOOK_TARGET: Vec3 = [-11, 4.9, 8]; // point the player initially faces

// --- Physics ---
export const GRAVITY: Vec3 = [0, -9.81, 0];
export const FLOOR_Y = -5; // kill-plane, below the world's lowest collider point (y≈-1.6)
export const FLOOR_HALF_EXTENTS: Vec3 = [60, 0.1, 45]; // catch-plane footprint under the scene
