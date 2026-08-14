// The start prompt: a tiny "click to play" above the crosshair. A transparent full-screen catcher
// takes the click (a real user gesture, so pointer-lock + audio are allowed), captures the pointer,
// kicks off the intro, then removes itself.

const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const CSS = `
#startprompt { position:fixed; inset:0; z-index:20; cursor:pointer; background:transparent; transition:opacity 0.4s ease; }
#startprompt.hidden { opacity:0; pointer-events:none; }
#startprompt .cta {
  position:fixed; left:50%; top:50%; transform:translate(-50%,-50%) translateY(-24px);
  font:13px/1 monospace; letter-spacing:2px; text-transform:lowercase; white-space:nowrap;
  color:rgba(255,255,255,0.8); text-shadow:0 1px 3px rgba(0,0,0,0.9);
  animation:tpulse 1.8s ease-in-out infinite;
}
@keyframes tpulse { 0%,100%{opacity:0.4} 50%{opacity:0.95} }
`;

export function showTitle(onStart: () => void): void {
    if (!document.getElementById('startprompt-style')) {
        const style = document.createElement('style');
        style.id = 'startprompt-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const el = document.createElement('div');
    el.id = 'startprompt';
    el.innerHTML = `<div class="cta">${IS_TOUCH ? 'tap to play' : 'click to play'}</div>`;
    document.body.appendChild(el);

    let started = false;
    el.addEventListener('click', () => {
        if (started) return;
        started = true;
        el.classList.add('hidden');
        setTimeout(() => el.remove(), 500);
        onStart();
    });
}
