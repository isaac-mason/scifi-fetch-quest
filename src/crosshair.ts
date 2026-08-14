// Minimal HUD crosshair: a small white dot at screen centre. The interact affordance (name + TALK
// prompt) lives on the companion nameplate (see nameplate.ts).
export type Crosshair = {
    dot: HTMLDivElement;
};

export function createCrosshair(): Crosshair {
    // Small white circle, dead centre, with a soft dark outline so it reads on bright and dark splats.
    const dot = document.createElement('div');
    dot.className = 'hud'; // debug "hud" toggle hides everything with this class at once
    dot.style.cssText = [
        'position:fixed',
        'left:50%',
        'top:50%',
        'width:7px',
        'height:7px',
        'margin:-3.5px 0 0 -3.5px', // centre the 7px dot on the exact midpoint
        'border-radius:50%',
        'background:#fff',
        'box-shadow:0 0 2px rgba(0,0,0,0.9)',
        'pointer-events:none',
        'z-index:1000',
    ].join(';');

    document.body.append(dot);
    return { dot };
}

// Show/hide the crosshair dot (e.g. hide it in orbit-camera mode).
export function setCrosshairVisible(crosshair: Crosshair, visible: boolean): void {
    crosshair.dot.style.display = visible ? 'block' : 'none';
}
