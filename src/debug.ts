import type { SparkRenderer } from '@sparkjsdev/spark';
import { debug as ccDebug, kcc, MotionType, rigidBody, type World } from 'crashcat';
import * as THREE from 'three';

import type { Character } from './character-controller';
import { setProbeVolumeEnabled } from './light-probes';
import type { Performance } from './performance';

const GROUND_STATE_NAMES: Record<number, string> = {
    [kcc.GroundState.ON_GROUND]: 'on ground',
    [kcc.GroundState.ON_STEEP_GROUND]: 'on steep',
    [kcc.GroundState.NOT_SUPPORTED]: 'not supported',
    [kcc.GroundState.IN_AIR]: 'in air',
};

export type DebugOverlay = {
    element: HTMLDivElement;
    text: HTMLDivElement;
    /** Live readout value spans; cam/feet are click-to-copy as `[x, y, z]`. */
    readout: {
        mode: HTMLSpanElement;
        cam: HTMLSpanElement;
        feet: HTMLSpanElement;
        ground: HTMLSpanElement;
        splats: HTMLSpanElement;
        probes: HTMLSpanElement;
    };
    /** Whether the text panel is shown (toggled with the backtick key). */
    enabled: boolean;
    /** Whether the navmesh wireframe is drawn (toggled by the checkbox). */
    showNavMesh: boolean;
    /** Camera mode: true = free orbit camera, false = first-person character. */
    orbitMode: boolean;
    /** Static collider wireframe (floor + level mesh); built once, toggled by "collider debug". */
    colliderLines: THREE.LineSegments;
    /** Whether the light-probe volume gizmos are drawn (toggled by the checkbox). */
    showProbes: boolean;
    /** One SH-shaded sphere per probe cell; attached via attachProbeGizmos once the volume loads. */
    probeGroup: THREE.Group | null;
    /** Whether the crowd-agent cylinders are drawn (toggled by the checkbox). */
    showCrowd: boolean;
    /** Wireframe cylinder per crowd agent (radius x height). Rebuilt each frame. */
    crowdCylinders: THREE.LineSegments;
    /** Whether companions/cats sample the baked light-probe volume (SH GI). Default on. */
    probeLighting: boolean;
    /** Whether sun shadows are rendered. Default on; applied each frame via setShadowsEnabled. */
    shadows: boolean;
    /** Whether the character + cat models are drawn. Default on; state keeps running when hidden. */
    showCharacters: boolean;
    /** Whether the screen-space HUD is shown. Default on; CSS `hud-off` body class hides `.hud`. */
    showHud: boolean;
};

function createCheckbox(label: string, onChange: (checked: boolean) => void, checked = false): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
    return wrapper;
}

// An always-on labelled range slider that reports its value live, with a readout.
function createRange(
    label: string,
    opts: { min: number; max: number; step: number; value: number },
    onChange: (value: number) => void,
): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(opts.min);
    range.max = String(opts.max);
    range.step = String(opts.step);
    range.value = String(opts.value);
    range.style.width = '80px';
    const readout = document.createElement('span');
    readout.textContent = opts.value.toFixed(2);
    range.addEventListener('input', () => {
        const v = Number(range.value);
        readout.textContent = v.toFixed(2);
        onChange(v);
    });
    wrapper.append(label, range, readout);
    return wrapper;
}

// Copy text to the clipboard, with an execCommand fallback for non-secure contexts.
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch {
            ok = false;
        }
        document.body.removeChild(ta);
        return ok;
    }
}

// Build the monospace readout panel: fixed labels with per-value spans updated each frame.
// cam/feet are click-to-copy as `[x, y, z]`; spans persist so the flash survives per-frame writes.
function buildReadout(): { text: HTMLDivElement; readout: DebugOverlay['readout'] } {
    if (!document.getElementById('dbg-readout-style')) {
        const style = document.createElement('style');
        style.id = 'dbg-readout-style';
        style.textContent = '.dbg-copy{cursor:pointer}.dbg-copy:hover{text-decoration:underline}.dbg-copy.copied{color:#8ff0ff}';
        document.head.appendChild(style);
    }

    const text = document.createElement('div');
    text.style.cssText = 'white-space:pre;user-select:text;-webkit-user-select:text';
    text.innerHTML =
        'mode    <span data-k="mode"></span>\n' +
        'cam     <span class="dbg-copy" data-k="cam" title="click to copy [x, y, z]"></span>\n' +
        'feet    <span class="dbg-copy" data-k="feet" title="click to copy [x, y, z]"></span>  (<span data-k="ground"></span>)\n' +
        'splats  <span data-k="splats"></span>\n' +
        'probes  <span data-k="probes"></span>';

    const q = (k: string) => text.querySelector(`[data-k="${k}"]`) as HTMLSpanElement;
    const readout = {
        mode: q('mode'),
        cam: q('cam'),
        feet: q('feet'),
        ground: q('ground'),
        splats: q('splats'),
        probes: q('probes'),
    };

    for (const el of [readout.cam, readout.feet]) {
        el.addEventListener('click', async () => {
            if (await copyToClipboard(`[${el.textContent}]`)) {
                el.classList.add('copied');
                setTimeout(() => el.classList.remove('copied'), 700);
            }
        });
    }

    return { text, readout };
}

