// Minimal quest HUD: a persistent objective line (bottom-left) and a transient toast
// (top-centre) for one-off beats like "case closed". Plain DOM overlay, same mono/amber
// aesthetic as the dialogue wheel.

const CSS = `
#qh-obj {
  position:fixed; left:50%; top:12px; transform:translateX(-50%); z-index:1000;
  max-width:min(680px,92vw); text-align:center; padding:7px 14px; border-radius:3px;
  background:rgba(10,12,15,0.82); border:1px solid rgba(255,255,255,0.2);
  font:14px/1.4 monospace; color:rgba(255,255,255,0.9); text-shadow:0 1px 2px rgba(0,0,0,0.9);
}
#qh-obj::before { content:'▸ '; color:#ffb454; }
#qh-obj:empty { display:none; }
#qh-toast {
  position:fixed; left:50%; top:22%; transform:translateX(-50%) translateY(-6px); z-index:1002;
  font:15px/1 monospace; color:#fff; padding:9px 16px; border-radius:3px;
  background:rgba(10,12,15,0.82); border:1px solid rgba(255,255,255,0.2); text-shadow:0 1px 2px rgba(0,0,0,0.9);
  opacity:0; transition:opacity 200ms ease-out, transform 200ms ease-out; pointer-events:none;
}
#qh-toast.on { opacity:1; transform:translateX(-50%) translateY(0); }
`;

export type QuestHud = {
    objective: HTMLDivElement;
    toast: HTMLDivElement;
    toastTimer: number;
};

export function createQuestHud(): QuestHud {
    if (!document.getElementById('qh-style')) {
        const style = document.createElement('style');
        style.id = 'qh-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const objective = document.createElement('div');
    objective.id = 'qh-obj';
    objective.className = 'hud'; // debug "hud" toggle hides it with the rest of the HUD
    const toast = document.createElement('div');
    toast.id = 'qh-toast';
    toast.className = 'hud';
    document.body.append(objective, toast);

    return { objective, toast, toastTimer: 0 };
}

// Set (or clear, with '') the persistent objective line.
export function setObjective(hud: QuestHud, text: string): void {
    hud.objective.textContent = text;
}

// Flash a transient message for a couple of seconds.
export function showToast(hud: QuestHud, text: string): void {
    hud.toast.textContent = text;
    hud.toast.classList.add('on');
    clearTimeout(hud.toastTimer);
    hud.toastTimer = window.setTimeout(() => hud.toast.classList.remove('on'), 2400);
}
