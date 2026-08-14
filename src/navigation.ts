import {
    addTile,
    createFindNearestPolyResult,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findPath,
    type NavMesh,
    type NavMeshTile,
    type Vec3,
} from 'navcat';
import { crowd } from 'navcat/blocks';
import { createNavMeshHelper, type DebugObject } from 'navcat/three';
import * as THREE from 'three';

import { NAVMESH_URL } from './scene';

const CROWD_MAX_AGENT_RADIUS = 0.3; // >= the largest agent radius in the crowd (companions + player proxy)
const FIND_HALF_EXTENTS: Vec3 = [0.5, 1, 0.5];

// The player is a target-less proxy agent in the crowd, pinned to the player's feet each frame
// (see updatePlayerAgent), so companion avoidance/separation treats the player as a moving obstacle.
const PLAYER_AGENT_RADIUS = 0.4; // matches the player capsule radius (character.ts)
const PLAYER_AGENT_HEIGHT = 1; // matches the player height

type NavMeshData = {
    origin: Vec3;
    tileWidth: number;
    tileHeight: number;
    tiles: NavMeshTile[];
};

export type Navigation = {
    navMesh: NavMesh | null;
    navMeshHelper: DebugObject | null;
    crowd: crowd.Crowd | null;
    /** Crowd id of the player proxy agent, or null until it's added. */
    playerAgentId: string | null;
};

export function initNavigation(): Navigation {
    return {
        navMesh: null,
        navMeshHelper: null,
        crowd: null,
        playerAgentId: null,
    };
}

export async function loadNavigation(navigation: Navigation): Promise<void> {
    const res = await fetch(NAVMESH_URL);
    if (!res.ok) throw new Error(`Failed to load navmesh (${res.status})`);

    const data = (await res.json()) as NavMeshData;

    const navMesh = createNavMesh();
    navMesh.origin = data.origin;
    navMesh.tileWidth = data.tileWidth;
    navMesh.tileHeight = data.tileHeight;
    for (const tile of data.tiles) {
        addTile(navMesh, tile);
    }

    navigation.navMesh = navMesh;
    navigation.crowd = crowd.create(CROWD_MAX_AGENT_RADIUS);
    // Default placement tolerance is just maxAgentRadius (tiny); widen it so an agent snaps onto
    // the navmesh even if its spawn point isn't exactly on a poly.
    navigation.crowd.agentPlacementHalfExtents = [1, 2, 1];
}

/* ---------------- crowd (agent steering / avoidance) ---------------- */

const _nearest = createFindNearestPolyResult();

// Default agent params for a creature of the given radius/height/speed.
export function makeAgentParams(radius: number, height: number, maxSpeed: number): crowd.AgentParams {
    return {
        radius,
        height,
        maxAcceleration: maxSpeed * 8,
        maxSpeed,
        collisionQueryRange: radius * 6,
        separationWeight: 1,
        updateFlags:
            crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
            crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
            crowd.CrowdUpdateFlags.SEPARATION |
            crowd.CrowdUpdateFlags.OPTIMIZE_VIS |
            crowd.CrowdUpdateFlags.OPTIMIZE_TOPO,
        queryFilter: DEFAULT_QUERY_FILTER,
    };
}

export function addCrowdAgent(navigation: Navigation, position: Vec3, params: crowd.AgentParams): string | null {
    if (!navigation.crowd || !navigation.navMesh) return null;
    return crowd.addAgent(navigation.crowd, navigation.navMesh, position, params);
}

export function removeCrowdAgent(navigation: Navigation, agentId: string): void {
    if (navigation.crowd) crowd.removeAgent(navigation.crowd, agentId);
}

