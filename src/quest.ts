// "Where Are the Keys?" — the striker's keys have vanished and the crew are stranded. You walk
// the ship as the crew blame each other in a chain (George → Leela → Mike → Stan), each joining
// the trail behind you. Stan's cameras reveal the twist: none of the crew took them — it was the
// CAT, waiting out by the ship. You confront it, it gloats, boards the striker with the
// keys, and flies off — leaving the crew to sheepishly apologise to each other.
//
// The quest's DATA lives in two tables: STAGE_LIST (one entry per stage — the talkable, the
// objective lines, where the marker points, and the active exchange) and CREW (per-member barks for
// talking out of turn / after the case is closed). Everything else is a thin accessor.
//
// The quest's RUNTIME lives below the data (see "Quest runtime orchestration"): the talk handlers,
// the scripted-scene runner, and the finale state machine — the glue that turns the data into
// played-out beats. It operates on the app State (passed in), so all the quest lives in one file.

import type { Vec3 } from 'mathcat';
import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
    allCatsGathered,
    boardCats,
    type Character,
    despawnCats,
    hopCats,
    isTalkable,
    requestCharacterEmote,
    setCatTalking,
    setCharacterFollowing,
    setFacePlayer,
} from './characters';
import { setControlsPaused } from './controls';
import { type DialogueNode, isDialogueOpen, openDialogue, showLine } from './dialogue';
import type { State } from './index';
import { type NameTarget, updateNameplate } from './nameplate';
import { setObjective } from './quest-hud';
import {
    STRIKER_BOARD_POS,
    STRIKER_BOB_AMP,
    STRIKER_BOB_FREQ,
    STRIKER_EMISSIVE,
    STRIKER_POS,
    STRIKER_SCALE,
    STRIKER_URL,
    STRIKER_YAW,
} from './scene';
import { castViewRay } from './view-ray';

export type Stage = 'george' | 'leela' | 'mike' | 'stan' | 'cat' | 'closed';
export type Quest = { stage: Stage };

export function initQuest(): Quest {
    return { stage: 'george' };
}

// One entry per stage, in quest order.
type StageInfo = {
    stage: Stage;
    suspect: string | null; // model you talk to this stage ('cat' = the cat); null once closed
    marker: string | null; // objective-marker target ('George'…'Stan' | 'ship'); null once closed
    objective: string; // full HUD line
    short: string; // objective-marker label
    node: DialogueNode | null; // the ACTIVE exchange shown when you talk to `suspect`
};

const STAGE_LIST: StageInfo[] = [
    {
        stage: 'george',
        suspect: 'George',
        marker: 'George',
        objective: 'the striker keys are missing. go ask george at the entrance.',
        short: 'talk to george',
        node: {
            speaker: 'george',
            text: "the striker's KEYS are gone. we're stranded. it was leela, i just know it.",
            emote: 'No',
            choices: [
                {
                    label: 'why leela?',
                    reply: 'shifty optics. she looks at everything sideways. she skulks at the bar.',
                    emote: 'No',
                },
                { label: "where's leela?", reply: 'the bar. tell her george is watching. always watching.', emote: 'Yes' },
                { label: 'did YOU lose them?', reply: 'i do not lose things. it was leela. the bar. go.', emote: 'No' },
            ],
        },
    },
    {
        stage: 'leela',
        suspect: 'Leela',
        marker: 'Leela',
        objective: 'george blames leela. find her at the bar.',
        short: 'talk to leela',
        node: {
            speaker: 'leela',
            text: '',
            emote: 'No',
            choices: [
                {
                    label: 'the keys. was it you?',
                    reply: 'me? please. it was mike, always elbow deep in the wiring.',
                    emote: 'No',
                },
                { label: 'george says it was you.', reply: 'george is very confident and very wrong. go bug mike.', emote: 'No' },
                {
                    label: 'start talking, leela.',
                    reply: "fine. it was mike. herbarium, past the ferns. you're welcome.",
                    emote: 'Yes',
                },
            ],
        },
    },
    {
        stage: 'mike',
        suspect: 'Mike',
        marker: 'Mike',
        objective: 'leela blames mike. find him in the herbarium.',
        short: 'talk to mike',
        node: {
            speaker: 'mike',
            text: '',
            emote: 'No',
            choices: [
                {
                    label: 'the missing keys, mike.',
                    reply: "not me. i've been with the ferns all cycle. ask stan, he watches the cameras.",
                    emote: 'No',
                },
                { label: 'leela pinned it on you.', reply: "leela's wrong a lot. have you met leela? go see stan.", emote: 'No' },
                {
                    label: 'you look guilty.',
                    reply: 'i look like a man who gardens. stan sees everything. control room.',
                    emote: 'Yes',
                },
            ],
        },
    },
    {
        stage: 'stan',
        suspect: 'Stan',
        marker: 'Stan',
        objective: 'mike blames stan. find him in the control room.',
        short: 'talk to stan',
        node: {
            speaker: 'stan',
            text: '',
            emote: 'No',
            choices: [
                {
                    label: 'the footage. show me.',
                    reply: 'i pulled it. not leela, not mike, not george. it was the CAT, out by the ship.',
                    emote: 'Yes',
                },
                {
                    label: 'mike says you know something.',
                    reply: 'i know plenty. six cameras, one very smug cat. it took the keys. go.',
                    emote: 'Yes',
                },
                {
                    label: "so who's left, stan?",
                    reply: 'the cat. it herded you all like mice. it is out by the ship right now. move.',
                    emote: 'Yes',
                },
            ],
        },
    },
    {
        stage: 'cat',
        suspect: 'cat',
        marker: 'ship',
        objective: 'it was never the crew. the cat had the keys all along. get to the ship!',
        short: 'go to the ship',
        node: {
            speaker: 'cat',
            text: 'kekeke. they really thought one of THEM took the keys?',
            emote: 'Spin',
            choices: [
                { label: 'it was you?', reply: 'obviously. i just needed everyone looking the other way.', emote: 'Spin' },
                { label: 'give those back!', reply: 'no. thanks for the distraction though. ta.', emote: 'Spin' },
                { label: 'you played us.', reply: 'purr-fectly. byeee.', emote: 'Spin' },
            ],
        },
    },
    {
        stage: 'closed',
        suspect: null,
        marker: null,
        objective: 'the cat took the striker. the crew are... apologising.',
        short: '',
        node: null,
    },
];

