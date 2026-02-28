import type { BS, Vec2, User, Community } from '../types';

function randomSeeded(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function generateBSs(m: number, width: number, height: number, seed = 1): BS[] {
  const rng = randomSeeded(seed);
  const bs: BS[] = [];
  for (let i = 0; i < m; i += 1) {
    bs.push({
      id: i,
      pos: {
        x: rng() * width,
        y: rng() * height
      }
    });
  }
  return bs;
}

export function generateUsers(n: number, bounds: { x: number; y: number }, communities: number, seed = 2): User[] {
  const rng = randomSeeded(seed);
  const users: User[] = [];
  for (let i = 0; i < n; i += 1) {
    users.push({
      id: i,
      pos: {
        x: rng() * bounds.x,
        y: rng() * bounds.y
      },
      communityId: i % communities
    });
  }
  return users;
}

export function assignUsers(args: {
  users: User[];
  bs: BS[];
  mode: 'nearest' | 'fixed' | 'greedyDl' | 'optAssociation';
  fixedMap?: number[];
}): number[] {
  const out = new Array<number>(args.users.length).fill(0);

  for (let u = 0; u < args.users.length; u += 1) {
    if (args.mode === 'fixed' && args.fixedMap) {
      out[u] = args.fixedMap[u];
      continue;
    }

    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    const user = args.users[u];
    for (let b = 0; b < args.bs.length; b += 1) {
      const dx = user.pos.x - args.bs[b].pos.x;
      const dy = user.pos.y - args.bs[b].pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    out[u] = best;
  }

  return out;
}

export function setCommunityServers(args: {
  communities: Community[];
  bs: BS[];
  communityCount: number;
  bsPreset: number[];
}): Community[] {
  const out: Community[] = [];
  for (let c = 0; c < communityCount; c += 1) {
    const users = args.communities[c]?.userIds ?? [];
    out.push({
      id: c,
      userIds: users,
      serverMode: 'atBS',
      serverBsId: args.bsPreset[c % args.bsPreset.length] ?? 0
    });
  }
  return out;
}

export function moveServerToBs(communities: Community[], cId: number, bsId: number): void {
  const c = communities[cId];
  if (!c) return;
  c.serverMode = 'atBS';
  c.serverBsId = bsId;
  c.serverPos = undefined;
}

export function moveServerToPoint(communities: Community[], cId: number, _pos: Vec2): void {
  const c = communities[cId];
  if (!c) return;
  c.serverMode = 'atBS';
  c.serverBsId = 0;
  c.serverPos = undefined;
}
