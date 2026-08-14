// A radial dialogue menu. The NPC's line shows in a panel; the player's responses sit on a
// wheel around the crosshair. A needle grows from the centre toward your aim and a centre hub
// lights up with the current pick, so it's readable at a glance.
//
// Input, two ways:
//   • Desktop (pointer-locked): the mouse STAYS locked — flick toward a response to aim, then
//     left-click to pick (number keys 1-3 also work). The controller is paused
//     (setControlsPaused) so the same deltas drive the wheel instead of the camera.
//   • Touch: drag from the centre to aim (or just tap toward a response) and lift to pick.
//
// Then the NPC's reply shows; click / tap / space / E continues. Self-contained DOM overlay
// (like nameplate/crosshair) — owns none of the quest logic, just the interaction. The caller
// opens a node and gets the chosen index back.

export type DialogueChoice = { label: string; reply: string; emote: string };
// `emote` — the clip the speaker plays as this line is delivered (authored per line, never random).
// A node's `emote` punctuates its opening line; a choice's `emote` punctuates its reply. Every line
// carries one (crew clips: Yes/No/Dance; cat clips: Spin/Idle).
export type DialogueNode = { speaker: string; text: string; choices: DialogueChoice[]; emote: string };

import { blip, charPitch, speakerPitch } from './voice';

// Coarse pointer → no pointer lock / mouse deltas, so use absolute touch-position aiming.
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Screen-space unit directions (x right, y down) the response chips sit along, by choice count.
const OPT_DIRS: Record<number, [number, number][]> = {
    1: [[0, -1]],
    2: [
        [-1, 0],
        [1, 0],
    ],
    3: [
        [0, -1],
        [-0.87, 0.6],
        [0.87, 0.6],
    ],
};
const SENS = 0.9; // desktop: aim-pixels per mouse-move pixel (flick sensitivity)
const MIN_ALIGN = 0.3; // min dot(aim, dir) to count as pointing at a chip
const NEEDLE_MIN = 5; // show the needle once the aim pushes past this many px

// Accent lives in one custom prop (--acc) — swap it to retheme the whole wheel. No
// backdrop-filter (too costly over the live splat scene) and no glows: opaque panels +
// the accent colour carry legibility instead.
const CSS = `
.dlg-root { position:fixed; inset:0; z-index:1002; pointer-events:none; display:none; font-family:monospace; --acc:#ffb454; }
.dlg-root.dlg-open { display:block; }
.dlg-root.dlg-touch.dlg-open { pointer-events:auto; touch-action:none; }
.dlg-line {
  position:absolute; left:50%; bottom:12%; transform:translateX(-50%);
  width:min(600px,88vw); box-sizing:border-box; padding:12px 18px; text-align:left;
  background:rgba(10,12,15,0.82); border:1px solid rgba(255,255,255,0.16); border-radius:3px;
  color:#fff; font-size:16px; line-height:1.5; text-shadow:0 1px 2px rgba(0,0,0,0.9);
}
.dlg-speaker { display:block; margin-bottom:5px; font-size:12px; letter-spacing:2px; text-transform:lowercase; color:var(--acc); }
.dlg-hint { margin-top:7px; font-size:12px; letter-spacing:1px; text-align:center; color:rgba(255,255,255,0.9); }
.dlg-wheel { position:absolute; left:50%; top:50%; width:0; height:0; }
.dlg-ring { position:absolute; left:0; top:0; transform:translate(-50%,-50%); border-radius:50%;
  border:1px solid rgba(255,255,255,0.16); background:rgba(10,12,15,0.42); }
.dlg-needle { position:absolute; left:0; top:-1.5px; height:3px; transform-origin:0 50%; border-radius:3px;
  background:linear-gradient(90deg, rgba(255,255,255,0.12), var(--acc)); opacity:0; }
.dlg-needle.on { opacity:0.95; }
.dlg-needle::after { content:''; position:absolute; right:-3px; top:50%; width:8px; height:8px; margin-top:-4px;
  border-radius:50%; background:var(--acc); }
.dlg-hub { position:absolute; left:0; top:0; transform:translate(-50%,-50%);
  width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  background:rgba(10,12,15,0.7); border:1px solid rgba(255,255,255,0.24); color:rgba(255,255,255,0.5);
  font-size:16px; transition:color 90ms, background 90ms, border-color 90ms; }
.dlg-hub.active { color:#231400; background:var(--acc); border-color:var(--acc); }
.dlg-opt { position:absolute; transform:translate(var(--tx,-50%),var(--ty,-50%)); white-space:nowrap; max-width:40vw; overflow:hidden; text-overflow:ellipsis; padding:6px 12px; border-radius:2px;
  background:rgba(10,12,15,0.78); border:1px solid rgba(255,255,255,0.22); color:rgba(255,255,255,0.85); font-size:14px;
  transition:border-color 90ms, color 90ms, background 90ms; }
.dlg-opt .k { margin-right:5px; color:rgba(255,255,255,0.4); }
.dlg-opt.hl { color:#fff; border-color:var(--acc); background:rgba(48,34,10,0.92); }
.dlg-opt.hl .k { color:var(--acc); }
.dlg-hidden { display:none; }
`;

