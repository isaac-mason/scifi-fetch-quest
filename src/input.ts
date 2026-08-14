// Raw per-frame input state: movement keys held plus a one-shot interact. controls.ts fills it
// from keyboard/mouse; the character controller and interaction system read it. A plain,
// device-agnostic command struct.
export type Input = {
    /** Local analog move axis: x = strafe (-left/+right), y = forward (-back/+fwd). Magnitude
     *  0..1 scales speed. Keyboard fills it with +/-1 per axis; a stick/touch nipple fills analog. */
    move: [number, number];
    jump: boolean;
    sprint: boolean;
    /** One-shot: set on click while pointer-locked, consumed by the interaction system. */
    interact: boolean;
};

// A fresh input with everything released.
export function createInput(): Input {
    return { move: [0, 0], jump: false, sprint: false, interact: false };
}
