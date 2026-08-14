// Minimal quest HUD: a persistent objective line (top-centre), same mono/amber look as the dialogue wheel.

const CSS = `
#qh-obj {
  position:fixed; left:50%; top:12px; transform:translateX(-50%); z-index:1000;
  max-width:min(680px,92vw); text-align:center; padding:7px 14px; border-radius:3px;
  background:rgba(10,12,15,0.82); border:1px solid rgba(255,255,255,0.2);
  font:14px/1.4 monospace; color:rgba(255,255,255,0.9); text-shadow:0 1px 2px rgba(0,0,0,0.9);
}
#qh-obj::before { content:'▸ '; color:#ffb454; }
#qh-obj:empty { display:none; }
`;

export type QuestHud = {
    objective: HTMLDivElement;
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
    document.body.append(objective);

    return { objective };
}

// Set (or clear, with '') the persistent objective line.
export function setObjective(hud: QuestHud, text: string): void {
    hud.objective.textContent = text;
}
