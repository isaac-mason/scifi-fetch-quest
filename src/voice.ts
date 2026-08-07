// Animal-Crossing-style "animalese": a short pitched blip per character as dialogue types out.
// Pure Web Audio — no sound assets. Each speaker gets a base pitch (so voices are distinct) and
// each letter nudges it up a scale with a little jitter, giving that bouncy chatter.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
    if (!ctx) ctx = new AudioContext();
    // Browsers start the context suspended until a user gesture; resume() is a no-op before one.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
}

// A per-speaker base frequency (Hz) from the name, so each voice reads as a different character.
// Cats get a boost so their animalese chatter is a touch higher/chirpier than the crew's.
const CAT_PITCH_MUL = 1.4;
export function speakerPitch(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    const base = 190 + (h % 210); // ~190–400 Hz
    return name === 'cat' ? base * CAT_PITCH_MUL : base;
}

// Frequency for one character given the speaker's base — letters step up a 12-tone scale, jittered.
export function charPitch(ch: string, base: number): number {
    const step = ch.toLowerCase().charCodeAt(0) % 12;
    return base * 2 ** (step / 12) * (0.94 + Math.random() * 0.12);
}

// Overall loudness of the chatter — turn this down/up to taste.
const VOLUME = 0.035;

// Play one short blip at `freq` Hz — a soft triangle with a gentle attack so it burbles rather
// than punches. A quick lowpass rounds off the high harmonics so it's not shrill.
export function blip(freq: number): void {
    const c = audio();
    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    const lp = c.createBiquadFilter();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    // Softer, rounder envelope (slower attack, longer tail) — less "punch".
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(VOLUME, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(lp).connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.13);
}
