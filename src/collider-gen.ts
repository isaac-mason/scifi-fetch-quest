/**
 * Collider generator — a live, visual tuning harness for the SPZ → collision-mesh
 * pipeline (src/collider/voxel-marching.ts). Dev-only: `pnpm dev`, open /collider.html.
 *
 * It renders the actual splat cloud (via Spark) as reference, overlays the generated
 * collider mesh and (optionally) the solid voxels, and exposes every pipeline
 * parameter in a lil-gui panel. Because this is inherently a visual algorithm, the
 * point is the tight loop: nudge a slider → regenerate from the cached points (no
 * refetch) → see the result. Once the collider looks right, bake the final .bin with
 * the SAME numbers via `pnpm build:collider --cellSize … --iso …`.
 */
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import GUI from 'lil-gui';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { type ColliderParams, DEFAULT_PARAMS, type VoxelGrid } from './collider/voxel-marching';

const SPZ_URL = '/assets/scifi_world.spz';
const MAX_VOXEL_BOXES = 300_000; // safety cap for the voxel-box overlay

// Generation runs in a worker (src/collider-worker.ts) so the camera stays smooth while a
// regenerate is in flight. We only render the newest result (stale reqIds are dropped).
const worker = new Worker(new URL('./collider-worker.ts', import.meta.url), { type: 'module' });
let reqId = 0;

const statusEl = document.getElementById('status') as HTMLDivElement;
const setStatus = (msg: string) => {
    statusEl.textContent = msg;
};

// --- Renderer / scene / camera ---
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f16);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(1, 2, 1);
scene.add(dir);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const spark = new SparkRenderer({ renderer });
scene.add(spark);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Visual objects rebuilt each regenerate ---
let colliderMesh: THREE.Mesh | null = null;
let colliderWire: THREE.Mesh | null = null;
let voxelBoxes: THREE.InstancedMesh | null = null;
let boundsBox: THREE.Box3Helper | null = null;
// Splat bbox (from the worker's 'ready' message) — used for the bounds-slider ranges.
let cloudMin: [number, number, number] = [-100, -100, -100];
let cloudMax: [number, number, number] = [100, 100, 100];

const colliderMat = new THREE.MeshStandardMaterial({
    color: 0x35d0a0,
    side: THREE.DoubleSide,
    flatShading: true,
    transparent: true,
    opacity: 0.85,
    roughness: 0.8,
    metalness: 0,
});
// Wireframe drawn via material.wireframe (triangle edges straight from the index buffer) —
// no WireframeGeometry, so no edge-dedup Set and no mesh-size limit.
const wireMat = new THREE.MeshBasicMaterial({ color: 0x35d0a0, wireframe: true, side: THREE.DoubleSide });
const voxelMat = new THREE.MeshBasicMaterial({ color: 0x2a6cff, wireframe: true });

function disposeObject(obj: THREE.Mesh | THREE.InstancedMesh | null) {
    if (!obj) return;
    scene.remove(obj);
    obj.geometry.dispose();
}

// --- Tunable state (params + view toggles) ---
const params: ColliderParams = { ...DEFAULT_PARAMS };
const view = {
    showSplats: true,
    showCollider: false, // solid mesh off by default — the wireframe is the useful view
    showWireframe: true,
    wireColor: `#${wireMat.color.getHexString()}`,
    showVoxels: false,
    showBounds: true, // the crop-box wireframe (visible even when cropping is off, to define it)
    regenerate: () => regenerate(),
};

// Redraw the crop-box wireframe from params.boundsMin/Max (an orange guide; it only crops
// the collider when params.boundsEnabled is on).
function updateBoundsBox() {
    if (boundsBox) {
        scene.remove(boundsBox);
        boundsBox.geometry.dispose();
        boundsBox = null;
    }
    const box = new THREE.Box3(new THREE.Vector3(...params.boundsMin), new THREE.Vector3(...params.boundsMax));
    boundsBox = new THREE.Box3Helper(box, new THREE.Color(params.boundsEnabled ? 0xffaa00 : 0x775533));
    boundsBox.visible = view.showBounds;
    scene.add(boundsBox);
}

let splat: SplatMesh | null = null;

