import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EYE_HEIGHT, initCharacter, isOnGround } from './character-controller';
import { initCharacterVisuals, loadCharacterVisuals, updateCharacterVisuals } from './character-visuals';
import { type Character, initCharacters, spawnCats, spawnCrew, updateCharacters } from './characters';
import { loadCollider } from './collider-load';
import type { Collider } from './collider-schema';
import {
    driveCharacter,
    faceFirstPersonToward,
    initFirstPersonControls,
    releaseFirstPersonControls,
    updateFirstPersonCamera,
} from './controls';
import { createControlsHint, setControlsHintVisible } from './controls-hint';
import { createCrosshair, setCrosshairVisible } from './crosshair';
import {
    addStageSkips,
    attachProbeGizmos,
    buildColliderDebug,
    createDebugOverlay,
    updateCrowdDebug,
    updateDebugOverlay,
} from './debug';
import { createDialogue, isDialogueOpen } from './dialogue';
import { buildProbeGizmos, deserializeProbeGridFile, type LoadedProbeGrid, setProbeVolume } from './light-probes';
import { createNameplate } from './nameplate';
import { addPlayerAgent, initNavigation, loadNavigation, updateCrowd, updateNavigation, updatePlayerAgent } from './navigation';
import { createObjective, updateObjective } from './objective';
import { applyPerformance, initPerformance } from './performance';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
import { initQuest, loadStriker, objective, STAGES, skipToStage, startIntro, updateInteraction, updateStriker } from './quest';
import { createQuestHud, setObjective } from './quest-hud';
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
import { attachShadowCatcher, initShadows, setShadowsEnabled, updateShadowCasters, updateShadows } from './shadows';
import { showTitle } from './title';
import './style.css';

const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function init() {
    const scene = new THREE.Scene();

    // Neutral fill for the companions (splats are self-lit and ignore these). Intensities in scene.ts.
    scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202028, HEMI_INTENSITY);
    scene.add(hemi);
    // Key light (shape + companion shadows, follows player) lives in shadows.ts, created below.

    // Companions are lit by the baked probe VOLUME (light-probes.ts), sampled per-fragment on the GPU.

    // Near plane inside HEAD_CLEARANCE so the ceiling doesn't clip into it on a jump.
    const CAMERA_NEAR = 0.05;
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, CAMERA_NEAR, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // antialias: false for Spark - MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // Shadow mapping + key light (shadows.ts). Companions cast onto an invisible collider-built
    // receiver (attached in load()) since splats can't receive real shadows.
    const shadows = initShadows(scene, renderer);

    // SparkRenderer drives splat sorting + LOD streaming for the .rad file. Widened foveation cone
    // keeps corner splats full-res (defaults: coneFov0 90, coneFov 120, coneFoveate 0.4).
    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
    });
    scene.add(spark);

    // paged: true streams LOD chunks on demand via HTTP Range requests instead of downloading the
    // whole 136 MB .rad up front. splat.initialized resolves immediately (wired up, not downloaded).
    const splat = new SplatMesh({ url: encodeURI(SPLAT_URL), paged: true });
    splat.recolor.setScalar(SPLAT_BRIGHTNESS); // whole-splat brightness (free HDR rgb multiply)
    scene.add(splat);

    // Orbit camera - debug "orbit camera" mode only; starts disabled (first-person drives by default).
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.enabled = false;
    controls.update();

    // Runtime perf/quality settings (LOD budget, etc.); tweaked by the debug panel.
    const perf = initPerformance();

    // Debug panel (toggle with backtick): mode toggle, collider/navmesh wireframes, LOD slider, readout.
    const debug = createDebugOverlay(perf);
    scene.add(debug.colliderLines);
    scene.add(debug.crowdCylinders);

    const physics = initPhysics();

    const navigation = initNavigation();

    // First-person character: KCC capsule + pointer-lock mouse look + WASD. Click canvas to capture.
    const character = initCharacter(physics);
    const fp = initFirstPersonControls(camera, renderer.domElement);

    // Companions: a navcat crowd of animated GLTF characters that follow the player.
    const characters = initCharacters();
    const characterVisuals = initCharacterVisuals(scene);

    // HUD crosshair + floating companion nameplate (shows a "TALK" prompt in interact range).
    const crosshair = createCrosshair();
    const nameplate = createNameplate();
    const controlsHint = createControlsHint(); // desktop control indicators (bottom-centre)
    // Objective guidance: world-space marker (pin / off-screen edge arrow) + breadcrumb route ribbon.
    const guidance = createObjective(scene);

    // Radial dialogue menu (dialogue.ts) + "Where Are the Keys?" quest state/HUD.
    const dialogue = createDialogue();
    const quest = initQuest();
    const questHud = createQuestHud();
    setObjective(questHud, objective(quest));

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
        nameplate,
        controlsHint,
        guidance,
        dialogue,
        quest,
        questHud,
        fp,
        orbitActive: false, // tracks debug.orbitMode to detect mode switches
        collider: null as Collider | null,
        probe: null as LoadedProbeGrid | null,
        groundY: 0, // last grounded feet Y - the shadow floor sits here so it doesn't rise on jumps
        // Finale/scene state (filled in load()): camera look-at focus point + the floating striker.
        focus: null as Vec3 | null,
        striker: null as THREE.Object3D | null,
        // finale fly-off state: gather -> lower -> hop -> ascend
        launch: {
            active: false,
            t: 0,
            phase: 'gather' as 'gather' | 'lower' | 'hop' | 'ascend',
            cat: null as Character | null,
        },
    };
}

