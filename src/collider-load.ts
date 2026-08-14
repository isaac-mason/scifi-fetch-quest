import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Collider } from './collider-schema';

/**
 * Load the collision mesh from a glTF/GLB and flatten every mesh into a single world-space
 * triangle soup (positions + indices) - the Collider consumed by physics, the shadow catcher,
 * the debug wireframe, and the probe bake. World matrices are baked in so authored transforms
 * are honoured; non-indexed prims get sequential indices.
 */
export async function loadCollider(url: string): Promise<Collider> {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);

    const positions: number[] = [];
    const indices: number[] = [];
    gltf.scene.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        const geom = mesh.geometry;
        const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos) return;

        const base = positions.length / 3;
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            positions.push(v.x, v.y, v.z);
        }

        const idx = geom.getIndex();
        if (idx) {
            for (let i = 0; i < idx.count; i++) indices.push(base + idx.getX(i));
        } else {
            for (let i = 0; i < pos.count; i++) indices.push(base + i);
        }
    });

    if (indices.length === 0) throw new Error(`Collider glTF had no triangle meshes: ${url}`);

    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