function buildColliderMeshes(positions: Float32Array, indices: Uint32Array) {
    disposeObject(colliderMesh);
    disposeObject(colliderWire);
    colliderMesh = null;
    colliderWire = null;
    if (positions.length === 0) return;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();

    colliderMesh = new THREE.Mesh(geom, colliderMat);
    colliderMesh.visible = view.showCollider;
    scene.add(colliderMesh);

    // Wireframe = the same geometry with a wireframe material. Reuses the index buffer (no
    // WireframeGeometry Set), so it handles arbitrarily large meshes.
    colliderWire = new THREE.Mesh(geom, wireMat);
    colliderWire.visible = view.showWireframe;
    scene.add(colliderWire);
}

function buildVoxelBoxes(solid: Uint8Array, grid: VoxelGrid) {
    disposeObject(voxelBoxes);
    voxelBoxes = null;
    if (!view.showVoxels) return;

    const { nx, ny, cellSize, cellHeight, min } = grid;
    const nxny = nx * ny;
    let count = 0;
    for (let k = 0; k < solid.length; k++) count += solid[k];
    if (count === 0) return;
    if (count > MAX_VOXEL_BOXES) {
        setStatus(
            `${statusEl.textContent}\nvoxel overlay skipped (${count.toLocaleString()} > ${MAX_VOXEL_BOXES.toLocaleString()} cap)`,
        );
        return;
    }

    const box = new THREE.BoxGeometry(cellSize, cellHeight, cellSize);
    voxelBoxes = new THREE.InstancedMesh(box, voxelMat, count);
    const m = new THREE.Matrix4();
    let inst = 0;
    // Decode each solid voxel index back to grid coords.
    for (let k = 0; k < solid.length; k++) {
        if (!solid[k]) continue;
        const x = k % nx;
        const y = Math.floor(k / nx) % ny;
        const z = Math.floor(k / nxny);
        m.setPosition(min[0] + x * cellSize, min[1] + y * cellHeight, min[2] + z * cellSize);
        voxelBoxes.setMatrixAt(inst++, m);
    }
    voxelBoxes.instanceMatrix.needsUpdate = true;
    scene.add(voxelBoxes);
}

let loaded = false;
let pending = 0; // in-flight generate requests (for the status line)

function regenerate() {
    if (!loaded) return;
    pending++;
    reqId++;
    setStatus('generating…');
    worker.postMessage({ type: 'generate', reqId, params });
}

// Newest-wins: render only the latest result; drop stale ones.
worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'ready') {
        loaded = true;
        cloudMin = msg.min;
        cloudMax = msg.max;
        frameCamera(msg.min, msg.max);
        updateBoundsBox();
        buildGui();
        regenerate();
        return;
    }
    if (msg.type === 'progress') {
        if (msg.reqId === reqId) setStatus(`${msg.message} — ${(msg.fraction * 100).toFixed(0)}%`);
        return;
    }
    if (msg.type === 'error') {
        if (msg.reqId === reqId) setStatus(`error: ${msg.message}`);
        return;
    }
    if (msg.type === 'result') {
        pending = Math.max(0, pending - 1);
        if (msg.reqId !== reqId) return; // a newer request is already out
        buildColliderMeshes(new Float32Array(msg.positions), new Uint32Array(msg.indices));
        buildVoxelBoxes(new Uint8Array(msg.solid), msg.grid);
        const s = msg.stats;
        setStatus(
            `splats ${s.numPoints.toLocaleString()} · grid ${s.dims.join('×')} · solid ${s.solidVoxels.toLocaleString()}\n` +
                `tris ${s.triangles.toLocaleString()} · verts ${s.vertices.toLocaleString()} · ${s.timeMs.toFixed(0)}ms`,
        );
    }
};

function frameCamera(min: [number, number, number], max: [number, number, number]) {
    const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const radius = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 0.6 + 1;
    controls.target.copy(center);
    camera.position.set(center.x + radius, center.y + radius * 0.6, center.z + radius);
    camera.near = radius / 500;
    camera.far = radius * 20;
    camera.updateProjectionMatrix();
    controls.update();
}

