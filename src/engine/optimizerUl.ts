import type { Params, User, LinkSample, Allocation } from '../types';

export function optimizeUlBandwidth(args: {
  users: User[];
  bs: any[];
  allocationsByUser: Record<number, number>;
  assignment: number[];
  params: Params;
  stepLimit: number;
  linkRates: Map<number, number>;
  crossTypePenalty: Map<number, number>;
  totalBudgetHz: number;
}): number[] {
  const n = args.users.length;
  const beta = new Array<number>(n).fill(0);

  if (n === 0) {
    return beta;
  }

  const weights: number[] = [];
  let sumWeight = 0;
  for (let i = 0; i < n; i += 1) {
    const w = Math.max(1e-6, Math.log1p(args.linkRates.get(i) || 1e-3));
    const penalty = args.crossTypePenalty.get(i) ?? 0;
    const finalW = w / (1 + penalty);
    weights.push(finalW);
    sumWeight += finalW;
  }

  const target = args.totalBudgetHz;
  for (let i = 0; i < n; i += 1) {
    beta[i] = target * (weights[i] / sumWeight);
  }

  const lambda = args.allocationsByUser;
  let step = 0;
  while (step < Math.max(0, args.stepLimit)) {
    step += 1;
    for (let i = 0; i < n; i += 1) {
      const grad = (lambda[i] || 0) * 1e-4;
      beta[i] = Math.max(1e-6, beta[i] - grad);
    }

    const s = beta.reduce((a, b) => a + b, 0);
    const scale = target / Math.max(s, 1e-12);
    for (let i = 0; i < n; i += 1) {
      beta[i] *= scale;
    }
  }

  return beta;
}