// Minimal debug overlay: a text panel (toggle with backtick) plus debug-wireframe checkboxes.
export function createDebugOverlay(perf: Performance): DebugOverlay {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'padding:6px 8px',
        'display:none',
        'flex-direction:column',
        'gap:4px',
        'font:12px/1.4 monospace',
        'color:#0f0',
        'background:rgba(0,0,0,0.6)',
        'z-index:1000',
    ].join(';');

    // Static collider wireframe - built once (see buildColliderDebug). Coloured per-vertex.
    const colliderLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    colliderLines.visible = false;
    colliderLines.frustumCulled = false;

    // Crowd-agent cylinders - rebuilt each frame from the live agents (see updateCrowdDebug).
    const crowdCylinders = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x33e0ff }));
    crowdCylinders.visible = false;
    crowdCylinders.frustumCulled = false;

    const { text, readout } = buildReadout();

    const overlay: DebugOverlay = {
        element,
        text,
        readout,
        enabled: false,
        showNavMesh: false,
        orbitMode: false,
        colliderLines,
        showProbes: false,
        probeGroup: null,
        showCrowd: false,
        crowdCylinders,
        probeLighting: true,
        shadows: true,
        showCharacters: true,
        showHud: true,
    };

    // One-time rule the "hud" toggle flips. `!important` beats each module's per-frame inline display.
    if (!document.getElementById('hud-toggle-style')) {
        const style = document.createElement('style');
        style.id = 'hud-toggle-style';
        style.textContent = 'body.hud-off .hud{display:none!important}';
        document.head.appendChild(style);
    }

    const orbitCheckbox = createCheckbox('orbit camera', (checked) => {
        overlay.orbitMode = checked;
    });

    const colliderCheckbox = createCheckbox('collider debug', (checked) => {
        colliderLines.visible = checked;
    });

    const navmeshCheckbox = createCheckbox('navmesh debug', (checked) => {
        overlay.showNavMesh = checked;
    });

    const probeCheckbox = createCheckbox('light probes', (checked) => {
        overlay.showProbes = checked;
        if (overlay.probeGroup) overlay.probeGroup.visible = checked;
    });

    const crowdCheckbox = createCheckbox('crowd debug', (checked) => {
        overlay.showCrowd = checked;
        crowdCylinders.visible = checked;
    });

    // --- Feature toggles (default ON - unchecking disables the effect) ---
    // Probe lighting: baked SH GI on the companions/cats, applied straight to the shared volume
    // uniform. Separate from the "light probes" box above (which draws the gizmo spheres).
    const probeLightingCheckbox = createCheckbox(
        'probe lighting',
        (checked) => {
            overlay.probeLighting = checked;
            setProbeVolumeEnabled(checked);
        },
        true,
    );

    // Shadows: sun shadow-mapping. index applies overlay.shadows each frame via setShadowsEnabled.
    const shadowsCheckbox = createCheckbox(
        'shadows',
        (checked) => {
            overlay.shadows = checked;
        },
        true,
    );

    // Characters: crew + cat models. Hides the meshes while keeping their state/animation running.
    const charactersCheckbox = createCheckbox(
        'characters',
        (checked) => {
            overlay.showCharacters = checked;
        },
        true,
    );

    // HUD: the screen-space overlays. Pure CSS - the `hud-off` body class hides every `.hud` element.
    const hudCheckbox = createCheckbox(
        'hud',
        (checked) => {
            overlay.showHud = checked;
            document.body.classList.toggle('hud-off', !checked);
        },
        true,
    );

    const lodSlider = createRange('lod scale', { min: 0.2, max: 2, step: 0.05, value: perf.lodScale }, (value) => {
        perf.lodScale = value;
    });

    element.append(
        orbitCheckbox,
        colliderCheckbox,
        navmeshCheckbox,
        probeCheckbox,
        crowdCheckbox,
        probeLightingCheckbox,
        shadowsCheckbox,
        charactersCheckbox,
        hudCheckbox,
        lodSlider,
        overlay.text,
    );
    document.body.appendChild(element);

    window.addEventListener('keydown', (event) => {
        if (event.key === '`') {
            overlay.enabled = !overlay.enabled;
            element.style.display = overlay.enabled ? 'flex' : 'none';
        }
    });

    return overlay;
}

// Live light-probe readout: cell count of the loaded probe volume (nx*ny*nz).
export type ProbeReadout = { cells: number };