const STAGE_BY = Object.fromEntries(STAGE_LIST.map((s) => [s.stage, s])) as Record<Stage, StageInfo>;

// The quest order (also drives the debug stage-skip buttons + advance).
export const STAGES: Stage[] = STAGE_LIST.map((s) => s.stage);

// The model that's the current talkable ('cat' at the reveal; null once closed).
export function currentSuspect(q: Quest): string | null {
    return STAGE_BY[q.stage].suspect;
}
export function objective(q: Quest): string {
    return STAGE_BY[q.stage].objective;
}
export function objectiveShort(q: Quest): string {
    return STAGE_BY[q.stage].short;
}
export function objectiveTarget(q: Quest): string | null {
    return STAGE_BY[q.stage].marker;
}

// Advance to the next stage after the current talkable's exchange.
export function advance(q: Quest): void {
    const i = STAGES.indexOf(q.stage);
    if (i >= 0 && i < STAGES.length - 1) q.stage = STAGES[i + 1];
}

// Per-crew-member barks: parked at their post waiting their turn (deflect), trailing you in the
// conga line after you've confronted them so they muse their theory (theory), or the aftermath
// once the case is closed (apology).
const CREW: Record<string, { deflect: string; theory: string; apology: string }> = {
    George: {
        deflect: "i've said my piece. go sort out the others.",
        theory: 'still says leela to me. nobody skulks like that innocently.',
        apology: "leela… i'm sorry i said your optics were shifty. they're lovely optics.",
    },
    Leela: {
        deflect: "i'm at my post. unless it's about the keys, scram.",
        theory: 'it was mike, i just know it. the quiet ones always crack.',
        apology: 'mike, my bad. you were just standing there building things. innocently.',
    },
    Mike: {
        deflect: 'mind the ferns, they bruise.',
        theory: 'stan is too quiet. bet those cameras saw plenty.',
        apology: "we lost a spaceship to a house cat. let's never speak of it again.",
    },
    Stan: {
        deflect: "busy. cameras don't watch themselves.",
        theory: 'the footage never lies. someone here is guilty.',
        apology: 'for the record, my cameras performed flawlessly.',
    },
};

// Talking to the cat BEFORE the reveal — it just plays dumb. You can only meow back.
export const CAT_MEOW: DialogueNode = {
    speaker: 'cat',
    text: 'meow?',
    emote: 'Idle',
    choices: [
        { label: 'meow!', reply: '', emote: 'Idle' },
        { label: 'meow', reply: '', emote: 'Idle' },
        { label: 'meow?', reply: '', emote: 'Idle' },
    ],
};

