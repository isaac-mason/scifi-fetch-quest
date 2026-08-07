import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
    allCatsGathered,
    boardCats,
    type Cat,
    despawnCats,
    hopCats,
    initCats,
    loadCats,
    setCatTalking,
    updateCats,
} from './cats';
import { EYE_HEIGHT, initCharacter, isOnGround, updateCharacter } from './character';
import { initCharacterVisuals, loadCharacterVisuals, TARGET_HEIGHT, updateCharacterVisuals } from './character-visuals';
import {
    type Character,
    initCharacters,
    requestCharacterEmote,
    setCharacterFollowing,
    spawnQuestCast,
    updateCharacters,
} from './characters';
import { loadCollider } from './collider-load';
import type { Collider } from './collider-schema';
import {
    faceFirstPersonToward,
    getMoveDirection,
    initFirstPersonControls,
    releaseFirstPersonControls,
    setControlsPaused,
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
import { createDialogue, isDialogueOpen, openDialogue, showLine } from './dialogue';
import { initInteractables, interactableAt } from './interactables';
import {
    buildProbeGizmos,
    deserializeProbeGridFile,
    type LoadedProbeGrid,
    setProbeVolume,
    setProbeVolumeIntensity,
} from './light-probes';
import { createNameplate, type NameTarget, updateNameplate } from './nameplate';
import {
    addPlayerAgent,
    computePath,
    initNavigation,
    loadNavigation,
    updateCrowd,
    updateNavigation,
    updatePlayerAgent,
} from './navigation';
import { createObjectiveMarker, updateObjectiveMarker } from './objective-marker';
import { createPathTrail, hidePathTrail, resamplePath, setPathTrail, updatePathTrail } from './path-trail';
import { applyPerformance, initPerformance } from './performance';
import { createSplatCollider, groundAt, initPhysics, updatePhysics } from './physics';
import {
    advance,
    CAT_MEOW,
    dialogueFor,
    initQuest,
    objective,
    objectiveShort,
    objectiveTarget,
    STAGES,
    type Stage,
} from './quest';
import { createQuestHud, setObjective } from './quest-hud';
import {
    AMBIENT_INTENSITY,
    CAMERA_POSITION,
    CAMERA_TARGET,
    CAT_HEIGHT,
    CAT_URL,
    CAT_Y_NUDGE,
    CATS_CENTER,
    CATS_COUNT,
    CATS_SPREAD,
    COLLIDER_URL,
    HEMI_INTENSITY,
    MAX_DPR,
    PROBE_URL,
    SPLAT_BRIGHTNESS,
    SPLAT_URL,
    STRIKER_BOARD_POS,
    STRIKER_BOB_AMP,
    STRIKER_BOB_FREQ,
    STRIKER_EMISSIVE,
    STRIKER_POS,
    STRIKER_SCALE,
    STRIKER_URL,
    STRIKER_YAW,
} from './scene';
import { attachShadowCatcher, initShadows, updateShadows } from './shadows';
import { showTitle } from './title';
import { castViewRay } from './view-ray';
import './style.css';

const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

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

    // HUD crosshair (centre dot) + the floating companion nameplate (pops up over
    // whoever you're looking at, with a "TALK" prompt once you're in interact range).
    const crosshair = createCrosshair();
    const nameplate = createNameplate();
    const controlsHint = createControlsHint(); // desktop control indicators (bottom-centre)
    // World-space quest marker: a pin over the current objective (NPC / ship), an edge arrow off-screen.
    const objectiveMarker = createObjectiveMarker();
    // Breadcrumb trail along the navcat route to the current objective.
    const pathTrail = createPathTrail(scene);

    // Radial dialogue menu (dialogue.ts) + the "Where Are the Keys?" quest state/HUD. Talking to
    // an NPC opens a node on the wheel; talking to the current suspect advances the accusation.
    const dialogue = createDialogue();
    const quest = initQuest();
    const questHud = createQuestHud();
    setObjective(questHud, objective(quest));

    // Look-and-click world objects (the keys pickup, the cat) — created in load() once their
    // models exist.
    const interactables = initInteractables();

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
        objectiveMarker,
        pathTrail,
        dialogue,
        quest,
        questHud,
        interactables,
        fp,
        orbitActive: false, // tracks debug.orbitMode to detect mode switches
        collider: null as Collider | null,
        probe: null as LoadedProbeGrid | null,
        groundY: 0, // last grounded feet Y — the shadow floor sits here so it doesn't rise on jumps
        // Finale/scene state (filled in load()): the world point the camera lerps to look at
        // while talking / in a scripted scene; the floating striker; and the cats.
        focus: null as Vec3 | null,
        striker: null as THREE.Object3D | null,
        cats: initCats(),
        // finale fly-off state: gather (cats run under ship, wait for all) → lower (ship descends) →
        // hop (cats leap in) → ascend (fly away)
        launch: {
            active: false,
            t: 0,
            phase: 'gather' as 'gather' | 'lower' | 'hop' | 'ascend',
            cat: null as Cat | null,
        },
    };
}

