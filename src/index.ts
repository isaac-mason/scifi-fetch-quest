import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { EYE_HEIGHT, initCharacter, updateCharacter } from './character';
import { initCharacterVisuals, loadCharacterVisuals, updateCharacterVisuals } from './character-visuals';
import { initCharacters, requestCharacterEmote, spawnCharacters, updateCharacters } from './characters';
import { loadCollider } from './collider-load';
import type { Collider } from './collider-schema';
import { getMoveDirection, initFirstPersonControls, releaseFirstPersonControls, updateFirstPersonCamera } from './controls';
import { createCrosshair, setCrosshairVisible, setInteractHint } from './crosshair';
import { attachProbeGizmos, buildColliderDebug, createDebugOverlay, updateCrowdDebug, updateDebugOverlay } from './debug';
import {
    buildProbeGizmos,
    deserializeProbeGridFile,
    type LoadedProbeGrid,
    setProbeVolume,
    setProbeVolumeIntensity,
} from './light-probes';
import { addPlayerAgent, initNavigation, loadNavigation, updateCrowd, updateNavigation, updatePlayerAgent } from './navigation';
import { applyPerformance, initPerformance } from './performance';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
import {
    AMBIENT_INTENSITY,
    CAMERA_POSITION,
    CAMERA_TARGET,
    COLLIDER_URL,
    HEMI_INTENSITY,
    MAX_DPR,
    PROBE_URL,
    SPLAT_BRIGHTNESS,
    SPLAT_URL,
} from './scene';
import { attachShadowCatcher, initShadows, updateShadows } from './shadows';
import { castViewRay } from './view-ray';
import './style.css';

function init() {
    const scene = new THREE.Scene();

    // Neutral fill for the companions (splats are self-lit and ignore these).
    // Intensities live in scene.ts to balance against PROBE_INTENSITY in one place.
    scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202028, HEMI_INTENSITY);
    scene.add(hemi);
    // Key light — gives the companions shape the flat probe irradiance can't. It now
    // also casts the companions' shadows and follows the player, so it lives in
    // shadows.ts (created below, once the renderer exists). Same colour/intensity as
    // before, so the shape lighting is unchanged.

    // Companions are lit by the baked probe VOLUME (light-probes.ts): the SH atlas is sampled
    // per-fragment on the GPU (injected into each companion's material — see character-visuals),
    // so there's no scene LightProbe and no per-frame CPU probe work here.

    // Near plane kept well inside the character's HEAD_CLEARANCE so the ceiling never
    // enters the near plane on a jump (otherwise it gets clipped and you see through it).
    const CAMERA_NEAR = 0.05;
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, CAMERA_NEAR, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // Enable shadow mapping + the shadow-casting key light (see shadows.ts). Splats
    // can't receive real shadows, so the companions cast onto an invisible receiver
    // built from the collider (attached in load()); the frustum follows the player.
    const shadows = initShadows(scene, renderer);

    // SparkRenderer drives splat sorting and LOD streaming/updates for the .rad file.
    // Widen the LOD foveation cone so splats near the screen corners stay full-res
    // (defaults: coneFov0 90, coneFov 120, coneFoveate 0.4).
    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
    });
    scene.add(spark);

    // `paged: true` turns the .rad into a streaming source: instead of downloading
    // the whole 136 MB file before the first frame, SplatMesh becomes a PagedSplats
    // that fetches only the LOD chunks it needs, on demand, via HTTP Range requests
    // (the .rad is a single-file, 128-chunk lodTree — offsets, not separate files).
    // SparkRenderer auto-creates and drives the shared SplatPager each frame; LOD and
    // page-fetching are on by default. `splat.initialized` resolves immediately here —
    // it no longer means "fully downloaded", only "wired up" (see the loader below).
    const splat = new SplatMesh({ url: encodeURI(SPLAT_URL), paged: true });
    splat.recolor.setScalar(SPLAT_BRIGHTNESS); // whole-splat brightness (free HDR rgb multiply)
    scene.add(splat);

    // Orbit camera — used only in the debug "orbit camera" mode; starts disabled
    // so the first-person controller drives the camera by default.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.enabled = false;
    controls.update();

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();

    // Debug panel: toggle with the backtick (`) key. Orbit/character mode toggle,
    // collider/navmesh wireframes, LOD slider, and a readout.
    const debug = createDebugOverlay(perf);
    scene.add(debug.colliderLines);
    scene.add(debug.crowdCylinders);

    const physics = initPhysics();

    const navigation = initNavigation();

    // First-person character: a KCC capsule the player walks around the ship with,
    // plus pointer-lock mouse look + WASD. Click the canvas to capture the mouse.
    const character = initCharacter(physics);
    const fp = initFirstPersonControls(camera, renderer.domElement);

    // Companions: a navcat crowd of animated GLTF characters that follow the player.
    const characters = initCharacters();
    const characterVisuals = initCharacterVisuals(scene);

    // HUD crosshair + "interact" hint (shown when looking at a companion).
    const crosshair = createCrosshair();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        spark,
        splat,
        shadows,
        controls,
        perf,
        debug,
        physics,
        navigation,
        character,
        characters,
        characterVisuals,
        crosshair,
        fp,
        orbitActive: false, // tracks debug.orbitMode to detect mode switches
        collider: null as Collider | null,
        probe: null as LoadedProbeGrid | null,
    };
}

