import type { Vec3 } from 'mathcat';
import * as THREE from 'three';

// A quest marker: a black tag with the label and an arrow inside that rotates to point at the
// objective - down when the target is on-screen above, outward toward it when off-screen at the
// edge. One shape, projected each frame (like the nameplate).

const EDGE_MARGIN = 12; // px breathing room kept between the tag's edge and the screen edge
const HEAD_LIFT = 0.1; // small clearance above the target (the head crown) before the screen offset
const TAG_ABOVE = 22; // px the tag floats above the on-screen anchor

const CSS = `
.obj-root { position:fixed; left:0; top:0; z-index:1000; pointer-events:none; will-change:transform; }
.obj-tag {
  position:absolute; transform:translate(-50%,-50%); display:flex; align-items:center; gap:10px; padding:8px 15px;
  background:rgba(10,12,15,0.85); border:1px solid rgba(255,255,255,0.22); border-radius:3px;
  color:rgba(255,255,255,0.92); font:14px/1 monospace; letter-spacing:1px; text-transform:lowercase; white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,0.9);
}
/* Square (14x14) triangle so rotating it 90deg to point down doesn't overflow its box. */
.obj-ar {
  flex:0 0 auto; width:0; height:0; transform-origin:center;
  border-top:7px solid transparent; border-bottom:7px solid transparent; border-left:14px solid #ffb454;
}
.obj-dist { color:#ffb454; opacity:0.85; }
`;

// A CSS-border triangle's ink sits at its centroid - 1/3 of the way from base to tip, ~1/6 of its
// size off the bounding-box centre flexbox aligns on. Translate the arrow that much toward its tip
// to visually centre its ink with the text, in whatever direction it points.
const ARROW_INK_SHIFT = 14 / 6; // px (the triangle is 14px along its pointing axis)

export type ObjectiveMarker = {
    root: HTMLDivElement;
    tag: HTMLDivElement;
    ar: HTMLDivElement;
    label: HTMLSpanElement;
    dist: HTMLSpanElement;
    shown: boolean;
};

export function createObjectiveMarker(): ObjectiveMarker {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'obj-root hud'; // `hud` = the debug "hud" toggle hides it with the rest of the HUD
    root.style.display = 'none';
    root.innerHTML = `<div class="obj-tag"><span class="obj-ar"></span><span class="obj-label"></span><span class="obj-dist"></span></div>`;
    document.body.appendChild(root);

    return {
        root,
        tag: root.querySelector('.obj-tag') as HTMLDivElement,
        ar: root.querySelector('.obj-ar') as HTMLDivElement,
        label: root.querySelector('.obj-label') as HTMLSpanElement,
        dist: root.querySelector('.obj-dist') as HTMLSpanElement,
        shown: false,
    };
}

const _p = new THREE.Vector3();
const _view = new THREE.Vector3();

// Per-frame: point the marker at `target` (world point) with `label`, or hide it when null.
export function updateObjectiveMarker(
    m: ObjectiveMarker,
    target: Vec3 | null,
    label: string,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
): void {
    if (!target) {
        if (m.shown) {
            m.root.style.display = 'none';
            m.shown = false;
        }
        return;
    }
    if (!m.shown) {
        m.root.style.display = 'block';
        m.shown = true;
    }
    if (m.label.textContent !== label) m.label.textContent = label;

    // Distance from the camera (~ the player's eye) to the target, shown as "Xm".
    const cdx = target[0] - camera.position.x;
    const cdy = target[1] - camera.position.y;
    const cdz = target[2] - camera.position.z;
    const distText = `${Math.round(Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz))}m`;
    if (m.dist.textContent !== distText) m.dist.textContent = distText;

    // Make sure the camera's inverse is current (we run before renderer.render()).
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    _p.set(target[0], target[1] + HEAD_LIFT, target[2]);
    _view.copy(_p).applyMatrix4(camera.matrixWorldInverse); // view space (-z is forward)
    const inFront = _view.z < 0;
    _p.project(camera); // -> NDC (mutates _p)

    const rect = renderer.domElement.getBoundingClientRect();
    const onScreen = inFront && Math.abs(_p.x) <= 1 && Math.abs(_p.y) <= 1;

    // The tag is centred on the root point (CSS translate(-50%,-50%)), so keep that centre at least
    // half the tag's size (+ margin) from every edge, else a wide label overhangs and gets clipped.
    // The tag sits at (0,0) in the root; TAG_ABOVE is folded in.
    const halfW = m.tag.offsetWidth / 2 + EDGE_MARGIN;
    const halfH = m.tag.offsetHeight / 2 + EDGE_MARGIN;
    m.tag.style.left = '0px';
    m.tag.style.top = '0px';

    if (onScreen) {
        const sx = rect.left + (_p.x * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-_p.y * 0.5 + 0.5) * rect.height - TAG_ABOVE; // float above the target
        const cx = Math.min(rect.right - halfW, Math.max(rect.left + halfW, sx));
        const cy = Math.min(rect.bottom - halfH, Math.max(rect.top + halfH, sy));
        m.root.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
        // points down at the target below it; shift down (toward the tip) to centre its ink with the text
        m.ar.style.transform = `translate(0px, ${ARROW_INK_SHIFT}px) rotate(90deg)`;
        return;
    }

    // Off-screen / behind -> clamp the tag's centre to an inset box sized by the tag itself, so the
    // whole tag stays on-screen; the inner arrow points the way.
    let nx = _p.x;
    let ny = _p.y;
    if (!inFront) {
        nx = -nx;
        ny = -ny;
    }
    let dx = nx;
    let dy = -ny; // NDC y is up; screen y is down
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hw = Math.max(0, rect.width / 2 - halfW);
    const hh = Math.max(0, rect.height / 2 - halfH);
    const t = Math.min(hw / Math.max(Math.abs(dx), 1e-6), hh / Math.max(Math.abs(dy), 1e-6));
    m.root.style.transform = `translate(${Math.round(cx + dx * t)}px, ${Math.round(cy + dy * t)}px)`;
    // (dx, dy) is the unit pointing direction; shift the arrow that way to centre its ink.
    m.ar.style.transform = `translate(${dx * ARROW_INK_SHIFT}px, ${dy * ARROW_INK_SHIFT}px) rotate(${Math.atan2(dy, dx)}rad)`;
}