// 'prompt' = reading the NPC's line (wheel hidden) → 'choosing' = wheel revealed → 'reply' =
// showing the NPC's comeback. The two-step (read, then reveal) stops the eye jumping to the
// responses before you know what you're answering. 'line' = a wheel-less line the player just
// reads and clicks past (used by showLine for NPC-to-NPC exchanges you watch).
type Phase = 'prompt' | 'choosing' | 'reply' | 'line';

export type Dialogue = {
    root: HTMLDivElement;
    speaker: HTMLSpanElement;
    body: HTMLSpanElement;
    hint: HTMLDivElement;
    wheel: HTMLDivElement;
    ring: HTMLDivElement;
    needle: HTMLDivElement;
    hub: HTMLDivElement;
    opts: HTMLDivElement[];
    open: boolean;
    phase: Phase;
    node: DialogueNode | null;
    choiceIdx: number;
    aim: { x: number; y: number };
    r: number; // ring radius (px), responsive
    maxR: number; // aim clamp
    deadzone: number; // below this aim magnitude, nothing is highlighted
    onDone: ((choiceIndex: number) => void) | null;
    lineDone: (() => void) | null; // continue callback for a 'line' (showLine)
    onSpeak: ((emote: string) => void) | null; // fired as each line starts typing; passes the line's authored emote
    cleanup: (() => void) | null;
    // Typewriter (animalese) state: text reveals char-by-char with a blip per char.
    typing: boolean;
    fullText: string;
    typeIdx: number;
    typeTimer: number;
    speakerBase: number; // per-speaker base pitch
};