type State = ReturnType<typeof init>;

async function load(state: State) {
    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    // Re-apply after init: the paged load can rebuild the splat's material, dropping a
    // recolor set before `initialized`. This is the one that actually sticks.
    state.splat.recolor.setScalar(SPLAT_BRIGHTNESS);

    state.collider = await loadCollider(COLLIDER_URL);
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);

    // Add the scene geometry to the physics world as a static triangle mesh.
    createSplatCollider(state.physics, state.collider);

    // Reuse the same triangle mesh as an invisible shadow receiver, so the
    // companions' shadows land on the ship floor/walls (splats can't receive them).
    attachShadowCatcher(state.scene, state.collider);

    // Colliders never move — build the debug wireframe once, now that they exist.
    buildColliderDebug(state.debug, state.physics.world);

    await loadNavigation(state.navigation);

    // Load the precomputed probe VOLUME if present (baked offline: pnpm bake:probes). This
    // must run BEFORE the companion materials compile (below) so their shaders bind the atlas
    // texture on first compile. Without it, companions just use the flat fill lights (the
    // material injection is gated on isProbeVolumeReady). Add one SH-shaded gizmo sphere per
    // cell and wire it to the debug panel's "light probes" checkbox.
    try {
        const res = await fetch(PROBE_URL);
        if (res.ok) {
            const loaded = deserializeProbeGridFile(await res.text());
            setProbeVolume(loaded);
            // Live brightness multiply on the baked probe volume — retune companion lighting
            // without a re-bake. Type `probeIntensity(1.5)` in the console; fold the value you
            // like into PROBE_INTENSITY (scene.ts) + re-bake to make it permanent.
            (window as unknown as { probeIntensity: (x: number) => void }).probeIntensity = setProbeVolumeIntensity;
            state.probe = loaded;
            const gizmos = buildProbeGizmos(loaded);
            state.scene.add(gizmos);
            attachProbeGizmos(state.debug, gizmos);
            const r = loaded.resolution;
            console.log(`probe volume: loaded ${r.x}×${r.y}×${r.z} grid from light-probes.json`);
        } else {
            console.warn('no light-probes.json — run `pnpm bake:probes` to create one');
        }
    } catch (err) {
        console.warn('failed to load probe volume:', err);
    }

    // Load the companion models, then spawn the crowd around the player's spawn.
    await loadCharacterVisuals(state.characterVisuals);
    const p = state.character.kcc.position;
    spawnCharacters(state.characters, state.navigation, state.physics, [p[0], p[1], p[2]]);

    // Represent the player in the crowd so companions avoid us like any other agent.
    addPlayerAgent(state.navigation, [p[0], p[1], p[2]]);
}

const _moveDir: Vec3 = [0, 0, 0];
const _playerPos: Vec3 = [0, 0, 0];
const INTERACT_RANGE = 2; // metres — how far the interaction view ray reaches

const _orbitDir = new THREE.Vector3();
const ORBIT_PULLBACK = 5; // metres to pull the orbit camera back off the character's head

// Apply a switch between first-person and orbit camera modes (driven by the debug
// panel's "orbit camera" checkbox).
function syncCameraMode(state: State) {
    if (state.debug.orbitMode === state.orbitActive) return;
    state.orbitActive = state.debug.orbitMode;

    if (state.orbitActive) {
        // → orbit: release the mouse and orbit around the character's head. Pull the
        // camera back along its current look direction first — otherwise it sits ON
        // the target (zero radius) and OrbitControls has nothing to orbit around.
        state.fp.enabled = false;
        releaseFirstPersonControls(state.fp);
        const f = state.character.kcc.position;
        state.controls.target.set(f[0], f[1] + EYE_HEIGHT, f[2]);
        state.camera.getWorldDirection(_orbitDir);
        state.camera.position.copy(state.controls.target).addScaledVector(_orbitDir, -ORBIT_PULLBACK);
        state.controls.enabled = true;
        state.controls.update();
    } else {
        // → first-person: OrbitControls off, character drives the camera again.
        state.controls.enabled = false;
        state.fp.enabled = true;
    }
}