export function updateDebugOverlay(
    overlay: DebugOverlay,
    camera: THREE.PerspectiveCamera,
    character: Character,
    spark: SparkRenderer,
    probe?: ProbeReadout,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const c = character.kcc.position;
    const r = overlay.readout;
    r.mode.textContent = overlay.orbitMode ? 'orbit' : 'first-person';
    r.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    r.feet.textContent = `${c[0].toFixed(2)}, ${c[1].toFixed(2)}, ${c[2].toFixed(2)}`;
    r.ground.textContent = GROUND_STATE_NAMES[character.kcc.ground.state] ?? '?';
    r.splats.textContent = `${spark.activeSplats.toLocaleString()} / ${spark.maxSplats.toLocaleString()}  (lod x${spark.lodSplatScale.toFixed(2)})`;
    r.probes.textContent = probe ? `${probe.cells} cells` : '—';
}

// Register the probe-gizmo group so the "light probes" checkbox controls its visibility.
export function attachProbeGizmos(overlay: DebugOverlay, group: THREE.Group): void {
    overlay.probeGroup = group;
    group.visible = overlay.showProbes;
}

// Add a "skip:" row of quest-stage buttons; clicking one jumps the quest there (dev only).
export function addStageSkips(overlay: DebugOverlay, stages: string[], onSkip: (stage: string) => void): void {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:wrap';
    const label = document.createElement('span');
    label.textContent = 'skip:';
    row.appendChild(label);
    for (const stage of stages) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = stage;
        btn.style.cssText =
            'font:11px monospace;padding:2px 6px;cursor:pointer;background:#031;color:#0f0;border:1px solid #0a0;border-radius:2px';
        btn.addEventListener('click', () => onSkip(stage));
        row.appendChild(btn);
    }
    overlay.element.insertBefore(row, overlay.text);
}

// Build the static collider wireframe once (colliders never move); the checkbox just toggles it.
// Call once the physics world's static bodies exist (e.g. after createSplatCollider).
export function buildColliderDebug(overlay: DebugOverlay, world: World): void {
    let total = 0;
    const parts: ReturnType<typeof ccDebug.body>[] = [];
    for (const body of rigidBody.iterate(world)) {
        if (body.motionType !== MotionType.STATIC) continue;
        const segments = ccDebug.body(body);
        parts.push(segments);
        total += segments.vertices.length;
    }

    const positions = new Float32Array(total);
    const colors = new Float32Array(total);
    let offset = 0;
    for (const { vertices, colors: c } of parts) {
        positions.set(vertices, offset);
        colors.set(c, offset);
        offset += vertices.length;
    }

    const geometry = overlay.colliderLines.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Minimal structural view of a crowd agent - enough to draw its cylinder.
export type CrowdAgentView = { position: ArrayLike<number>; radius: number; height: number };

const CROWD_CIRCLE_SEGMENTS = 16; // resolution of each cylinder's rings
const CROWD_STRUTS = 4; // vertical lines joining the top/bottom rings
// verts per agent: two rings (segment lines) + the vertical struts, each a 2-vert line.
const CROWD_VERTS_PER_AGENT = CROWD_CIRCLE_SEGMENTS * 2 * 2 + CROWD_STRUTS * 2;

// Rebuild the crowd-agent cylinders each frame from the live agents (buffer reused unless the
// count changes). Each agent: a ring at the feet, a ring at `height`, and a few vertical struts.
export function updateCrowdDebug(overlay: DebugOverlay, agents: CrowdAgentView[]): void {
    if (!overlay.showCrowd) return;

    const total = agents.length * CROWD_VERTS_PER_AGENT * 3;
    const geometry = overlay.crowdCylinders.geometry;
    let position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position || position.array.length !== total) {
        position = new THREE.BufferAttribute(new Float32Array(total), 3);
        geometry.setAttribute('position', position);
    }
    const buffer = position.array as Float32Array;

    let o = 0;
    const vertex = (x: number, y: number, z: number): void => {
        buffer[o++] = x;
        buffer[o++] = y;
        buffer[o++] = z;
    };

    for (const agent of agents) {
        const cx = agent.position[0];
        const y0 = agent.position[1];
        const cz = agent.position[2];
        const y1 = y0 + agent.height;
        const r = agent.radius;

        for (let i = 0; i < CROWD_CIRCLE_SEGMENTS; i++) {
            const a0 = (i / CROWD_CIRCLE_SEGMENTS) * Math.PI * 2;
            const a1 = ((i + 1) / CROWD_CIRCLE_SEGMENTS) * Math.PI * 2;
            const x0 = cx + Math.cos(a0) * r;
            const z0 = cz + Math.sin(a0) * r;
            const x1 = cx + Math.cos(a1) * r;
            const z1 = cz + Math.sin(a1) * r;
            vertex(x0, y0, z0); // bottom ring segment
            vertex(x1, y0, z1);
            vertex(x0, y1, z0); // top ring segment
            vertex(x1, y1, z1);
        }
        for (let i = 0; i < CROWD_STRUTS; i++) {
            const a = (i / CROWD_STRUTS) * Math.PI * 2;
            const x = cx + Math.cos(a) * r;
            const z = cz + Math.sin(a) * r;
            vertex(x, y0, z); // vertical strut
            vertex(x, y1, z);
        }
    }

    position.needsUpdate = true;
}
