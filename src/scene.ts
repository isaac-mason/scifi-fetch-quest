import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; per-system "feel"
// constants stay in their own files.

// --- Assets (served from public/; see the README's asset pipeline) ---
// BASE_URL is the vite `base` ('./' — relative; see vite.config.ts), so these asset paths resolve
// relative to the page and work at the domain root OR any project subpath, no config needed.
const BASE = import.meta.env.BASE_URL;
export const SPLAT_URL = `${BASE}scifi_world-lod.rad`;
// The offline probe bake reads the source .spz WHOLE (non-paged) so every splat is
// resident before each cube capture — no per-probe streaming/settle to babysit. It's
// served straight from assets/ (dev-server only; assets/ isn't in the production build,
// and the bake only runs in dev). The runtime still streams the LOD-paged .rad above.
export const SPLAT_BAKE_URL = `${BASE}assets/scifi_world.spz`;
// Hand-authored collision mesh (a plain glTF triangle mesh, world-space, identity
// transform) — loaded at runtime and fed straight into physics/shadows/debug.
export const COLLIDER_URL = `${BASE}scifi_world_collider.glb`;
export const NAVMESH_URL = `${BASE}navmesh.json`;

// The collider is a hand-authored glTF triangle mesh (scifi_world_collider.glb), loaded
// straight into physics/shadows/debug at runtime (src/collider-load.ts). The navmesh is
// then baked from it: pnpm build:navmesh public/scifi_world_collider.glb → navmesh.json.
// Collider bounds (world units): x[-10.5, 26.7], y[-1.0, 6.9], z[-36.0, 9.0]; floor ≈ y0.
export const PROBE_URL = `${BASE}light-probes.json`;

// --- Light-probe VOLUME (baked offline: pnpm bake:probes) ---
// A DENSE axis-aligned grid of order-2 SH irradiance probes, packed into a 3D texture and
// sampled per-fragment by world position at runtime (src/light-probes.ts) — so the
// companions' lighting varies both across the ship AND across each lit surface, replacing
// the old one-blended-probe-per-companion CPU path. The grid box is fit at bake time to the
// COLLIDER's AABB (src/collider-load.ts) — the hand-authored collision mesh already bounds
// the playable interior tightly, so it's a cleaner box than fitting to noisy splat centres.
// EVERY cell is captured (a volume can't have holes; a cell inside geometry just captures
// dark). Intensity + saturation are baked straight into the atlas — the shader has no runtime
// multiplier — so changing either means a re-bake.
export const PROBE_SPACING = 1.5; // metres between cells on every axis. Collider AABB is ~37×8×45m,
// so 1.5m ≈ 25×6×31 ≈ 4.6k cells — a finishable full-splat bake. Lower for finer GI (bigger
// atlas, and the bake time climbs fast: each cell is 6 cube renders over the whole splat).
// Metres to pull the grid in from the collider AABB on every side, so edge cells sit just
// inside the hull rather than exactly on it. 0 = flush to the box.
export const PROBE_BOX_INSET = 0.25;
// Multiplier baked into every probe's SH (the volume shader has no runtime multiplier). Raw
// diffuse irradiance is dim; >1 makes the ship's local colour read on the companions. Raise
// for punchier ship colour, lower toward the flat ambient/hemi fill. Change → re-bake.
export const PROBE_INTENSITY = 3.5;
// Saturation boost baked into every probe (see saturateSphericalHarmonics). A diffuse probe
// integrates the whole hemisphere, so the ship's grey surfaces wash the localized emissive
// primaries (magenta/cyan/green) toward grey; >1 amplifies the captured chroma so those
// colours read as a companion moves past a light. 1 = raw (dull, greyish); ~2 = punchy.
// Independent of PROBE_INTENSITY (brightness) — only colourfulness. Change → re-bake.
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
// Spawn out near the ship so the intro (index.ts) frames the striker + the cats + George.
export const CHARACTER_SPAWN: Vec3 = [-1.2, 0.19, 2.52]; // feet position the player drops in at
export const CHARACTER_LOOK_TARGET: Vec3 = [3.53, 1.2, 6.3]; // faces the striker

// --- "Who Took the Bolts?" quest cast (see characters.ts / quest) ---
// The four companions parked one per room as stationary NPCs (spawnQuestCast snaps each onto
// the navmesh). Positions are from the debug feet readout in each room; `facing` (radians) is
// the yaw the model faces while idle — nudge in-app (backtick panel → click-copy a feet vec).
// The accusation chain walks these in order: George → Leela → Mike → Stan.
export type QuestAnchor = { model: string; pos: Vec3; facing: number };
export const QUEST_CAST: QuestAnchor[] = [
    { model: 'George', pos: [-1.86, 1.06, -1.93], facing: 0 }, // out by the ship (greets you)
    { model: 'Leela', pos: [-2.46, 1.26, -30.4], facing: 0 }, // bar
    { model: 'Mike', pos: [12.07, 1.26, -28.84], facing: 0 }, // herbarium
    { model: 'Stan', pos: [25.25, 1.06, -23.58], facing: 0 }, // back control room
];

// --- "Where Are the Keys?" finale assets (see index.ts / interactables.ts) ---
// The striker + the cat sit on the outside pad. Positions are best-guesses to TUNE
// in-app (backtick panel → click-copy a feet vec). The striker has no baked animation, so the
// launch is a procedural tween.
export const STRIKER_URL = `${BASE}striker.gltf`;
export const STRIKER_POS: Vec3 = [3.53, 2.6, 6.3]; // outside pad; floats/bobs (STRIKER_BOB_*)
// Walkable floor UNDER the ship where the cats gather at the finale before hopping aboard. Must be
// a real navmesh spot (the ship's own y=2.6 is too high to snap onto the floor). From the debug feet readout.
export const STRIKER_BOARD_POS: Vec3 = [2.68, -0.55, 5.88];
export const STRIKER_SCALE = 0.85;
export const STRIKER_YAW = 0; // radians
export const STRIKER_EMISSIVE = 0.45; // self-illumination from its own texture so the ship isn't dark on the pad
export const STRIKER_BOB_AMP = 0.06; // metres the ship rises/falls (gentle)
export const STRIKER_BOB_FREQ = 0.16; // bob cycles/sec (slow)
// The cats loiter around the ship, wandering + bobbing (see cats.ts). The model file is still
// navcat.glb on disk; the constants are named CAT_* everywhere in code.
export const CAT_URL = `${BASE}characters/navcat.glb`;
export const CAT_HEIGHT = 0.3; // fit each (oversized) cat model to this world height
export const CAT_Y_NUDGE = -0.05; // extra lower/raise on top of auto foot-grounding
export const CATS_COUNT = 10;
export const CATS_CENTER: Vec3 = [-0.01, 0.06, 1.97]; // on interior floor (at floor height so snaps land)
export const CATS_SPREAD = 3.6; // metres each cat wanders around the centre (wider = more scattered)

// --- Physics ---
export const GRAVITY: Vec3 = [0, -9.81, 0];
export const FLOOR_Y = -5; // kill-plane, below the world's lowest collider point (y≈-1.6)
export const FLOOR_HALF_EXTENTS: Vec3 = [60, 0.1, 45]; // catch-plane footprint under the scene