type State = ReturnType<typeof init>;

const NPC_HEAD = 0.72; // metres above a talker's feet the camera looks at (~face level; models are 1m tall)

// Pause the controller and lerp the view onto a world point (setControlsPaused freezes look;
// faceFirstPersonToward turns toward `focus` each frame in update).
function beginFocus(state: State, focus: Vec3): void {
    state.focus = focus;
    updateNameplate(state.nameplate, null, false); // hide the reticle prompt while focused
    setControlsPaused(state.fp, true);
}
// Hand control back after a focused interaction.
function endFocus(state: State): void {
    setControlsPaused(state.fp, false);
    state.focus = null;
}

// Talk to a crowd character: open their quest node, look at them, and (for the current suspect)
// advance the accusation + fold them into the conga line when it's done.
function talkToCharacter(state: State, ch: Character): void {
    const { node, active } = dialogueFor(state.quest, ch.model);
    ch.facePlayer = true; // turn to look at us while we talk
    beginFocus(state, [ch.position[0], ch.position[1] + NPC_HEAD, ch.position[2]]);
    const emote = () => requestCharacterEmote(state.characters, ch.id); // gesture as each line lands
    const done = () => {
        ch.facePlayer = false;
        if (active) {
            advance(state.quest);
            setObjective(state.questHud, objective(state.quest));
            if (state.quest.stage !== 'closed') setCharacterFollowing(state.characters, ch.id);
        }
        endFocus(state);
    };
    // Active exchange → the response wheel; a bark → just a line you read and click past (no
    // pointless single-option wheel).
    if (active) openDialogue(state.dialogue, node, done, emote);
    else showLine(state.dialogue, node.speaker, node.text, done, emote);
}

// Talk to a cat. Before the reveal it plays dumb ("meow?"); at the reveal (stage 'cat') any
// cat gloats — they were all in on it — then the whole mob boards and the striker flies off.
function talkToCat(state: State, cat: Cat): void {
    const revealing = state.quest.stage === 'cat';
    const node = revealing ? dialogueFor(state.quest, 'cat').node : CAT_MEOW;
    setCatTalking(cat, true);
    beginFocus(state, [cat.it.head[0], cat.it.head[1], cat.it.head[2]]);
    openDialogue(state.dialogue, node, () => {
        setCatTalking(cat, false);
        if (revealing) {
            advance(state.quest); // → closed
            setObjective(state.questHud, objective(state.quest));
            startLaunch(state, cat); // follow THIS cat aboard; keeps controls paused → apology scene
        } else {
            endFocus(state);
        }
    });
}

// The crew's sheepish aftermath, watched as a scripted scene (camera pans to each).
const APOLOGY_SCENE: SceneStep[] = [
    { focus: 'George', speaker: 'george', text: "leela… i'm sorry i said your optics were shifty. they're lovely optics." },
    { focus: 'Leela', speaker: 'leela', text: 'it happens. mike — my bad too. you were just standing there building things.' },
    { focus: 'Mike', speaker: 'mike', text: "we lost a spaceship to a pile of cats. let's never speak of it again." },
    { focus: 'Stan', speaker: 'stan', text: 'for the record — my cameras performed flawlessly.' },
];

const GATHER_ARRIVE = 0.9; // a cat this close to its under-ship target counts as gathered
const GATHER_TIMEOUT = 6.0; // safety cap: lower the ship even if a cat never makes it under
const LOWER_DUR = 1.6; // seconds the ship takes to descend to boarding height
const HOP_TIMEOUT = 1.2; // safety cap on the hop-in before we force-clear any stragglers
const LAUNCH_DUR = 4.0; // seconds of the striker's climb-out
const STRIKER_BOARD_Y = 1.0; // world y the ship lowers to so the cats can hop aboard

