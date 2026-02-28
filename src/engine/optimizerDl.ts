import type { BS, Community, User, Params } from '../types';

export function optimizeDlBandwidth(args: {
  bs: BS[];
  communities: Community[];
  users: User[];
  assignment: number[];
  params: Params;
  userRates: Map<number, number>;
}): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<string, number>();

  for (let u = 0; u < args.users.length; u += 1) {
    const b = args.assignment[u];
    const c = args.users[u].communityId;
    const key = `${b}:${c}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const denom = Array.from(groups.entries()).reduce((a, [, cnt]) => a + cnt, 0) || 1;
  groups.forEach((_cnt, key) => {
    out.set(key, (args.params.totalBandwidthHz * 0.5 * (1 / denom)));
  });

  const remaining = args.params.totalBandwidthHz * 0.5;
  const totalWeight = Array.from(groups.values()).reduce((a, b) => a + Math.sqrt(b), 0) || 1;
  out.forEach((_v, key) => {
    const w = Math.sqrt(groups.get(key) || 1);
    out.set(key, (remaining * w) / totalWeight);
  });

  return out;
}