function update(state: State, dt: number, _time: number) {
    syncCameraMode(state);

    // Pin the player's proxy agent to us BEFORE the crowd steps, so companions steer
    // around where we are and where we're heading.
    updatePlayerAgent(state.navigation, state.character.kcc.position, state.character.kcc.linearVelocity);
    updateCrowd(state.navigation, dt);

    // Step the character first (sweeps against the world), then the dynamics, then
    // follow with the camera — mirrors crashcat's example ordering.
    if (state.fp.enabled) {
        getMoveDirection(state.fp, _moveDir);
        updateCharacter(state.physics, state.character, _moveDir, state.fp.input.jump, state.fp.input.sprint, dt);
    }
    updatePhysics(state.physics, dt);

    // Companions follow the player: feed the crowd the player's current feet
    // position, then sync the animated models to the resulting agent motion.
    const pf = state.character.kcc.position;
    _playerPos[0] = pf[0];
    _playerPos[1] = pf[1];
    _playerPos[2] = pf[2];

    // Keep the shadow frustum centred on the player so companion shadows stay crisp.
    updateShadows(state.shadows, pf[0], pf[1], pf[2]);
    updateCharacters(state.characters, state.navigation, state.physics, _playerPos, dt);
    updateCharacterVisuals(state.characterVisuals, state.characters.list, dt);

    // Crowd debug: draw a cylinder per live agent (companions + the player proxy).
    if (state.debug.showCrowd && state.navigation.crowd) {
        updateCrowdDebug(state.debug, Object.values(state.navigation.crowd.agents));
    }

    // Companion lighting from the baked probe volume is entirely on the GPU (the material
    // samples the SH atlas per-fragment at each companion's world position — see
    // character-visuals + light-probes), so there's no per-frame CPU probe work here.

    if (state.fp.enabled) {
        updateFirstPersonCamera(state.fp, state.character, dt);
    } else {
        state.controls.update();
    }

    // Interaction: in first-person, cast a view ray from the camera. If it lands on a
    // companion, show the "interact" hint; pressing E makes them play a random emote.
    if (state.fp.enabled) {
        const hovered = castViewRay(state.physics, state.camera, INTERACT_RANGE);
        setInteractHint(state.crosshair, hovered !== null);
        const pressed = state.fp.input.interact;
        state.fp.input.interact = false; // consume the one-shot press
        if (pressed && hovered) requestCharacterEmote(state.characters, hovered);
    }
    setCrosshairVisible(state.crosshair, state.fp.enabled);

    // Push runtime perf settings (LOD budget, …) onto the renderer.
    applyPerformance(state.perf, state.spark);
    const res = state.probe?.resolution;
    updateDebugOverlay(state.debug, state.camera, state.character, state.spark, {
        cells: res ? res.x * res.y * res.z : 0,
    });
    updateNavigation(state.navigation, state.scene, state.debug.showNavMesh);
    state.renderer.render(state.scene, state.camera);
}

// Fade out + remove the loading overlay once everything's ready.
function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

// With paged streaming, `splat.initialized` resolves before anything is on screen —
// the LOD pages stream in over the next frames as the render loop drives Spark's
// pager. `spark.activeSplats` (the LOD-selected subset actually being rendered)
// climbs from 0 as chunks arrive, then plateaus once the view's LOD budget is filled.
// We can't compare it against the model's 8.3M total: LOD only ever renders a subset
// (~2M), so a fraction-of-total check would never fire. Instead we watch for the
// climb to flatten out — that's "the visible scene has streamed in" — gated by a
// floor so we don't lift on the first sparse root pages, with a timeout backstop.
const SPLAT_READY_MIN = 250000; // don't lift until at least this many splats are rendering
const SPLAT_READY_PLATEAU_GROWTH = 0.02; // "flat" = active grew <2% since the last frame
const SPLAT_READY_PLATEAU_FRAMES = 30; // ... sustained for this many frames (~0.5s @ 60fps)
const SPLAT_WAIT_TIMEOUT_MS = 10000; // ... but never keep the loader up longer than this

async function start() {
    const state = init();
    await load(state);

    let lastTime = performance.now();
    let elapsed = 0;

    let loaderUp = true;
    const startedAt = performance.now();
    let lastActive = 0;
    let plateauFrames = 0;

    function loop() {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        elapsed += dt;
        update(state, dt, elapsed); // renders the frame, which drives Spark's sort + LOD streaming

        if (loaderUp) {
            const active = state.spark.activeSplats;
            // Count consecutive frames where the streamed-in count has stopped growing.
            if (active >= SPLAT_READY_MIN && active <= lastActive * (1 + SPLAT_READY_PLATEAU_GROWTH)) {
                plateauFrames++;
            } else {
                plateauFrames = 0;
            }
            lastActive = active;

            const ready = plateauFrames >= SPLAT_READY_PLATEAU_FRAMES;
            if (ready || now - startedAt >= SPLAT_WAIT_TIMEOUT_MS) {
                loaderUp = false;
                console.log(`splats ready: ${active} streamed in${ready ? '' : ' (timed out)'}`);
                hideLoading();
            }
        }

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