// Kick off the finale: the cats stampede to the ground under the striker (we follow the one you
// just talked to), the ship lowers to meet them, they hop in, then it flies off (updateLaunch).
function startLaunch(state: State, hero: Cat): void {
    if (!state.striker) {
        endFocus(state);
        return;
    }
    state.launch.active = true;
    state.launch.t = 0;
    state.launch.phase = 'gather';
    state.launch.cat = hero;
    boardCats(state.cats, state.navigation, STRIKER_BOARD_POS); // run to the floor under the ship
}

// Camera follows the cat you talked to (at floor level) while it's still around, else the ship.
function focusHeroOrShip(state: State, s: THREE.Object3D): void {
    const hero = state.launch.cat;
    if (hero && state.cats.list.includes(hero)) {
        const m = hero.mesh.position;
        state.focus = [m.x, m.y + 0.35, m.z];
    } else {
        state.focus = [s.position.x, s.position.y, s.position.z];
    }
}

// Per-frame finale: (1) gather — cats run to the floor under the ship while it descends to meet
// them; (2) hop — they leap up into it and despawn; (3) ascend — it flies up and away, then the
// crew's apology cutscene plays.
function updateLaunch(state: State, dt: number): void {
    const s = state.striker;
    if (!state.launch.active || !s) return;
    state.launch.t += dt;

    if (state.launch.phase === 'gather') {
        // Cats walk to the ground under the ship; the ship holds at its float height. Wait until
        // they're ALL there (or a straggler times out) before lowering.
        s.position.set(STRIKER_POS[0], STRIKER_POS[1], STRIKER_POS[2]);
        focusHeroOrShip(state, s);
        const allHere = state.cats.list.length === 0 || allCatsGathered(state.cats, state.navigation, GATHER_ARRIVE);
        if (allHere || state.launch.t >= GATHER_TIMEOUT) {
            state.launch.phase = 'lower';
            state.launch.t = 0;
        }
        return;
    }

    if (state.launch.phase === 'lower') {
        // Everyone's under it → the ship descends to boarding height to meet them.
        const g = Math.min(1, state.launch.t / LOWER_DUR);
        const ease = g * g * (3 - 2 * g);
        s.position.set(STRIKER_POS[0], STRIKER_POS[1] + (STRIKER_BOARD_Y - STRIKER_POS[1]) * ease, STRIKER_POS[2]);
        focusHeroOrShip(state, s);
        if (g >= 1) {
            hopCats(state.cats, [s.position.x, s.position.y, s.position.z]); // now they leap in
            state.launch.phase = 'hop';
            state.launch.t = 0;
        }
        return;
    }

    if (state.launch.phase === 'hop') {
        // Hold the ship low while the cats arc up into it (they despawn at the end of their hop).
        s.position.set(STRIKER_POS[0], STRIKER_BOARD_Y, STRIKER_POS[2]);
        focusHeroOrShip(state, s);
        if (state.cats.list.length > 0 && state.launch.t < HOP_TIMEOUT) return;
        despawnCats(state.cats, state.navigation, state.physics, state.interactables); // clear stragglers
        state.launch.phase = 'ascend';
        state.launch.t = 0;
        return;
    }

    // ascend: climb up and away from the boarding height.
    const p = Math.min(1, state.launch.t / LAUNCH_DUR);
    s.position.set(STRIKER_POS[0], STRIKER_BOARD_Y + p * p * 60, STRIKER_POS[2] + p * p * 34);
    s.rotation.y = STRIKER_YAW + p * 1.5;
    state.focus = [s.position.x, s.position.y, s.position.z]; // track it out
    if (p >= 1) {
        state.launch.active = false;
        s.visible = false;
        playScene(state, APOLOGY_SCENE); // pans the crew's apologies, then hands control back
    }
}

// DEBUG: jump the quest to a stage (backtick panel → "skip:" buttons). Syncs the conga line —
// a crew member follows once the quest is past their accusation — and refreshes the objective.
function skipToStage(state: State, stage: string): void {
    state.quest.stage = stage as Stage;
    setObjective(state.questHud, objective(state.quest));
    const idx = STAGES.indexOf(state.quest.stage);
    for (const ch of state.characters.list) {
        const chIdx = STAGES.indexOf(ch.model.toLowerCase() as Stage);
        if (chIdx >= 0) ch.mode = chIdx < idx ? 'following' : 'stationary';
    }
    console.log('quest → stage:', stage);
}

