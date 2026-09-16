<p align="center">
  <img src="cover.png" alt="scifi-fetch-quest" width="820" />
</p>

# scifi-fetch-quest

A walkable Gaussian splat world with a small fetch quest in it.

The striker's keys have gone missing and the crew are stranded. Walk around in first person, talk your way down the accusation chain, and find out who took them.

Meant as a starting point for your own interactive splat worlds.

## Stack

| Layer | Library |
| --- | --- |
| Renderer | [Three.js](https://threejs.org) (`WebGLRenderer`) |
| Gaussian splats | [Spark](https://github.com/sparkjsdev/spark) (`SparkRenderer`, streaming LOD `.rad`) |
| Physics and character controller | [crashcat](https://www.npmjs.com/package/crashcat) |
| Navigation | [navcat](https://www.npmjs.com/package/navcat) |
| Math | [mathcat](https://www.npmjs.com/package/mathcat) |
| Binary asset packing | [packcat](https://www.npmjs.com/package/packcat) |
| Asset tooling | [glTF-Transform](https://gltf-transform.dev), [Playwright](https://playwright.dev) |
| Language and build | TypeScript, [Vite](https://vite.dev) |
| Lint and format | [Biome](https://biomejs.dev) |

## Quick start

Requires Node.js 24+ (see `.nvmrc`) and pnpm.

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # tsc + vite build into dist/
pnpm preview      # serve the production build
```

Chrome is only needed to re-bake light probes (`pnpm bake:probes`), not to run the scene.

## Controls

- Move: `W` `A` `S` `D` or arrow keys
- Look: mouse (click the canvas to capture the pointer)
- Jump: `Space`, sprint: hold `Shift`
- Debug panel: backtick

## How it works

A Gaussian splat is only visuals: a cloud of coloured blobs with no floor, walls, or sense of which blobs are solid. Everything interactive comes from invisible data aligned with the splat.

- Collider (`src/collider-load.ts`, `src/physics.ts`). A hand-authored triangle mesh of the hull and floors (`scifi_world_collider.glb`), loaded at runtime. crashcat uses it for swept-capsule collisions, the interaction ray, and grounding raycasts. It also doubles as the shadow receiver.
- Character controller (`src/character-controller.ts`, `src/controls.ts`). A crashcat kinematic capsule with Quake-style movement (ground friction, air strafe, bunny hop), pointer-lock mouse look, and view bob.
- Navmesh and crowd (`src/navigation.ts`, `src/characters.ts`, `src/cats.ts`). The crew and the cats are navcat crowd agents that path around the ship and avoid each other. The player is a target-less proxy agent pinned to your feet so they steer around you too.
- Cast (`src/character-visuals.ts`, `src/cats.ts`). Animated models that blend idle and walk by speed, turn to face you while talking, and, for the cats, wander, meow, and hop into the ship at the finale.
- Dialogue (`src/dialogue.ts`, `src/voice.ts`). A radial response wheel and an animalese typewriter voice, pure Web Audio with no samples.
- HUD (`src/nameplate.ts`, `src/objective-marker.ts`, `src/path-trail.ts`, `src/quest-hud.ts`). Talk prompt, world-space objective marker, floor chevron ribbon, and objective line.
- Shadows (`src/shadows.ts`). A directional sun casts the crew and cats onto the collider mesh, reused as an invisible `ShadowMaterial` receiver so shadows follow the real floor.
- Lighting (`src/light-probes.ts`). The cast is lit by a baked order-2 SH light-probe volume sampled per fragment, so their colour changes as they move through the ship.

The collider, navmesh, and probe grid are baked once offline and loaded directly. A loading overlay stays up until enough of the splat is on screen; it counts drawn splats rather than waiting a fixed time.

## Asset pipeline

Everything the browser loads is prepared offline, so there is no heavy parsing at runtime. The hand-authored collision mesh is the shared source for both the runtime collider and the navmesh. The light-probe grid is baked from the ship splat itself.

```bash
pnpm build:navmesh    # public/navmesh.json        from the collider .glb
pnpm bake:probes      # public/light-probes.json   from the ship splat
pnpm build:lod        # public/<name>-lod.rad      from the source .spz
```

| Script | Input | Output | Used by |
| --- | --- | --- | --- |
| [`scripts/build-navmesh.ts`](scripts/build-navmesh.ts) | `scifi_world_collider.glb` | `public/navmesh.json` | `src/navigation.ts` |
| [`scripts/bake-probes.mjs`](scripts/bake-probes.mjs) | ship splat (`bake.html`, `src/bake.ts`) | `public/light-probes.json` | `src/light-probes.ts` |
| [`scripts/build-lod.sh`](scripts/build-lod.sh) | source `.spz` | `public/<name>-lod.rad` | `src/index.ts` |

`build-navmesh` flood-fill-prunes from a seed point, so only the connected walkable volume the player occupies is saved. Disconnected islands and the exterior hull are dropped.

The probe bake starts the Vite dev server and opens `bake.html` in real headed Chrome, since Spark needs a real GPU and headless Chromium does not render splats faithfully. Re-run it when the ship splat or the `PROBE_*` config in `src/scene.ts` changes.

The runtime splat is built from the source `.spz` with Spark's Rust `build-lod` tool, which ships in the Spark source repo rather than the npm package. Set `SPARK_REPO` if your Spark checkout is not at `~/Development/spark-gpu`. The prebuilt `.rad` ships in `public/`.

## License

MIT.