// Snap a world point onto the nearest navmesh poly; false if none within the search box.
// Also used by recovery (re-grounding an off-mesh creature).
export function snapToNavMesh(navigation: Navigation, point: Vec3, out: Vec3): boolean {
    if (!navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, point, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    out[0] = _nearest.position[0];
    out[1] = _nearest.position[1];
    out[2] = _nearest.position[2];
    return true;
}

export function getAgent(navigation: Navigation, agentId: string): crowd.Agent | undefined {
    return navigation.crowd?.agents[agentId];
}

const PATH_HALF_EXTENTS: Vec3 = [1, 2, 1]; // tolerance clamping start/end onto the mesh

// Find a walkable route from `from` to `to` and return its corner points (world space), or null
// if there's no path. Used to draw the objective trail.
export function computePath(navigation: Navigation, from: Vec3, to: Vec3): Vec3[] | null {
    if (!navigation.navMesh) return null;
    const res = findPath(navigation.navMesh, from, to, PATH_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!res.success || res.path.length === 0) return null;
    return res.path.map((pt) => [pt.position[0], pt.position[1], pt.position[2]] as Vec3);
}

// Add the player's proxy agent to the crowd (target-less; driven by hand via updatePlayerAgent, not
// by steering). Call once after the navmesh loads.
export function addPlayerAgent(navigation: Navigation, position: Vec3): void {
    const params = makeAgentParams(PLAYER_AGENT_RADIUS, PLAYER_AGENT_HEIGHT, 4);
    navigation.playerAgentId = addCrowdAgent(navigation, position, params);
}

const _playerSnap: Vec3 = [0, 0, 0];

// Pin the player's proxy agent to the player each frame. Call BEFORE updateCrowd so companions
// steer around where the player is (and, via velocity, where they're headed). Snap to the navmesh
// so the proxy stays on the walkable floor; off-mesh (mid-jump) fall back to the raw position.
// The agent has no target, so we fully overwrite its transform and it never drifts.
export function updatePlayerAgent(navigation: Navigation, position: Vec3, velocity: Vec3): void {
    if (!navigation.crowd || navigation.playerAgentId === null) return;
    const agent = navigation.crowd.agents[navigation.playerAgentId];
    if (!agent) return;

    if (snapToNavMesh(navigation, position, _playerSnap)) {
        agent.position[0] = _playerSnap[0];
        agent.position[1] = _playerSnap[1];
        agent.position[2] = _playerSnap[2];
    } else {
        agent.position[0] = position[0];
        agent.position[1] = position[1];
        agent.position[2] = position[2];
    }

    // Feed the horizontal velocity so RVO anticipates our motion (crowd is 2.5D, no y).
    agent.velocity[0] = velocity[0];
    agent.velocity[1] = 0;
    agent.velocity[2] = velocity[2];
    agent.desiredVelocity[0] = velocity[0];
    agent.desiredVelocity[1] = 0;
    agent.desiredVelocity[2] = velocity[2];
}

export function setAgentMaxSpeed(navigation: Navigation, agentId: string, maxSpeed: number): void {
    const agent = navigation.crowd?.agents[agentId];
    if (agent) agent.maxSpeed = maxSpeed;
}

// Send an agent toward a world point (snapped onto the navmesh).
export function setAgentTarget(navigation: Navigation, agentId: string, target: Vec3): boolean {
    if (!navigation.crowd || !navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, target, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    return crowd.requestMoveTarget(navigation.crowd, agentId, _nearest.nodeRef, _nearest.position);
}

export function setAgentVelocity(navigation: Navigation, agentId: string, velocity: Vec3): boolean {
    if (!navigation.crowd) return false;
    return crowd.requestMoveVelocity(navigation.crowd, agentId, velocity);
}

export function isAgentAtTarget(navigation: Navigation, agentId: string, threshold: number): boolean {
    if (!navigation.crowd) return false;
    return crowd.isAgentAtTarget(navigation.crowd, agentId, threshold);
}

export function updateCrowd(navigation: Navigation, dt: number): void {
    if (!navigation.crowd || !navigation.navMesh) return;
    crowd.update(navigation.crowd, navigation.navMesh, dt);
}

export function updateNavigation(navigation: Navigation, scene: THREE.Scene, show: boolean): void {
    if (!navigation.navMesh) return;

    if (show && !navigation.navMeshHelper) {
        const helper = createNavMeshHelper(navigation.navMesh);

        helper.object.traverse((o) => {
            if (o instanceof THREE.Mesh) {
                o.frustumCulled = false;
                o.renderOrder = 999;

                const materials = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshBasicMaterial[];
                for (const mat of materials) {
                    mat.transparent = true;
                    mat.opacity = 0.5;
                    mat.depthWrite = false;
                    mat.depthTest = false;
                }
            }
        });

        scene.add(helper.object);
        navigation.navMeshHelper = helper;
    } else if (!show && navigation.navMeshHelper) {
        scene.remove(navigation.navMeshHelper.object);
        navigation.navMeshHelper.dispose();
        navigation.navMeshHelper = null;
    }
}
