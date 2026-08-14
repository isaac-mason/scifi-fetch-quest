// A tiny lowercase-monospace readout just right of the crosshair, shown when you look at
// something interactable: its name, and a "‹click› <verb>" hint that appears once you're in
// range (verb = "talk" for a companion/cat, "take" for a pickup). Sits in a small dark card
// matching the rest of the HUD. Fixed to screen centre (the view ray only hits what you're aimed at).

// What the nameplate is pointing at: a display name + the interact-prompt verb.
export type NameTarget = { name: string; verb: string };

// One-time stylesheet: text stacked to the right of the reticle, vertically centred on it.
const CSS = `
.np-root { position:fixed; left:50%; top:50%; z-index:1001; pointer-events:none; }
.np-box {
  position:absolute; left:16px; top:0; transform:translateY(-50%) translateX(-3px);
  display:flex; flex-direction:column; gap:3px;
  padding:6px 9px; background:rgba(10,12,15,0.82); border:1px solid rgba(255,255,255,0.18); border-radius:4px;
  opacity:0; transition:opacity 120ms ease-out, transform 120ms ease-out;
}
.np-root.np-show .np-box { opacity:1; transform:translateY(-50%) translateX(0); }
.np-name {
  font:15px/1 monospace; text-transform:lowercase; white-space:nowrap;
  color:#fff; text-shadow:0 1px 3px rgba(0,0,0,0.9);
}
.np-prompt {
  display:none; font:13px/1 monospace; text-transform:lowercase;
  color:rgba(255,255,255,0.55); text-shadow:0 1px 3px rgba(0,0,0,0.9);
}
.np-prompt b { color:rgba(255,255,255,0.8); font-weight:400; }
.np-root.np-interact .np-prompt { display:block; }
`;

export type Nameplate = {
    root: HTMLDivElement;
    name: HTMLDivElement;
    verb: HTMLSpanElement;
    shown: boolean;
};

export function createNameplate(): Nameplate {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'np-root hud'; // `hud` = the debug "hud" toggle hides it with the rest of the HUD
    root.innerHTML = `
      <div class="np-box">
        <div class="np-name"></div>
        <div class="np-prompt"><b>‹click›</b> <span class="np-verb">talk</span></div>
      </div>`;
    document.body.appendChild(root);

    return {
        root,
        name: root.querySelector('.np-name') as HTMLDivElement,
        verb: root.querySelector('.np-verb') as HTMLSpanElement,
        shown: false,
    };
}

// Per-frame: show `target`'s name right of the crosshair (or hide when null). `canInteract`
// reveals the "‹click› <verb>" hint — only once the player is within interact range.
export function updateNameplate(np: Nameplate, target: NameTarget | null, canInteract: boolean): void {
    if (!target) {
        if (np.shown) {
            // Only drop np-show so the WHOLE card (name + prompt) fades out together via opacity.
            // Removing np-interact here would display:none the prompt instantly — fading unevenly.
            // np-interact is re-set from canInteract on the next show, so leaving it is harmless.
            np.root.classList.remove('np-show');
            np.shown = false;
        }
        return;
    }

    if (np.name.textContent !== target.name) np.name.textContent = target.name;
    if (np.verb.textContent !== target.verb) np.verb.textContent = target.verb;
    np.root.classList.toggle('np-interact', canInteract);
    if (!np.shown) {
        np.root.classList.add('np-show');
        np.shown = true;
    }
}