export type State = ReturnType<typeof init>;

async function load(state: State) {
    // Kick off every independent asset load at once so they download in parallel, then await each
    // where its result is needed so sync setup runs as that piece lands, not all in series.
    const splatReady = state.splat.initialized;
    const colliderReady = loadCollider(COLLIDER_URL);
    const navReady = loadNavigation(state.navigation);
    const probeReady = loadProbeVolume(state);
    const visualsReady = loadCharacterVisuals(state.characterVisuals);
    const strikerReady = loadStriker(state);

    // Re-apply the recolor once wired up - the paged load can rebuild the material and drop an
    // earlier recolor. This one sticks.
    await splatReady;
    state.splat.recolor.setScalar(SPLAT_BRIGHTNESS);

    // Collider -> static physics body + invisible shadow receiver (same geometry) + debug wireframe.
    state.collider = await colliderReady;
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);
    createSplatCollider(state.physics, state.collider);
    attachShadowCatcher(state.scene, state.collider.positions, state.collider.indices);
    buildColliderDebug(state.debug, state.physics.world);

    // Navmesh -> spawn the cast (crew at room anchors, cats by the ship) + the player's proxy agent
    // so companions avoid us like any other agent.
    await navReady;
    spawnCrew(state.characters, state.navigation, state.physics);
    spawnCats(state.characters, state.navigation, state.physics);
    const p = state.character.kcc.position;
    addPlayerAgent(state.navigation, [p[0], p[1], p[2]]);

    // Finish the remaining background loads before the first frame so nothing pops in late - the
    // probe especially must be bound before the first createView (see loadProbeVolume).
    await Promise.all([probeReady, visualsReady, strikerReady]);

    // DEBUG: quest-stage skip buttons in the backtick panel.
    addStageSkips(state.debug, STAGES, (stage) => skipToStage(state, stage));
}

// Load the baked probe VOLUME (pnpm bake:probes) if present: bind it, drop a gizmo sphere per cell,
// record it for the readout. Non-fatal - without it companions use the flat fill lights. Must
// resolve before the first frame so the first createView sees the volume.
async function loadProbeVolume(state: State): Promise<void> {
    try {
        const res = await fetch(PROBE_URL);
        if (!res.ok) {
            console.warn('no light-probes.json — run `pnpm bake:probes` to create one');
            return;
        }
        const loaded = deserializeProbeGridFile(await res.text());
        setProbeVolume(loaded);
        state.probe = loaded;
        const gizmos = buildProbeGizmos(loaded);
        state.scene.add(gizmos);
        attachProbeGizmos(state.debug, gizmos);
        const r = loaded.resolution;
        console.log(`probe volume: loaded ${r.x}×${r.y}×${r.z} grid from light-probes.json`);
    } catch (err) {
        console.warn('failed to load probe volume:', err);
    }
}

const _orbitDir = new THREE.Vector3();
const ORBIT_PULLBACK = 5; // metres to pull the orbit camera back off the character's head

// Switch between first-person and orbit camera modes (driven by the debug panel checkbox).
function syncCameraMode(state: State) {
    if (state.debug.orbitMode === state.orbitActive) return;
    state.orbitActive = state.debug.orbitMode;

    if (state.orbitActive) {
        // -> orbit: release the mouse, orbit the head. Pull the camera back along its look
        // direction first, else it sits on the target (zero radius) with nothing to orbit.
        state.fp.enabled = false;
        releaseFirstPersonControls(state.fp);
        const f = state.character.kcc.position;
        state.controls.target.set(f[0], f[1] + EYE_HEIGHT, f[2]);
        state.camera.getWorldDirection(_orbitDir);
        state.camera.position.copy(state.controls.target).addScaledVector(_orbitDir, -ORBIT_PULLBACK);
        state.controls.enabled = true;
        state.controls.update();
    } else {
        // -> first-person: OrbitControls off, character drives the camera again.
        state.controls.enabled = false;
        state.fp.enabled = true;
    }
}

