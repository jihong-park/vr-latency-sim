export function outageProbability(sinrLin: number, targetSinr: number): number {
  return sinrLin >= targetSinr ? 0 : 1;
}

export function expectedHarqAttempts(targetOutage: number, sinrLin: number): number {
  const pOut = Math.min(Math.max(targetOutage * Math.exp(-sinrLin), 0.001), 0.999);
  return 1 / (1 - pOut);
}

export function expectedTxTimeFromHarq(args: {
  slotTime: number;
  rateBps: number;
  bits: number;
  targetOutage: number;
}): number {
  if (args.rateBps <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  const expAttempts = expectedHarqAttempts(args.targetOutage, args.bits / args.rateBps);
  const tx = Math.max(0, args.bits / args.rateBps);
  return expAttempts * args.slotTime + tx;
}