function bark(model: string, q: Quest): DialogueNode {
    const crew = CREW[model];
    // Following once the quest has moved past this member's own accusation stage: then they trail
    // you and muse their theory, rather than shooing you off (which only fits at their post).
    const myIdx = STAGES.indexOf(model.toLowerCase() as Stage);
    const curIdx = STAGES.indexOf(q.stage);
    const following = myIdx >= 0 && myIdx < curIdx;
    let text: string;
    let emote: string;
    if (q.stage === 'closed') {
        text = crew?.apology ?? '…';
        emote = 'Yes'; // a contrite nod
    } else if (q.stage === 'cat') {
        text = "quit gawking, the cat's at the ship!";
        emote = 'No'; // shooing you off
    } else if (following) {
        text = crew?.theory ?? '…';
        emote = 'No'; // still suspicious
    } else {
        text = crew?.deflect ?? '…';
        emote = 'No'; // brush-off at their post
    }
    return {
        speaker: model.toLowerCase(),
        text,
        emote,
        choices: [{ label: q.stage === 'closed' ? '…yeah.' : 'right.', reply: '', emote }],
    };
}

// The node to show when the player talks to `model`, plus whether it's the ACTIVE exchange
// (talking to the current talkable — the caller advances the quest when this one finishes).
export function dialogueFor(q: Quest, model: string): { node: DialogueNode; active: boolean } {
    const info = STAGE_BY[q.stage];
    if (info.suspect === model && info.node) return { node: info.node, active: true };
    return { node: bark(model, q), active: false };
}

// ============================================================================
// Quest runtime orchestration — the played-out beats (talk handlers, cutscenes, finale). Operates
// on the app State (index.ts); index calls the exported entry points (talkToCharacter, talkToCat,
// updateLaunch, skipToStage, startIntro) and reads state.focus / state.launch to drive the camera.
// ============================================================================