// Emote the crew member a scene line is spoken by (matched by model name), if any.
function emoteByModel(state: State, model: string): void {
    const ch = state.characters.list.find((c) => c.model.toLowerCase() === model.toLowerCase());
    if (ch) requestCharacterEmote(state.characters, ch.id);
}

// --- Scripted-scene runner (NPC-to-NPC exchanges you watch) ---
// A scene is a list of lines; each names who's speaking (`speaker`, the panel label) and what to
// look at (`focus` — a crew model, 'ship', 'cats', or '' for no change). The camera lerps to the
// focus (faceFirstPersonToward in update), you click through the lines, then control returns.
type SceneStep = { focus: string; speaker: string; text: string };

// Resolve a scene's `focus` key to a world point to look at.
function locate(state: State, key: string): Vec3 | null {
    if (key === 'ship')
        return state.striker ? [state.striker.position.x, state.striker.position.y, state.striker.position.z] : null;
    if (key === 'cats') {
        const c = state.cats.list[0];
        return c ? [c.it.head[0], c.it.head[1], c.it.head[2]] : null;
    }
    const ch = state.characters.list.find((c) => c.model === key);
    return ch ? [ch.position[0], ch.position[1] + NPC_HEAD, ch.position[2]] : null;
}

// Where the objective marker anchors: the top of a crew member's HEAD (feet + model height), so the
// tag floats above them. Distinct from locate() which returns the face point for the camera focus.
function markerAnchor(state: State, key: string): Vec3 | null {
    if (key === 'ship')
        return state.striker ? [state.striker.position.x, state.striker.position.y, state.striker.position.z] : null;
    if (key === 'cats') {
        const c = state.cats.list[0];
        return c ? [c.it.head[0], c.it.head[1], c.it.head[2]] : null;
    }
    const ch = state.characters.list.find((c) => c.model === key);
    return ch ? [ch.position[0], ch.position[1] + TARGET_HEIGHT, ch.position[2]] : null;
}

// The navmesh point to route the objective trail to (feet, not head; the pad for the ship since
// the ship floats off-mesh).
function objectiveGoal(state: State, key: string): Vec3 | null {
    if (key === 'ship') return CATS_CENTER;
    const ch = state.characters.list.find((c) => c.model === key);
    return ch ? [ch.position[0], ch.position[1], ch.position[2]] : null;
}

// Play a scene: pause, walk the lines (camera panning to each speaker), then resume + onComplete.
function playScene(state: State, steps: SceneStep[], onComplete?: () => void): void {
    updateNameplate(state.nameplate, null, false);
    setControlsPaused(state.fp, true);
    let i = 0;
    const next = (): void => {
        if (i >= steps.length) {
            endFocus(state);
            onComplete?.();
            return;
        }
        const s = steps[i++];
        const pos = locate(state, s.focus);
        if (pos) state.focus = pos;
        showLine(state.dialogue, s.speaker, s.text, next, () => emoteByModel(state, s.speaker));
    };
    next();
}

// The opening cutscene: George shows you the (going-nowhere) ship, the useless cats, and the
// missing-keys premise.
const INTRO: SceneStep[] = [
    { focus: 'George', speaker: 'george', text: 'oh, hi. you must be the new deckhand. welcome to the striker.' },
    { focus: 'ship', speaker: 'george', text: "she's fuelled, she's polished, and she is going absolutely nowhere." },
    { focus: 'cats', speaker: 'george', text: 'because the keys are gone. and this lot of freeloaders are no help whatsoever.' },
    { focus: 'George', speaker: 'george', text: 'point is, we are not going anywhere. so. any bright ideas, deckhand?' },
];

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

    // Reuse the same collider geometry as the invisible shadow receiver so the crew/cats' shadows
    // land on the real world surface (conforming to slopes/steps). See shadows.ts.
    attachShadowCatcher(state.scene, state.collider.positions, state.collider.indices);

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

    // Load the companion models, then park the quest cast (George/Leela/Mike/Stan) at their
    // room anchors as stationary NPCs.
    await loadCharacterVisuals(state.characterVisuals);
    spawnQuestCast(state.characters, state.navigation, state.physics);

    // Represent the player in the crowd so companions avoid us like any other agent.
    const p = state.character.kcc.position;
    addPlayerAgent(state.navigation, [p[0], p[1], p[2]]);

    // --- Finale props: the floating striker + the cats loitering around it ---
    await loadFinale(state);

    // DEBUG: quest-stage skip buttons in the backtick panel.
    addStageSkips(state.debug, STAGES, (stage) => skipToStage(state, stage));
}

