import { fadingRayleighSample, distance2D, boundedDistance, pathlossLinear, sinrLinear } from './physics';
import type { LinkSample } from '../types';

export function spectralEfficiencyFromSinr(sinrLin: number): number {
  return Math.max(0, Math.log2(1 + Math.max(0, sinrLin)));
}

export function linkRateHz(
  bandwidthHz: number,
  sinrLin: number,
  efficiencyFactor = 1
): number {
  return bandwidthHz * spectralEfficiencyFromSinr(sinrLin) * Math.max(0, efficiencyFactor);
}

export function expectedRateFromFading(input: {
  bandwidthHz: number;
  txPowerW: number;
  noisePSD: number;
  txPos: { x: number; y: number };
  rxPos: { x: number; y: number };
  alpha: number;
  dMin: number;
  fadingSamples: number;
  rng: () => number;
}): LinkSample {
  let accRate = 0;
  let accSinr = 0;

  if (input.fadingSamples <= 1) {
    const g = fadingRayleighSample(input.rng);
    const d = boundedDistance(input.txPos, input.rxPos, input.dMin);
    const pl = pathlossLinear(d, input.alpha);
    const sinr = sinrLinear({
      txPowerW: input.txPowerW,
      channelGain: pl * g,
      noiseW: input.noisePSD
    });
    return {
      sinrLin: sinr,
      rateBps: linkRateHz(input.bandwidthHz, sinr)
    };
  }

  for (let i = 0; i < input.fadingSamples; i += 1) {
    const g = fadingRayleighSample(input.rng);
    const d = boundedDistance(input.txPos, input.rxPos, input.dMin);
    const pl = pathlossLinear(d, input.alpha);
    const sinr = sinrLinear({
      txPowerW: input.txPowerW,
      channelGain: pl * g,
      noiseW: input.noisePSD * distance2D(input.txPos, input.rxPos)
    });
    const rate = linkRateHz(input.bandwidthHz, sinr);
    accRate += rate;
    accSinr += sinr;
  }

  const invN = 1 / input.fadingSamples;
  return {
    sinrLin: accSinr * invN,
    rateBps: accRate * invN
  };
}
