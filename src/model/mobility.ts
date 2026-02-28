import type { User, Vec2, MobilityRuntime } from '../types';

function rand(rng: () => number): number {
  const u = rng();
  return u <= 0 ? Number.EPSILON : u;
}

function randomVec2(rng: () => number, xMax: number, yMax: number): Vec2 {
  return { x: rand(rng) * xMax, y: rand(rng) * yMax };
}

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function randomPause(rng: () => number, pauseMinSec: number, pauseMaxSec: number): number {
  return pauseMinSec + rand(rng) * Math.max(0, pauseMaxSec - pauseMinSec);
}

export function initMobilityRuntime(
  users: User[],
  opts: {
    physicalW: number;
    physicalH: number;
    rng?: () => number;
    speed: number;
    virtualSpeed?: number;
    pauseMinSec?: number;
    pauseMaxSec?: number;
    virtualSpaceCount?: number;
  }
): MobilityRuntime {
  const gen = opts.rng ?? Math.random;
  const pauseMinSec = opts.pauseMinSec ?? 0.2;
  const pauseMaxSec = opts.pauseMaxSec ?? 1.2;
  const physicalTargets: Vec2[] = [];
  const virtualTargets: Vec2[] = [];
  const physicalPauseSec: number[] = [];
  const virtualPauseSec: number[] = [];
  const userVirtualPos: Vec2[] = [];

  const vCount = Math.max(1, opts.virtualSpaceCount ?? 1);
  for (const u of users) {
    physicalTargets.push(randomVec2(gen, opts.physicalW, opts.physicalH));
    virtualTargets.push({ x: rand(gen), y: rand(gen) });
    physicalPauseSec.push(randomPause(gen, pauseMinSec, pauseMaxSec));
    virtualPauseSec.push(randomPause(gen, pauseMinSec, pauseMaxSec));
    userVirtualPos.push({ x: clamp01(u.id % vCount === 0 ? rand(gen) : rand(gen)), y: rand(gen) });
  }

  return {
    enabled: true,
    physicalSpeed: Math.max(0, opts.speed),
    virtualSpeed: Math.max(0, opts.virtualSpeed ?? opts.speed),
    virtualInteractionMode: 'nearestK',
    virtualK: 2,
    virtualRadius: 0.2,
    pauseMinSec,
    pauseMaxSec,
    physicalTargets,
    physicalPauseSec,
    virtualTargets,
    virtualPauseSec,
    userVirtualPos
  };
}

export function mapCommunityToVirtualSpace(user: User, communities: number[]): number {
  if (!communities.length) return 0;
  return Math.max(0, user.communityId % communities.length);
}

export function stepMobilityRandomWaypoint(args: {
  users: User[];
  communities: number[];
  state: MobilityRuntime;
  dtSec: number;
  physicalW: number;
  physicalH: number;
  virtualSpeedFactor: number;
}) {
  if (!args.state.enabled || args.dtSec <= 0 || !args.users.length) {
    return;
  }

  const v = Math.max(0, args.state.physicalSpeed);
  const vVirtual = Math.max(0, args.state.virtualSpeed * args.virtualSpeedFactor);

  for (let i = 0; i < args.users.length; i += 1) {
    const user = args.users[i];
    const p = args.state.physicalPauseSec[i];
    if (p > 0) {
      args.state.physicalPauseSec[i] = Math.max(0, p - args.dtSec);
    } else {
      const target = args.state.physicalTargets[i];
      const dx = target.x - user.pos.x;
      const dy = target.y - user.pos.y;
      const d = Math.hypot(dx, dy);

      if (d < 1) {
        args.state.physicalTargets[i] = randomVec2(Math.random, args.physicalW, args.physicalH);
        args.state.physicalPauseSec[i] = randomPause(Math.random, args.state.pauseMinSec, args.state.pauseMaxSec);
      } else {
        const ratio = Math.min(1, (v * args.dtSec) / d);
        user.pos.x = clamp(user.pos.x + dx * ratio, 0, args.physicalW);
        user.pos.y = clamp(user.pos.y + dy * ratio, 0, args.physicalH);
      }
    }

    const vp = args.state.virtualPauseSec[i];
    if (vp > 0) {
      args.state.virtualPauseSec[i] = Math.max(0, vp - args.dtSec);
    } else {
      const vPos = args.state.userVirtualPos[i];
      const vTgt = args.state.virtualTargets[i];
      const dx = vTgt.x - vPos.x;
      const dy = vTgt.y - vPos.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.01) {
        args.state.virtualTargets[i] = {
          x: Math.random(),
          y: Math.random()
        };
        args.state.virtualPauseSec[i] = randomPause(Math.random, args.state.pauseMinSec, args.state.pauseMaxSec);
      } else {
        const ratio = Math.min(1, (vVirtual * args.dtSec) / Math.max(d, 1e-9));
        vPos.x = clamp01(vPos.x + dx * ratio);
        vPos.y = clamp01(vPos.y + dy * ratio);
      }
    }
  }
}