// Load the striker (floats outside) + the cat mob. Kept separate so a missing/failed asset
// doesn't take down the rest of the scene.
async function loadFinale(state: State): Promise<void> {
    try {
        // The striker, floating on the outside pad (self-contained .gltf; bobs — see update).
        const strikerGltf = await new GLTFLoader().loadAsync(STRIKER_URL);
        const striker = strikerGltf.scene;
        striker.position.set(STRIKER_POS[0], STRIKER_POS[1], STRIKER_POS[2]);
        striker.scale.setScalar(STRIKER_SCALE);
        striker.rotation.y = STRIKER_YAW;
        // The fill lights are tuned dim (the companions rely on the baked probe volume, which the
        // striker doesn't get), so out on the pad it reads very dark. Self-light it from its own
        // albedo/texture via emissive so it stays readable without a dedicated light.
        striker.traverse((o) => {
            o.frustumCulled = false;
            const mesh = o as THREE.Mesh;
            const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
            for (const m of mats) {
                const std = m as THREE.MeshStandardMaterial;
                if (!std.isMeshStandardMaterial) continue;
                std.emissive = std.color.clone();
                if (std.map) std.emissiveMap = std.map; // emissive follows the texture, not a flat tint
                std.emissiveIntensity = STRIKER_EMISSIVE;
                std.needsUpdate = true;
            }
        });
        state.scene.add(striker);
        state.striker = striker;

        // The cats loitering around it — wandering the floor, playing dumb (see cats.ts).
        await loadCats(state.cats, state.scene, state.physics, state.interactables, state.navigation, {
            url: CAT_URL,
            count: CATS_COUNT,
            center: CATS_CENTER,
            spread: CATS_SPREAD,
            height: CAT_HEIGHT,
            yNudge: CAT_Y_NUDGE,
            onTalk: (cat) => talkToCat(state, cat),
        });
    } catch (err) {
        console.warn('finale assets failed to load (striker/cats):', err);
    }
}

const _moveDir: Vec3 = [0, 0, 0];
const _playerPos: Vec3 = [0, 0, 0];
const TALK_RANGE = 2; // metres — ray-hit a character/cat within this ⇒ nameplate + prompt + talkable

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

