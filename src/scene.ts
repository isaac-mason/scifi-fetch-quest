import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene's geometry and layout lives here, so swapping in a new world
// is a one-file edit. Per-system "feel" constants stay in their own files.

// --- Assets (served from public/; see the README's asset pipeline) ---
// BASE_URL is the vite `base` ('./' - relative), so asset paths resolve relative to the page and
// work at the domain root or any subpath, no config needed.
const BASE = import.meta.env.BASE_URL;
export const SPLAT_URL = `${BASE}scifi_world-lod.rad`;
// The offline probe bake reads the source .spz whole (non-paged) so every splat is resident before
// each cube capture. Served from assets/ (dev-server only). Runtime still streams the LOD .rad above.
export const SPLAT_BAKE_URL = `${BASE}assets/scifi_world.spz`;
// Hand-authored collision mesh (plain glTF triangle mesh, world-space, identity transform), loaded
// at runtime and fed into physics/shadows/debug.
export const COLLIDER_URL = `${BASE}scifi_world_collider.glb`;
export const NAVMESH_URL = `${BASE}navmesh.json`;

// The navmesh is baked from the collider: pnpm build:navmesh public/scifi_world_collider.glb -> navmesh.json.
// Collider bounds (world units): x[-10.5, 26.7], y[-1.0, 6.9], z[-36.0, 9.0]; floor ~ y0.
export const PROBE_URL = `${BASE}light-probes.json`;

// --- Light-probe VOLUME (baked offline: pnpm bake:probes) ---
// Dense axis-aligned grid of order-2 SH irradiance probes, packed into a 3D texture and sampled
// per-fragment by world position (src/light-probes.ts), so companion lighting varies across the
// ship and across each surface. The grid box fits the collider's AABB at bake time. Every cell is
// captured (no holes). Intensity + saturation are baked into the atlas, so changing either re-bakes.
export const PROBE_SPACING = 1.5; // metres between cells per axis. Collider AABB ~37x8x45m,
// so 1.5m ~ 25x6x31 ~ 4.6k cells - a finishable full-splat bake. Lower = finer GI, but bigger atlas
// and much longer bake (each cell is 6 cube renders over the whole splat).
// Metres to pull the grid in from the collider AABB per side, so edge cells sit just inside the
// hull. 0 = flush to the box.
export const PROBE_BOX_INSET = 0.25;
// Multiplier baked into every probe's SH. Raw diffuse irradiance is dim; >1 makes the ship's local
// colour read on the companions. Change -> re-bake.
export const PROBE_INTENSITY = 3.5;
// Saturation boost baked into every probe (see saturateSphericalHarmonics). A diffuse probe washes
// the localized emissive primaries toward grey; >1 amplifies the captured chroma. 1 = raw, ~2 =
// punchy. Independent of PROBE_INTENSITY. Change -> re-bake.
export const PROBE_SATURATION = 2.0;

// --- Companion fill lighting (non-splat meshes only; splats are self-lit). Balance against
// PROBE_INTENSITY: lower the fill so the probe carries the look, raise it for flatter/safer
// lighting. Kept low so it's a floor that stops shadowed sides going black, not the main light. ---
export const AMBIENT_INTENSITY = 0.2;
export const HEMI_INTENSITY = 0.18;
export const KEY_LIGHT_INTENSITY = 0.9; // directional key (gives shape/highlights + casts shadows)

// Cap on the renderer device-pixel-ratio. Splats are soft-edged so high DPR buys little; capping
// cuts Spark's per-pixel cost on hi-DPI screens.
export const MAX_DPR = 1.5;

// Whole-splat brightness multiplier (Spark `splat.recolor`, a free HDR rgb multiply). 1 = as-is,
// >1 brightens. No tone mapping, so output hard-clamps at white: this lifts mid/dark tones while
// bright areas cap out. Crank it (2-4) until it reads, then back off.
export const SPLAT_BRIGHTNESS = 2.0;

// --- Camera framing (world-space) - used by orbit-mode controls ---
// TODO(scifi_world): retune in-app - framed on the collider centre (~ -11, y, -2) for now.
export const CAMERA_POSITION: Vec3 = [-11, 22, 55];
export const CAMERA_TARGET: Vec3 = [-11, 8, -2];

// --- First-person character ---
// TODO(scifi_world): spawn is a best guess (collider centre, above the y0-2 floor); tune in-app
// with the debug panel's feet readout. Spawn near the ship so the intro frames the striker + cats.
export const CHARACTER_SPAWN: Vec3 = [-1.2, 0.19, 2.52]; // feet position the player drops in at
export const CHARACTER_LOOK_TARGET: Vec3 = [3.53, 1.2, 6.3]; // faces the striker

// --- "Who Took the Bolts?" quest cast (see characters.ts / quest) ---
// Four companions parked one per room as stationary NPCs (spawnCrew snaps each onto the navmesh).
// Positions from the debug feet readout; `facing` (radians) is the idle yaw. Accusation chain
// walks these in order: George -> Leela -> Mike -> Stan.
export type QuestAnchor = { model: string; pos: Vec3; facing: number };
export const QUEST_CAST: QuestAnchor[] = [
    { model: 'George', pos: [-1.86, 1.06, -1.93], facing: 0 }, // out by the ship (greets you)
    { model: 'Leela', pos: [-2.46, 1.26, -30.4], facing: 0 }, // bar
    { model: 'Mike', pos: [12.07, 1.26, -28.84], facing: 0 }, // herbarium
    { model: 'Stan', pos: [25.25, 1.06, -23.58], facing: 0 }, // back control room
];

// --- "Where Are the Keys?" finale assets (see index.ts / characters.ts) ---
// The striker + cat sit on the outside pad. Positions are best-guesses to tune in-app. The striker
// has no baked animation, so the launch is a procedural tween.
export const STRIKER_URL = `${BASE}striker.gltf`;
export const STRIKER_POS: Vec3 = [3.53, 2.6, 6.3]; // outside pad; floats/bobs (STRIKER_BOB_*)
// Walkable floor under the ship where the cats gather before hopping aboard. Must be a real navmesh
// spot (the ship's own y=2.6 is too high to snap). From the debug feet readout.
export const STRIKER_BOARD_POS: Vec3 = [2.68, -0.55, 5.88];
export const STRIKER_SCALE = 0.85;
export const STRIKER_YAW = 0; // radians
export const STRIKER_EMISSIVE = 0.45; // self-illumination from its own texture so the ship isn't dark on the pad
export const STRIKER_BOB_AMP = 0.06; // metres the ship rises/falls (gentle)
export const STRIKER_BOB_FREQ = 0.16; // bob cycles/sec (slow)
// The cats loiter around the ship, wandering + bobbing (see cats.ts). The model file is still
// navcat.glb on disk; the constants are named CAT_* in code.
export const CAT_URL = `${BASE}characters/navcat.glb`;
export const CAT_HEIGHT = 0.3; // fit each (oversized) cat model to this world height
export const CATS_COUNT = 10;
export const CATS_CENTER: Vec3 = [-0.01, 0.06, 1.97]; // on interior floor (at floor height so snaps land)
export const CATS_SPREAD = 3.6; // metres each cat wanders around the centre (wider = more scattered)

// --- Physics ---
export const GRAVITY: Vec3 = [0, -9.81, 0];
export const FLOOR_Y = -5; // kill-plane, below the world's lowest collider point (y~-1.6)
export const FLOOR_HALF_EXTENTS: Vec3 = [60, 0.1, 45]; // catch-plane footprint under the scene
