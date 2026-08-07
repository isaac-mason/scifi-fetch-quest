// "Where Are the Keys?" — the striker's keys have vanished and the crew are stranded. You walk
// the ship as the crew blame each other in a chain (George → Leela → Mike → Stan), each joining
// the trail behind you. Stan's cameras reveal the twist: none of the crew took them — it was the
// CAT, waiting out by the ship. You confront it, it gloats, boards the striker with the
// keys, and flies off — leaving the crew to sheepishly apologise to each other.
//
// All the quest's data lives in two tables: STAGE_LIST (one entry per stage — the talkable, the
// objective lines, where the marker points, and the active exchange) and CREW (per-member barks
// for talking out of turn / after the case is closed). Everything else is a thin accessor.

import type { DialogueNode } from './dialogue';

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
            choices: [
                { label: 'why leela?', reply: 'shifty optics. she looks at everything sideways. she skulks at the bar.' },
                { label: "where's leela?", reply: 'the bar. tell her george is watching. always watching.' },
                { label: 'did YOU lose them?', reply: 'i do not lose things. it was leela. the bar. go.' },
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
            choices: [
                { label: 'the keys. was it you?', reply: 'me? please. it was mike, always elbow deep in the wiring.' },
                { label: 'george says it was you.', reply: 'george is very confident and very wrong. go bug mike.' },
                { label: 'start talking, leela.', reply: "fine. it was mike. herbarium, past the ferns. you're welcome." },
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
            choices: [
                {
                    label: 'the missing keys, mike.',
                    reply: "not me. i've been with the ferns all cycle. ask stan, he watches the cameras.",
                },
                { label: 'leela pinned it on you.', reply: "leela's wrong a lot. have you met leela? go see stan." },
                { label: 'you look guilty.', reply: 'i look like a man who gardens. stan sees everything. control room.' },
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
            choices: [
                {
                    label: 'the footage. show me.',
                    reply: 'i pulled it. not leela, not mike, not george. it was the CAT, out by the ship.',
                },
                {
                    label: 'mike says you know something.',
                    reply: 'i know plenty. six cameras, one very smug cat. it took the keys. go.',
                },
                {
                    label: "so who's left, stan?",
                    reply: 'the cat. it herded you all like mice. it is out by the ship right now. move.',
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
            choices: [
                { label: 'it was you?', reply: 'obviously. i just needed everyone looking the other way.' },
                { label: 'give those back!', reply: 'no. thanks for the distraction though. ta.' },
                { label: 'you played us.', reply: 'purr-fectly. byeee.' },
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
    choices: [
        { label: 'meow!', reply: '' },
        { label: 'meow', reply: '' },
        { label: 'meow?', reply: '' },
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
    if (q.stage === 'closed') text = crew?.apology ?? '…';
    else if (q.stage === 'cat') text = "quit gawking, the cat's at the ship!";
    else if (following) text = crew?.theory ?? '…';
    else text = crew?.deflect ?? '…';
    return {
        speaker: model.toLowerCase(),
        text,
        choices: [{ label: q.stage === 'closed' ? '…yeah.' : 'right.', reply: '' }],
    };
}

// The node to show when the player talks to `model`, plus whether it's the ACTIVE exchange
// (talking to the current talkable — the caller advances the quest when this one finishes).
export function dialogueFor(q: Quest, model: string): { node: DialogueNode; active: boolean } {
    const info = STAGE_BY[q.stage];
    if (info.suspect === model && info.node) return { node: info.node, active: true };
    return { node: bark(model, q), active: false };
}
