// Animal-Crossing-style "animalese": a short pitched blip per character as dialogue types out.
// Pure Web Audio, no assets. Each speaker gets a base pitch; each letter steps up a scale with
// jitter for that bouncy chatter.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
    if (!ctx) ctx = new AudioContext();
    // Browsers start the context suspended until a user gesture; resume() is a no-op before one.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
}

// Per-speaker base frequency (Hz) from the name, so each voice is distinct. Cats get a boost so
// they read higher/chirpier than the crew.
const CAT_PITCH_MUL = 1.4;
export function speakerPitch(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    const base = 190 + (h % 210); // ~190-400 Hz
    return name === 'cat' ? base * CAT_PITCH_MUL : base;
}

// Frequency for one character given the speaker's base - steps up a 12-tone scale, jittered.
export function charPitch(ch: string, base: number): number {
    const step = ch.toLowerCase().charCodeAt(0) % 12;
    return base * 2 ** (step / 12) * (0.94 + Math.random() * 0.12);
}

// Overall loudness of the chatter.
const VOLUME = 0.035;

// Play one short blip at `freq` Hz: a soft triangle with a gentle attack, lowpassed so it's not
// shrill.
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
    // Softer, rounder envelope (slower attack, longer tail).
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(VOLUME, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(lp).connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.13);
}
