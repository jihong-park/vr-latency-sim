import type { BS, Community, Params, RunConfig, User, Vec2, MobilityRuntime } from '../types';
import { generateBSs, generateUsers, assignUsers } from '../model/topology';
import { initMobilityRuntime } from '../model/mobility';

function nearestBsId(state: { bs: BS[] }, pos?: Vec2): number {
  if (!state.bs.length || !pos) return 0;

  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < state.bs.length; i += 1) {
    const b = state.bs[i];
    const dx = b.pos.x - pos.x;
    const dy = b.pos.y - pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return best;
}

export type SimState = {
  width: number;
  height: number;
  bs: BS[];
  users: User[];
  communities: Community[];
  assignment: number[];
  mobility: MobilityRuntime;
  params: Params;
  runConfig: RunConfig;
};

function buildCommunityUsers(users: User[], communityCount: number): Community[] {
  const buckets: number[][] = Array.from({ length: communityCount }, () => []);
  for (const u of users) {
    buckets[u.communityId].push(u.id);
  }
  return buckets.map((userIds, id) => ({
    id,
    userIds,
    serverMode: 'atBS',
    serverBsId: 0
  }));
}

export function makeInitialState(seed = 1): SimState {
  const width = 1000;
  const height = 600;
  const bs = generateBSs(4, width, height, seed);
  const users = generateUsers(80, { x: width, y: height }, 2, seed + 1);
  const communities = buildCommunityUsers(users, 2);
  const assignment = assignUsers({ users, bs, mode: 'nearest' });
  const mobility = initMobilityRuntime(users, {
    physicalW: width,
    physicalH: height,
    speed: 10,
    virtualSpeed: 2,
    virtualSpaceCount: communities.length
  });

  return {
    width,
    height,
    bs,
    users,
    communities,
    assignment,
    mobility,
    params: {
      totalBandwidthHz: 20e6,
      txPowerW: 1,
      noisePSD: 1e-9,
      alpha: 3.5,
      dMin: 1,
      targetOutage: 0.1,
      packetBytes: 1024,
      cyclesPerPacket: 2e6,
      cpuCyclesPerSec: 4e9,
      backhaulShape: 0.01,
      backhaulScalePerMeter: 1e-5,
      backhaulLatencySec: 0.002,
      computeLatencySec: 0.001,
      slotTime: 0.005,
      assignmentMode: 'nearest'
    },
    runConfig: {
      monteCarloSamples: 20,
      optimizeAssociation: false,
      optimizeServer: false
    }
  };
}

export function setUserCount(state: SimState, userCount: number, seed = 12345): void {
  const count = Math.max(1, Math.round(userCount));
  const communityCount = Math.max(1, state.communities.length);
  const oldCommunities = state.communities.map((c) => ({
    id: c.id,
    serverMode: c.serverMode,
    serverBsId: c.serverBsId,
    serverPos: c.serverPos
  }));
  const oldMobility = state.mobility;

  state.users = generateUsers(count, { x: state.width, y: state.height }, communityCount, seed);
  state.communities = buildCommunityUsers(state.users, communityCount);
  for (const c of state.communities) {
    const prev = oldCommunities.find((x) => x.id === c.id);
    if (!prev) continue;
    c.serverMode = 'atBS';
    if (prev.serverMode === 'atBS') {
      const safeBsCount = Math.max(1, state.bs.length);
      c.serverBsId = ((prev.serverBsId ?? 0) % safeBsCount + safeBsCount) % safeBsCount;
    } else if (prev.serverPos) {
      c.serverBsId = nearestBsId(state, prev.serverPos);
    } else if (Number.isFinite(prev.serverBsId ?? NaN) && state.bs.length) {
      c.serverBsId = ((prev.serverBsId ?? 0) % state.bs.length + state.bs.length) % state.bs.length;
    } else {
      c.serverBsId = 0;
    }
    c.serverPos = undefined;
  }

  state.mobility = initMobilityRuntime(state.users, {
    physicalW: state.width,
    physicalH: state.height,
    speed: oldMobility.physicalSpeed,
    virtualSpeed: oldMobility.virtualSpeed,
    virtualSpaceCount: communityCount
  });
  state.mobility.virtualInteractionMode = oldMobility.virtualInteractionMode;
  state.mobility.virtualK = oldMobility.virtualK;
  state.mobility.virtualRadius = oldMobility.virtualRadius;

  setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
}

export function setVirtualSpaceCount(state: SimState, virtualSpaceCount: number): void {
  const nextCount = Math.max(1, Math.round(virtualSpaceCount));
  const oldMobility = state.mobility;
  const oldCommunities = state.communities.map((c) => ({
    id: c.id,
    serverMode: c.serverMode,
    serverBsId: c.serverBsId,
    serverPos: c.serverPos
  }));

  state.users.forEach((u) => {
    u.communityId = u.id % nextCount;
  });
  state.communities = buildCommunityUsers(state.users, nextCount);

  for (const c of state.communities) {
    const prev = oldCommunities.find((x) => x.id === c.id);
    if (prev) {
      const prevAtBs = prev.serverMode === 'atBS';
      const prevBs = prev.serverBsId;
      const prevPos = prev.serverPos;
      c.serverMode = 'atBS';
      if (prevAtBs && Number.isFinite(prevBs ?? NaN)) {
        const safeBsCount = Math.max(1, state.bs.length);
        c.serverBsId = ((prevBs ?? 0) % safeBsCount + safeBsCount) % safeBsCount;
      } else if (prevPos) {
        c.serverBsId = nearestBsId(state, prevPos);
      } else {
        c.serverBsId = 0;
      }
      c.serverPos = undefined;
    } else {
      c.serverMode = 'atBS';
      c.serverBsId = state.bs.length ? c.id % state.bs.length : 0;
      c.serverPos = undefined;
    }
  }

  state.mobility = initMobilityRuntime(state.users, {
    physicalW: state.width,
    physicalH: state.height,
    speed: oldMobility.physicalSpeed,
    virtualSpeed: oldMobility.virtualSpeed,
    virtualSpaceCount: nextCount
  });
  state.mobility.virtualInteractionMode = oldMobility.virtualInteractionMode;
  state.mobility.virtualK = oldMobility.virtualK;
  state.mobility.virtualRadius = oldMobility.virtualRadius;

  setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
}

export function setServerToBs(state: SimState, communityId: number, bsId: number): void {
  const c = state.communities[communityId];
  if (!c) return;
  c.serverMode = 'atBS';
  c.serverBsId = bsId;
  c.serverPos = undefined;
}

export function setServerPos(state: SimState, communityId: number, pos: Vec2): void {
  const c = state.communities[communityId];
  if (!c) return;
  c.serverMode = 'atBS';
  c.serverBsId = nearestBsId(state, pos);
  c.serverPos = undefined;
}

export function setAssignmentMode(
  state: SimState,
  mode: 'nearest' | 'fixed' | 'greedyDl' | 'optAssociation'
): void {
  state.params.assignmentMode = mode;
  state.assignment = assignUsers({ users: state.users, bs: state.bs, mode, fixedMap: undefined });
}