// Pause the controller and lerp the view onto a world point (setControlsPaused freezes look;
// faceFirstPersonToward turns toward `focus` each frame in the update loop).
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
export function talkToCharacter(state: State, ch: Character): void {
    const { node, active } = dialogueFor(state.quest, ch.model);
    setFacePlayer(ch, true); // turn to look at us while we talk
    beginFocus(state, [ch.position[0], ch.position[1] + ch.headHeight, ch.position[2]]);
    const emote = (e: string) => requestCharacterEmote(state.characters, ch.id, e); // authored per-line gesture
    const done = () => {
        setFacePlayer(ch, false);
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
    else showLine(state.dialogue, node.speaker, node.text, node.emote, done, emote);
}

// Talk to a cat. Before the reveal it plays dumb ("meow?"); at the reveal (stage 'cat') any
// cat gloats — they were all in on it — then the whole mob boards and the striker flies off.
export function talkToCat(state: State, ch: Character): void {
    const revealing = state.quest.stage === 'cat';
    const node = revealing ? dialogueFor(state.quest, 'cat').node : CAT_MEOW;
    setCatTalking(ch, true);
    beginFocus(state, [ch.position[0], ch.position[1] + ch.headHeight, ch.position[2]]);
    const emote = (e: string) => requestCharacterEmote(state.characters, ch.id, e); // cat clips (Spin/Idle)
    openDialogue(
        state.dialogue,
        node,
        () => {
            setCatTalking(ch, false);
            if (revealing) {
                advance(state.quest); // → closed
                setObjective(state.questHud, objective(state.quest));
                startLaunch(state, ch); // follow THIS cat aboard; keeps controls paused → apology scene
            } else {
                endFocus(state);
            }
        },
        emote,
    );
}

// The crew's sheepish aftermath, watched as a scripted scene (camera pans to each).
const APOLOGY_SCENE: SceneStep[] = [
    {
        focus: 'George',
        speaker: 'george',
        text: "leela… i'm sorry i said your optics were shifty. they're lovely optics.",
        emote: 'No',
    },
    {
        focus: 'Leela',
        speaker: 'leela',
        text: 'it happens. mike — my bad too. you were just standing there building things.',
        emote: 'Yes',
    },
    {
        focus: 'Mike',
        speaker: 'mike',
        text: "we lost a spaceship to a pile of cats. let's never speak of it again.",
        emote: 'No',
    },
    { focus: 'Stan', speaker: 'stan', text: 'for the record — my cameras performed flawlessly.', emote: 'Dance' },
];

const GATHER_ARRIVE = 0.9; // a cat this close to its under-ship target counts as gathered
const GATHER_TIMEOUT = 6.0; // safety cap: lower the ship even if a cat never makes it under
const LOWER_DUR = 1.6; // seconds the ship takes to descend to boarding height
const HOP_TIMEOUT = 1.2; // safety cap on the hop-in before we force-clear any stragglers
const LAUNCH_DUR = 4.0; // seconds of the striker's climb-out
const STRIKER_BOARD_Y = 1.0; // world y the ship lowers to so the cats can hop aboard

// Kick off the finale: the cats stampede to the ground under the striker (we follow the one you
// just talked to), the ship lowers to meet them, they hop in, then it flies off (updateLaunch).
function startLaunch(state: State, hero: Character): void {
    if (!state.striker) {
        endFocus(state);
        return;
    }
    state.launch.active = true;
    state.launch.t = 0;
    state.launch.phase = 'gather';
    state.launch.cat = hero;
    boardCats(state.characters, state.navigation, STRIKER_BOARD_POS); // run to the floor under the ship
}

// Camera follows the cat you talked to (at floor level) while it's still around, else the ship.
function focusHeroOrShip(state: State, s: THREE.Object3D): void {
    const hero = state.launch.cat;
    if (hero && state.characters.list.includes(hero)) {
        state.focus = [hero.position[0], hero.position[1] + 0.35, hero.position[2]];
    } else {
        state.focus = [s.position.x, s.position.y, s.position.z];
    }
}

// True while any cat remains (finale gather/hop gating). Cats live in `characters` (model 'cat').
const catsRemain = (state: State): boolean => state.characters.list.some((c) => c.model === 'cat');

// Per-frame striker: bob gently on the pad while idle, or — once the finale is launched — run the
// boarding machine: (1) gather — cats run to the floor under the ship while it descends to meet
// them; (2) hop — they leap up into it and despawn; (3) ascend — it flies up and away, then the
// crew's apology cutscene plays.
export function updateStriker(state: State, dt: number, time: number): void {
    const s = state.striker;
    if (!s) return;
    if (!state.launch.active) {
        // Idle float: a gentle bob until the launch takes over the transform.
        s.position.y = STRIKER_POS[1] + Math.sin(time * STRIKER_BOB_FREQ * Math.PI * 2) * STRIKER_BOB_AMP;
        return;
    }
    state.launch.t += dt;

    if (state.launch.phase === 'gather') {
        // Cats walk to the ground under the ship; the ship holds at its float height. Wait until
        // they're ALL there (or a straggler times out) before lowering.
        s.position.set(STRIKER_POS[0], STRIKER_POS[1], STRIKER_POS[2]);
        focusHeroOrShip(state, s);
        const allHere = !catsRemain(state) || allCatsGathered(state.characters, state.navigation, GATHER_ARRIVE);
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
            hopCats(state.characters, [s.position.x, s.position.y, s.position.z]); // now they leap in
            state.launch.phase = 'hop';
            state.launch.t = 0;
        }
        return;
    }

    if (state.launch.phase === 'hop') {
        // Hold the ship low while the cats arc up into it (they despawn at the end of their hop).
        s.position.set(STRIKER_POS[0], STRIKER_BOARD_Y, STRIKER_POS[2]);
        focusHeroOrShip(state, s);
        if (catsRemain(state) && state.launch.t < HOP_TIMEOUT) return;
        despawnCats(state.characters, state.navigation, state.physics); // clear stragglers
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
export function skipToStage(state: State, stage: string): void {
    state.quest.stage = stage as Stage;
    setObjective(state.questHud, objective(state.quest));
    const idx = STAGES.indexOf(state.quest.stage);
    for (const ch of state.characters.list) {
        if (ch.behaviour.kind !== 'follow') continue; // cats aren't part of the conga line
        const chIdx = STAGES.indexOf(ch.model.toLowerCase() as Stage);
        if (chIdx >= 0) ch.behaviour.mode = chIdx < idx ? 'following' : 'stationary';
    }
    console.log('quest → stage:', stage);
}

// Emote the crew member a scene line is spoken by (matched by model name), if any.
function emoteByModel(state: State, model: string, emote: string): void {
    const ch = state.characters.list.find((c) => c.model.toLowerCase() === model.toLowerCase());
    if (ch) requestCharacterEmote(state.characters, ch.id, emote);
}

// --- Scripted-scene runner (NPC-to-NPC exchanges you watch) ---
// A scene is a list of lines; each names who's speaking (`speaker`, the panel label) and what to
// look at (`focus` — a crew model, 'ship', 'cats', or '' for no change). The camera lerps to the
// focus (faceFirstPersonToward in update), you click through the lines, then control returns.
type SceneStep = { focus: string; speaker: string; text: string; emote: string };

// Resolve a scene's `focus` key to a world point to look at.
function locate(state: State, key: string): Vec3 | null {
    if (key === 'ship')
        return state.striker ? [state.striker.position.x, state.striker.position.y, state.striker.position.z] : null;
    if (key === 'cats') {
        const c = state.characters.list.find((ch) => ch.model === 'cat');
        return c ? [c.position[0], c.position[1] + c.headHeight, c.position[2]] : null;
    }
    const ch = state.characters.list.find((c) => c.model === key);
    return ch ? [ch.position[0], ch.position[1] + ch.headHeight, ch.position[2]] : null;
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
        showLine(state.dialogue, s.speaker, s.text, s.emote, next, (e) => emoteByModel(state, s.speaker, e));
    };
    next();
}

// The opening cutscene: George shows you the (going-nowhere) ship, the useless cats, and the
// missing-keys premise. index plays this once the title card is dismissed.
const INTRO: SceneStep[] = [
    { focus: 'George', speaker: 'george', text: 'oh, hi. you must be the new deckhand. welcome to the striker.', emote: 'Yes' },
    {
        focus: 'ship',
        speaker: 'george',
        text: "she's fuelled, she's polished, and she is going absolutely nowhere.",
        emote: 'No',
    },
    {
        focus: 'cats',
        speaker: 'george',
        text: 'because the keys are gone. and this lot of freeloaders are no help whatsoever.',
        emote: 'No',
    },
    {
        focus: 'George',
        speaker: 'george',
        text: 'point is, we are not going anywhere. so. any bright ideas, deckhand?',
        emote: 'Yes',
    },
];

// Roll the opening cutscene (index fires this from the title card's dismiss).
export function startIntro(state: State): void {
    playScene(state, INTRO);
}

// Load the striker — the finale prop: the floating .gltf on the outside pad. It bobs / launches via
// updateStriker. Self-lit from its own texture (the fill lights are dim, and it doesn't get the
// baked probe volume the companions do). Resilient — a missing/failed asset just logs and leaves
// state.striker null, so the rest of the scene survives.
export async function loadStriker(state: State): Promise<void> {
    try {
        const gltf = await new GLTFLoader().loadAsync(STRIKER_URL);
        const striker = gltf.scene;
        striker.position.set(STRIKER_POS[0], STRIKER_POS[1], STRIKER_POS[2]);
        striker.scale.setScalar(STRIKER_SCALE);
        striker.rotation.y = STRIKER_YAW;
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
    } catch (err) {
        console.warn('finale asset failed to load (striker):', err);
    }
}

const TALK_RANGE = 2; // metres — ray-hit a character/cat within this ⇒ nameplate + prompt + talkable

// Per-frame interaction: cast a view ray to TALK_RANGE; if it lands on a talkable character (crew or
// cat) within range (walls occlude), show the nameplate + prompt and, on the interact press, open
// their talk flow. Suppressed while a dialogue is open or the controller isn't driving the camera.
export function updateInteraction(state: State): void {
    if (!state.fp.enabled || isDialogueOpen(state.dialogue)) {
        updateNameplate(state.nameplate, null, false);
        return;
    }
    const hitBody = castViewRay(state.physics, state.camera, TALK_RANGE);
    const charId = hitBody != null ? state.physics.bodyToCharacter.get(hitBody) : undefined;
    const hoveredChar = charId ? (state.characters.list.find((c) => c.id === charId) ?? null) : null;

    let target: NameTarget | null = null;
    let action: (() => void) | null = null;
    if (hoveredChar && isTalkable(hoveredChar)) {
        const ch = hoveredChar;
        target = { name: ch.name, verb: 'talk' };
        // Cats (wander) play the meow/reveal flow; crew (follow) open their quest node.
        action = () => (ch.behaviour.kind === 'wander' ? talkToCat(state, ch) : talkToCharacter(state, ch));
    }
    // Hovering (a ray hit within range) IS being in range — show the prompt + allow the click.
    updateNameplate(state.nameplate, target, target !== null);
    const pressed = state.fp.input.interact;
    state.fp.input.interact = false; // consume the one-shot press
    if (pressed && action) action();
}