export function createDialogue(): Dialogue {
    if (!document.getElementById('dlg-style')) {
        const style = document.createElement('style');
        style.id = 'dlg-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.className = IS_TOUCH ? 'dlg-root dlg-touch' : 'dlg-root';
    root.innerHTML = `
      <div class="dlg-line">
        <span class="dlg-speaker"></span><span class="dlg-body"></span>
        <div class="dlg-hint"></div>
      </div>
      <div class="dlg-wheel">
        <div class="dlg-ring"></div>
        <div class="dlg-needle"></div>
        <div class="dlg-hub"></div>
      </div>`;
    document.body.appendChild(root);

    return {
        root,
        speaker: root.querySelector('.dlg-speaker') as HTMLSpanElement,
        body: root.querySelector('.dlg-body') as HTMLSpanElement,
        hint: root.querySelector('.dlg-hint') as HTMLDivElement,
        wheel: root.querySelector('.dlg-wheel') as HTMLDivElement,
        ring: root.querySelector('.dlg-ring') as HTMLDivElement,
        needle: root.querySelector('.dlg-needle') as HTMLDivElement,
        hub: root.querySelector('.dlg-hub') as HTMLDivElement,
        opts: [],
        open: false,
        phase: 'choosing',
        node: null,
        choiceIdx: -1,
        aim: { x: 0, y: 0 },
        r: 92,
        maxR: 74,
        deadzone: 26,
        onDone: null,
        lineDone: null,
        onSpeak: null,
        cleanup: null,
        typing: false,
        fullText: '',
        typeIdx: 0,
        typeTimer: 0,
        speakerBase: 260,
    };
}

// --- Animalese typewriter: reveal `text` a character at a time, blipping per character. ---
const TYPE_CPS = 34; // characters/second

function typeText(d: Dialogue, speaker: string, text: string, emote: string): void {
    clearInterval(d.typeTimer);
    d.fullText = text;
    d.typeIdx = 0;
    d.typing = true;
    d.speakerBase = speakerPitch(speaker);
    d.body.textContent = '';
    d.onSpeak?.(emote); // let the caller punctuate the line with its authored emote
    d.typeTimer = window.setInterval(() => {
        if (d.typeIdx >= text.length) {
            completeType(d);
            return;
        }
        const ch = text[d.typeIdx++];
        d.body.textContent = text.slice(0, d.typeIdx);
        // Blip on every other non-space character — softer, less machine-gun than one per char.
        if (ch.trim() && d.typeIdx % 2 === 0) blip(charPitch(ch, d.speakerBase));
    }, 1000 / TYPE_CPS);
}

// Finish the reveal instantly (a click during typing fast-forwards it, AC-style).
function completeType(d: Dialogue): void {
    clearInterval(d.typeTimer);
    d.typeTimer = 0;
    d.typing = false;
    d.body.textContent = d.fullText;
}

// Fit the wheel to the viewport (small on phones, capped on desktop) and place the chips.
function layout(d: Dialogue): void {
    if (!d.node) return;
    d.r = Math.max(84, Math.min(144, Math.min(window.innerWidth, window.innerHeight) * 0.2));
    d.maxR = d.r * 0.82;
    d.deadzone = d.r * 0.3;

    const size = d.r * 2;
    d.ring.style.width = `${size}px`;
    d.ring.style.height = `${size}px`;

    const dirs = OPT_DIRS[d.node.choices.length] ?? OPT_DIRS[2];
    d.opts.forEach((el, i) => {
        const dir = dirs[i] ?? [0, 0];
        el.style.left = `${dir[0] * d.r}px`;
        el.style.top = `${dir[1] * d.r}px`;
        // Anchor each chip so its label grows AWAY from the wheel centre — right-anchor the left
        // chip, left-anchor the right one, etc. — so long labels never collide in the middle.
        el.style.setProperty('--tx', dir[0] < -0.3 ? '-100%' : dir[0] > 0.3 ? '0%' : '-50%');
        el.style.setProperty('--ty', dir[1] < -0.3 ? '-100%' : dir[1] > 0.3 ? '0%' : '-50%');
    });
}

// Which response the aim currently points at (-1 = none / in the deadzone).
function highlighted(d: Dialogue): number {
    const mag = Math.hypot(d.aim.x, d.aim.y);
    if (mag < d.deadzone || !d.node) return -1;
    const ax = d.aim.x / mag;
    const ay = d.aim.y / mag;
    const dirs = OPT_DIRS[d.node.choices.length] ?? OPT_DIRS[2];
    let best = -1;
    let bestDot = MIN_ALIGN;
    dirs.forEach((dir, i) => {
        const dot = ax * dir[0] + ay * dir[1];
        if (dot > bestDot) {
            bestDot = dot;
            best = i;
        }
    });
    return best;
}

// Redraw the needle (length + angle = aim) + chip highlight + centre hub while choosing.
function render(d: Dialogue): void {
    const mag = Math.hypot(d.aim.x, d.aim.y);
    if (mag > NEEDLE_MIN) {
        d.needle.classList.add('on');
        d.needle.style.width = `${mag}px`;
        d.needle.style.transform = `rotate(${Math.atan2(d.aim.y, d.aim.x)}rad)`;
    } else {
        d.needle.classList.remove('on');
    }

    const hl = highlighted(d);
    d.opts.forEach((el, i) => {
        el.classList.toggle('hl', i === hl);
    });
    d.hub.classList.toggle('active', hl >= 0);
    d.hub.textContent = hl >= 0 ? String(hl + 1) : '·';
}

// Set the aim from an absolute screen point (touch), relative to screen centre, clamped.
function aimFromPoint(d: Dialogue, clientX: number, clientY: number): void {
    let x = clientX - window.innerWidth / 2;
    let y = clientY - window.innerHeight / 2;
    const m = Math.hypot(x, y);
    if (m > d.maxR) {
        x = (x / m) * d.maxR;
        y = (y / m) * d.maxR;
    }
    d.aim.x = x;
    d.aim.y = y;
}

// Advance from a chosen response to the NPC's reply (or straight to done if there's no reply
// — an empty reply is how throwaway one-liner barks close on a single click).
function choose(d: Dialogue, i: number): void {
    if (!d.node) return;
    d.choiceIdx = i;
    if (!d.node.choices[i].reply) {
        finish(d);
        return;
    }
    d.phase = 'reply';
    d.wheel.classList.add('dlg-hidden');
    d.speaker.textContent = d.node.speaker ? `${d.node.speaker} ` : ''; // reply is the NPC (matters when the player spoke first)
    d.hint.textContent = IS_TOUCH ? 'tap to continue' : '‹click› continue';
    typeText(d, d.node.speaker, d.node.choices[i].reply, d.node.choices[i].emote);
}

// Reveal the response wheel after the player has read the NPC's line.
function reveal(d: Dialogue): void {
    d.phase = 'choosing';
    d.wheel.classList.remove('dlg-hidden');
    d.hint.textContent = IS_TOUCH ? 'drag to a reply, or tap it' : 'flick mouse + ‹click›, or 1-3';
    render(d);
}

// Confirm the aimed response. A single-choice node (e.g. a bark) confirms on any click, no
// aiming needed; otherwise the aim must be pointing at a chip.
function confirm(d: Dialogue): void {
    if (d.node && d.node.choices.length === 1) {
        choose(d, 0);
        return;
    }
    const i = highlighted(d);
    if (i >= 0) choose(d, i);
}

// Tear down and hand the chosen index back to the caller.
function finish(d: Dialogue): void {
    if (!d.open) return;
    d.open = false;
    clearInterval(d.typeTimer);
    d.typing = false;
    d.root.classList.remove('dlg-open');
    d.cleanup?.();
    d.cleanup = null;
    const i = d.choiceIdx;
    const cb = d.onDone;
    d.onDone = null;
    d.node = null;
    cb?.(i);
}

// Open a dialogue node. `onDone(choiceIndex)` fires once the player picks a response and
// dismisses the reply. The caller should pause the controller (setControlsPaused) around this.
export function openDialogue(
    d: Dialogue,
    node: DialogueNode,
    onDone: (choiceIndex: number) => void,
    onSpeak?: (emote: string) => void,
): void {
    d.node = node;
    d.onDone = onDone;
    d.onSpeak = onSpeak ?? null;
    d.open = true;
    d.choiceIdx = -1;
    d.aim.x = 0;
    d.aim.y = 0;

    // Rebuild the response chips for this node.
    for (const el of d.opts) el.remove();
    d.opts = node.choices.map((choice, i) => {
        const el = document.createElement('div');
        el.className = 'dlg-opt';
        el.innerHTML = `<span class="k">${i + 1}</span>${choice.label}`;
        d.wheel.appendChild(el);
        return el;
    });

    // An empty `text` means the PLAYER speaks first: skip the NPC opener and drop straight to the
    // response wheel, so you pick your line before they react (used when accusing suspects).
    if (!node.text.trim()) {
        d.phase = 'choosing';
        d.speaker.textContent = '';
        d.body.textContent = '';
        clearInterval(d.typeTimer);
        d.typing = false;
        d.hint.textContent = IS_TOUCH ? 'drag to a reply, or tap it' : 'flick mouse + ‹click›, or 1-3';
        d.wheel.classList.remove('dlg-hidden');
    } else {
        d.phase = 'prompt';
        d.speaker.textContent = node.speaker ? `${node.speaker} ` : '';
        d.hint.textContent = IS_TOUCH ? 'tap for replies' : '‹click› for replies';
        d.wheel.classList.add('dlg-hidden'); // hidden until the line's been read (reveal)
        typeText(d, node.speaker, node.text, node.emote);
    }

    layout(d);
    d.root.classList.add('dlg-open');
    render(d);
    wireInputs(d);
}

// Show a single line the player just reads and clicks past — no wheel, no choice. Used by the
// scene runner for NPC-to-NPC exchanges you watch. `onContinue` fires on the click/tap/key.
export function showLine(
    d: Dialogue,
    speaker: string,
    text: string,
    emote: string,
    onContinue: () => void,
    onSpeak?: (emote: string) => void,
): void {
    d.node = null;
    d.lineDone = onContinue;
    d.onSpeak = onSpeak ?? null;
    d.open = true;
    d.phase = 'line';
    d.speaker.textContent = speaker ? `${speaker} ` : '';
    d.hint.textContent = IS_TOUCH ? 'tap to continue' : '‹click› continue';
    d.wheel.classList.add('dlg-hidden');
    d.root.classList.add('dlg-open');
    typeText(d, speaker, text, emote);
    wireInputs(d);
}

// Dismiss a 'line' and fire its continue callback.
function advanceLine(d: Dialogue): void {
    if (!d.open) return;
    d.open = false;
    clearInterval(d.typeTimer);
    d.typing = false;
    d.root.classList.remove('dlg-open');
    d.cleanup?.();
    d.cleanup = null;
    const cb = d.lineDone;
    d.lineDone = null;
    cb?.();
}

// A press/tap that advances whatever phase we're in (shared by mouse click + touch end + keys).
function primaryAction(d: Dialogue): void {
    if (d.typing) {
        completeType(d); // first press fast-forwards the reveal, second one advances
        return;
    }
    if (d.phase === 'line') advanceLine(d);
    else if (d.phase === 'prompt') reveal(d);
    else if (d.phase === 'choosing') confirm(d);
    else finish(d);
}

// Attach this session's input listeners; `cleanup` removes exactly what we add.
function wireInputs(d: Dialogue): void {
    const onKey = (e: KeyboardEvent) => {
        if (d.phase === 'choosing') {
            const n = Number(e.key);
            if (d.node && n >= 1 && n <= d.node.choices.length) {
                e.preventDefault();
                choose(d, n - 1);
            }
        } else if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE') {
            e.preventDefault();
            primaryAction(d);
        }
    };
    const onResize = () => {
        layout(d);
        render(d);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);

    if (IS_TOUCH) {
        const onTouch = (e: TouchEvent) => {
            e.preventDefault();
            const t = e.touches[0] ?? e.changedTouches[0];
            if (t && d.phase === 'choosing') {
                aimFromPoint(d, t.clientX, t.clientY);
                render(d);
            }
        };
        const onEnd = (e: TouchEvent) => {
            e.preventDefault();
            primaryAction(d);
        };
        d.root.addEventListener('touchstart', onTouch, { passive: false });
        d.root.addEventListener('touchmove', onTouch, { passive: false });
        d.root.addEventListener('touchend', onEnd, { passive: false });
        d.cleanup = () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onResize);
            d.root.removeEventListener('touchstart', onTouch);
            d.root.removeEventListener('touchmove', onTouch);
            d.root.removeEventListener('touchend', onEnd);
        };
    } else {
        const onMove = (e: MouseEvent) => {
            if (d.phase !== 'choosing') return;
            d.aim.x += e.movementX * SENS;
            d.aim.y += e.movementY * SENS;
            const m = Math.hypot(d.aim.x, d.aim.y);
            if (m > d.maxR) {
                d.aim.x = (d.aim.x / m) * d.maxR;
                d.aim.y = (d.aim.y / m) * d.maxR;
            }
            render(d);
        };
        const onClick = () => primaryAction(d);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('click', onClick);
        d.cleanup = () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('click', onClick);
        };
    }
}

export function isDialogueOpen(d: Dialogue): boolean {
    return d.open;
}