function buildGui() {
    const gui = new GUI({ title: 'collider generator' });
    const g = gui.addFolder('rasterise');
    g.add(params, 'cellSize', 0.05, 2, 0.01).name('cell size (XZ)').onFinishChange(regenerate);
    g.add(params, 'cellHeight', 0.05, 2, 0.01).name('cell height (Y)').onFinishChange(regenerate);
    g.add(params, 'mode', ['coverage', 'centers']).name('mode').onChange(regenerate);
    g.add(params, 'densityThreshold', 0.5, 30, 0.5).name('solid threshold').onFinishChange(regenerate);
    // Coverage-mode footprint controls (ignored in 'centers' mode).
    const c = gui.addFolder('coverage footprint');
    c.add(params, 'splatRadius', 0.5, 6, 0.1).name('splat radius ×σ').onFinishChange(regenerate);
    c.add(params, 'minRadius', 0, 1, 0.01).name('min radius (fill)').onFinishChange(regenerate);
    c.add(params, 'maxRadius', 0.1, 5, 0.05).name('max radius (reject)').onFinishChange(regenerate);
    c.add(params, 'minOpacity', 0, 1, 0.02).name('min opacity').onFinishChange(regenerate);
    const m = gui.addFolder('shape');
    m.add(params, 'dilate', 0, 5, 1).name('dilate (seal)').onFinishChange(regenerate);
    m.add(params, 'erode', 0, 5, 1).name('erode').onFinishChange(regenerate);
    m.add(params, 'blur', 0, 6, 1).name('blur (smooth)').onFinishChange(regenerate);
    m.add(params, 'isoLevel', 0.05, 0.95, 0.01).name('iso level').onFinishChange(regenerate);
    // Fill hollow floor/ceiling slabs (per XZ-column scan): close thin captured shells,
    // leave rooms open.
    const r = gui.addFolder('fill hollow slabs');
    r.add(params, 'fillGaps').name('fill slabs').onChange(regenerate);
    r.add(params, 'maxGapFill', 0.05, 2, 0.05).name('max gap (m)').onFinishChange(regenerate);
    // Crop box — restrict the collider to a region. The wireframe box shows it (orange when
    // cropping, dim when it's just a guide); 'enable crop' toggles whether it actually clips.
    const bnd = gui.addFolder('bounds (crop)');
    bnd.add(params, 'boundsEnabled')
        .name('enable crop')
        .onChange(() => {
            updateBoundsBox();
            regenerate();
        });
    const onBox = () => updateBoundsBox();
    const onBoxDone = () => {
        if (params.boundsEnabled) regenerate();
    };
    const addAxis = (arr: [number, number, number], i: number, label: string) => {
        bnd.add(arr as unknown as Record<string, number>, String(i), cloudMin[i] - 5, cloudMax[i] + 5, 0.5)
            .name(label)
            .onChange(onBox)
            .onFinishChange(onBoxDone);
    };
    for (const [i, ax] of [
        [0, 'x'],
        [1, 'y'],
        [2, 'z'],
    ] as const) {
        addAxis(params.boundsMin, i, `min ${ax}`);
    }
    for (const [i, ax] of [
        [0, 'x'],
        [1, 'y'],
        [2, 'z'],
    ] as const) {
        addAxis(params.boundsMax, i, `max ${ax}`);
    }
    const v = gui.addFolder('view');
    v.add(view, 'showSplats')
        .name('splats')
        .onChange((on: boolean) => {
            if (splat) splat.visible = on;
        });
    v.add(view, 'showCollider')
        .name('collider mesh')
        .onChange((on: boolean) => {
            if (colliderMesh) colliderMesh.visible = on;
        });
    v.add(view, 'showWireframe')
        .name('wireframe')
        .onChange((on: boolean) => {
            if (colliderWire) colliderWire.visible = on;
        });
    v.addColor(view, 'wireColor')
        .name('wireframe colour')
        .onChange((hex: string) => {
            wireMat.color.set(hex);
        });
    v.add(view, 'showVoxels').name('voxels').onChange(regenerate);
    v.add(view, 'showBounds')
        .name('crop box')
        .onChange((on: boolean) => {
            if (boundsBox) boundsBox.visible = on;
        });
    gui.add(view, 'regenerate').name('▶ regenerate');
}

async function main() {
    setStatus('fetching splats…');
    const bytes = new Uint8Array(await (await fetch(SPZ_URL)).arrayBuffer());

    // Render the actual splats as reference (Spark on the main thread; the worker parses its
    // own copy for the algorithm — cloned, not transferred, so Spark keeps these bytes).
    splat = new SplatMesh({ fileBytes: bytes, fileName: 'scifi_world.spz' });
    scene.add(splat);
    splat.initialized.then(() => {
        if (splat) splat.visible = view.showSplats;
    });

    // Hand the bytes to the worker; it parses, replies 'ready' (→ frame camera, build GUI,
    // first regenerate), then handles every 'generate' off the main thread.
    setStatus('parsing splats…');
    worker.postMessage({ type: 'load', bytes: bytes.buffer.slice(0) });
}

function loop() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
}

main().catch((err) => {
    console.error(err);
    setStatus(`error: ${err.message}`);
});
loop();
