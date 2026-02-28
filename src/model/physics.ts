import type { Vec2 } from '../types';

export function distance2D(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function boundedDistance(a: Vec2, b: Vec2, dMin: number): number {
  return Math.max(distance2D(a, b), dMin);
}

export function pathlossLinear(distance: number, alpha: number, k = 1): number {
  const d = Math.max(distance, 1e-9);
  return k / Math.pow(d, alpha);
}

// Returns a Rayleigh power gain sample (exponential mean 1), equivalent to |h|^2
export function fadingRayleighSample(rng: () => number): number {
  let u = rng();
  if (u <= 0) {
    u = Number.EPSILON;
  }
  return -Math.log(1 - u);
}

export function sinrLinear(params: { txPowerW: number; channelGain: number; noiseW: number }): number {
  const s = Math.max(params.txPowerW * Math.max(params.channelGain, 0), 0);
  return s / Math.max(params.noiseW, Number.EPSILON);
}