function update(state: State, dt: number, time: number) {
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

    updateCharacters(state.characters, state.navigation, state.physics, _playerPos, dt);
    updateCharacterVisuals(state.characterVisuals, state.characters.list, dt);

    // Shadows: the collider mesh is the receiver (attachShadowCatcher); here we just follow the
    // shadow frustum on the player, using the grounded feet Y so it doesn't ride up on a jump.
    if (isOnGround(state.character)) state.groundY = pf[1];
    updateShadows(state.shadows, pf[0], state.groundY, pf[2]);

    // Crowd debug: draw a cylinder per live agent (companions + the player proxy).
    if (state.debug.showCrowd && state.navigation.crowd) {
        updateCrowdDebug(state.debug, Object.values(state.navigation.crowd.agents));
    }

    // Companion lighting from the baked probe volume is entirely on the GPU (the material
    // samples the SH atlas per-fragment at each companion's world position — see
    // character-visuals + light-probes), so there's no per-frame CPU probe work here.

    // The cats wander; the striker bobs (until the finale launch takes over its transform).
    updateCats(state.cats, state.navigation, state.physics, state.interactables, _playerPos, dt);
    updateLaunch(state, dt);
    if (state.striker && !state.launch.active)
        state.striker.position.y = STRIKER_POS[1] + Math.sin(time * STRIKER_BOB_FREQ * Math.PI * 2) * STRIKER_BOB_AMP;

    if (state.fp.enabled) {
        // While talking / in a scripted scene, smoothly turn the view onto the focus point.
        if (state.focus) faceFirstPersonToward(state.fp, state.character, state.focus, dt);
        updateFirstPersonCamera(state.fp, state.character, dt);
    } else {
        state.controls.update();
    }

    // Interaction: cast a view ray out to TALK_RANGE. If it lands on a character or a cat within
    // that range (walls occlude), you can talk to them — a single range, so there's no dead zone
    // where the nameplate shows but you can't interact. Suppressed while a dialogue is open.
    if (state.fp.enabled && !isDialogueOpen(state.dialogue)) {
        const hitBody = castViewRay(state.physics, state.camera, TALK_RANGE);
        const charId = hitBody != null ? state.physics.bodyToCharacter.get(hitBody) : undefined;
        const hoveredChar = charId ? (state.characters.list.find((c) => c.id === charId) ?? null) : null;
        const hoveredIt = hitBody != null ? interactableAt(state.interactables, hitBody) : null;

        let target: NameTarget | null = null;
        let action: (() => void) | null = null;
        if (hoveredChar) {
            target = { name: hoveredChar.model, verb: 'talk' };
            action = () => talkToCharacter(state, hoveredChar);
        } else if (hoveredIt) {
            target = { name: hoveredIt.label, verb: hoveredIt.verb };
            action = hoveredIt.onInteract;
        }

        // Hovering (a ray hit within range) IS being in range — show the prompt + allow the click.
        updateNameplate(state.nameplate, target, target !== null);
        const pressed = state.fp.input.interact;
        state.fp.input.interact = false; // consume the one-shot press
        if (pressed && action) action();
    } else {
        updateNameplate(state.nameplate, null, false);
    }
    setCrosshairVisible(state.crosshair, state.fp.enabled);
    // Desktop control hints: only during free play (hidden on touch, in dialogue, and cutscenes).
    setControlsHintVisible(
        state.controlsHint,
        !IS_TOUCH && state.fp.enabled && !isDialogueOpen(state.dialogue) && !state.launch.active,
    );

    // World-space objective marker — over the current suspect / the ship, an edge arrow when
    // off-screen. Hidden while a dialogue or the launch cutscene is running.
    const objBusy = isDialogueOpen(state.dialogue) || state.launch.active || !state.fp.enabled;
    const objKey = objBusy ? null : objectiveTarget(state.quest);
    const objPos = objKey ? markerAnchor(state, objKey) : null;
    updateObjectiveMarker(state.objectiveMarker, objPos, objectiveShort(state.quest), state.camera, state.renderer);

    // Objective trail: recompute the route every frame so the ribbon tracks you continuously. The
    // chevron PLACEMENT is anchored to world space inside the trail (goal-end sampling + goal-anchored
    // UVs + light easing), so individual chevrons hold their spots instead of jumping as the path
    // re-solves.
    if (!objKey) {
        hidePathTrail(state.pathTrail);
    } else {
        const goal = objectiveGoal(state, objKey);
        const feet = state.character.kcc.position;
        // Use the GROUNDED feet Y (held steady on jumps, like the shadows) — not the live y — so the
        // ribbon stays on the floor instead of leaping up with you when you jump.
        const corners = goal ? computePath(state.navigation, [feet[0], state.groundY, feet[2]], goal) : null;
        if (corners) {
            const dots = resamplePath(corners);
            // Ground each dot on the real collider floor. On a ray miss, DON'T fall back to the raw
            // navmesh height (it can sit below the visible floor → the ribbon dips underground) —
            // reuse the last good floor Y instead. Dots run player→goal, so seed from the grounded Y.
            let lastY = state.groundY;
            for (const d of dots) {
                const fy = groundAt(state.physics, d[0], d[2], d[1] + 1.5, 4); // taller ray = fewer misses
                if (fy !== null) lastY = fy;
                d[1] = lastY;
            }
            setPathTrail(state.pathTrail, dots);
        } else {
            hidePathTrail(state.pathTrail);
        }
        updatePathTrail(state.pathTrail, time);
    }

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
// Max simulation step (seconds). A frame slower than this (a hitch) is integrated as if it were
// this long, so the crowd/physics advance smoothly instead of teleporting. ~20fps floor.
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
        // Clamp dt: a frame hitch (splat LOD streaming, GC, tab refocus) otherwise feeds one huge
        // step into the crowd/physics/character integration and teleports every agent — the
        // "everything janks up every so often" jumps, worst during the initial streaming storm.
        const dt = Math.min((now - lastTime) / 1000, MAX_DT);
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
        } else if (!titleShown) {
            // Scene's on screen — show the title card. Clicking it captures the pointer (desktop)
            // and rolls the opening cutscene (ship + cats + premise).
            titleShown = true;
            showTitle(() => {
                if (!IS_TOUCH) state.renderer.domElement.requestPointerLock();
                playScene(state, INTRO);
            });
        }

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
