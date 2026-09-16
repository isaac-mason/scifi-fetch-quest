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

## Asset pipeline

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