function update(state: State, dt: number, time: number) {
    syncCameraMode(state);

    updatePlayerAgent(state.navigation, state.character.kcc.position, state.character.kcc.linearVelocity);

    updateCrowd(state.navigation, dt);

    driveCharacter(state.fp, state.physics, state.character, dt);

    updatePhysics(state.physics, dt);

    const playerPosition = state.character.kcc.position;

    updateCharacters(state.characters, state.navigation, state.physics, playerPosition, dt);

    updateCharacterVisuals(state.characterVisuals, state.characters.list, dt, state.debug.showCharacters);

    if (isOnGround(state.character)) state.groundY = playerPosition[1];

    setShadowsEnabled(state.shadows, state.renderer, state.debug.shadows);

    updateShadows(state.shadows, playerPosition[0], state.groundY, playerPosition[2]);
    updateShadowCasters(state.physics, state.camera, state.characters.list, dt); // fade occluded casters' shadows

    if (state.debug.showCrowd && state.navigation.crowd) {
        updateCrowdDebug(state.debug, Object.values(state.navigation.crowd.agents));
    }

    updateStriker(state, dt, time);

    if (state.fp.enabled) {
        if (state.focus) faceFirstPersonToward(state.fp, state.character, state.focus, dt);
        updateFirstPersonCamera(state.fp, state.character, dt);
    } else {
        state.controls.update();
    }

    updateInteraction(state);

    setCrosshairVisible(state.crosshair, state.fp.enabled);

    setControlsHintVisible(
        state.controlsHint,
        !IS_TOUCH && state.fp.enabled && !isDialogueOpen(state.dialogue) && !state.launch.active,
    );

    updateObjective(
        state.guidance,
        {
            quest: state.quest,
            navigation: state.navigation,
            physics: state.physics,
            characters: state.characters,
            striker: state.striker,
            feet: state.character.kcc.position,
            groundY: state.groundY,
            camera: state.camera,
            renderer: state.renderer,
            suppressed: isDialogueOpen(state.dialogue) || state.launch.active || !state.fp.enabled,
        },
        time,
    );

    applyPerformance(state.perf, state.spark);

    const res = state.probe?.resolution;
    updateDebugOverlay(state.debug, state.camera, state.character, state.spark, {
        cells: res ? res.x * res.y * res.z : 0,
    });

    updateNavigation(state.navigation, state.scene, state.debug.showNavMesh);

    state.renderer.render(state.scene, state.camera);
}

// Fade out and remove the loading overlay once everything's ready.
function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

// splat.initialized resolves before anything's on screen; LOD pages stream in over later frames.
// spark.activeSplats climbs then plateaus once the LOD budget is filled. We can't check a fraction
// of the 8.3M total (LOD only renders a ~2M subset), so we watch the climb flatten out - floored so
// we don't lift on sparse root pages, with a timeout backstop.
const SPLAT_READY_MIN = 250000; // don't lift until at least this many splats are rendering
const SPLAT_READY_PLATEAU_GROWTH = 0.02; // "flat" = active grew <2% since the last frame
const SPLAT_READY_PLATEAU_FRAMES = 30; // ... sustained for this many frames (~0.5s @ 60fps)
const SPLAT_WAIT_TIMEOUT_MS = 10000; // ... but never keep the loader up longer than this
// Max simulation step (seconds). A slower frame (hitch) integrates as this long so the crowd/physics
// advance smoothly instead of teleporting. ~20fps floor.
const MAX_DT = 0.05;

async function start() {
    const state = init();
    await load(state);

    let lastTime = performance.now();
    let elapsed = 0;

    let loaderUp = true;
    let titleShown = false;
    const startedAt = performance.now();
    let lastActive = 0;
    let plateauFrames = 0;

    function loop() {
        const now = performance.now();
        // Clamp dt: a frame hitch (LOD streaming, GC, tab refocus) otherwise feeds one huge step
        // into the crowd/physics/character integration and teleports every agent.
        const dt = Math.min((now - lastTime) / 1000, MAX_DT);
        lastTime = now;
        elapsed += dt;
        update(state, dt, elapsed); // renders the frame, driving Spark's sort + LOD streaming

        if (loaderUp) {
            const active = state.spark.activeSplats;
            // Count consecutive frames where the streamed-in count stopped growing.
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
        } else if (!titleShown) {
            // Scene's on screen - show the title card. Clicking it captures the pointer (desktop)
            // and rolls the opening cutscene.
            titleShown = true;
            showTitle(() => {
                if (!IS_TOUCH) state.renderer.domElement.requestPointerLock();
                startIntro(state);
            });
        }

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
