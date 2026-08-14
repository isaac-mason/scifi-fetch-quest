// A row of keyboard/mouse control hints along the bottom-centre — desktop only. Same mono /
// translucent aesthetic as the rest of the HUD; shown during free play, hidden in dialogue/cutscenes.

const CSS = `
#ctrl-hint {
  position:fixed; right:16px; bottom:16px; z-index:1000;
  display:flex; flex-direction:column; gap:9px; align-items:flex-end; pointer-events:none;
  font:13px/1 monospace; color:rgba(255,255,255,0.85); text-transform:lowercase; letter-spacing:0.5px;
  text-shadow:0 1px 2px rgba(0,0,0,0.9);
}
/* label on the left, keycaps on the right; rows right-aligned so the caps line up on the edge */
#ctrl-hint .grp { display:flex; gap:7px; align-items:center; }
/* white keycaps: light face, dark legend, a hair of drop shadow for a physical feel */
#ctrl-hint .key {
  display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:19px; padding:0 6px;
  background:#f2f2f2; border:1px solid rgba(0,0,0,0.25); border-radius:3px; box-shadow:0 1px 0 rgba(0,0,0,0.4);
  color:#15181e; font-size:12px; font-weight:700; letter-spacing:0; text-shadow:none;
}
`;

const HINTS: [string[], string][] = [
    [['wasd'], 'move'],
    [['mouse'], 'look'],
    [['click'], 'talk'],
    [['space'], 'jump'],
    [['shift'], 'run'],
];

export type ControlsHint = { root: HTMLDivElement };

export function createControlsHint(): ControlsHint {
    if (!document.getElementById('ctrl-hint-style')) {
        const style = document.createElement('style');
        style.id = 'ctrl-hint-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }
    const root = document.createElement('div');
    root.id = 'ctrl-hint';
    root.className = 'hud'; // debug "hud" toggle hides it with the rest of the HUD
    root.style.display = 'none';
    root.innerHTML = HINTS.map(
        ([keys, label]) =>
            `<span class="grp"><span>${label}</span>${keys.map((k) => `<span class="key">${k}</span>`).join('')}</span>`,
    ).join('');
    document.body.appendChild(root);
    return { root };
}

export function setControlsHintVisible(hint: ControlsHint, visible: boolean): void {
    hint.root.style.display = visible ? 'flex' : 'none';
}
