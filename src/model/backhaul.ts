import { distance2D } from './physics';

export function dijkstraDistance(n: number, edgeW: number[][]): number[][] {
  const dist = edgeW.map(r => r.slice());
  for (let i = 0; i < n; i += 1) {
    dist[i][i] = 0;
  }

  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (dist[i][k] + dist[k][j] < dist[i][j]) {
          dist[i][j] = dist[i][k] + dist[k][j];
        }
      }
    }
  }

  return dist;
}

export function backhaulMeanDelay(args: {
  srcBsId: number;
  dstBsId: number;
  bsPositions?: { x: number; y: number }[];
  dataBytes: number;
  shape: number;
  scalePerMeter: number;
  useMultiHop?: boolean;
  allDistances?: number[][];
}): number {
  const { srcBsId, dstBsId, dataBytes, shape, scalePerMeter, useMultiHop = false } = args;

  if (srcBsId === dstBsId) {
    return 0;
  }

  const dMeters = useMultiHop && args.allDistances
    ? Math.max(0.1, args.allDistances[srcBsId][dstBsId])
    : (args.bsPositions && args.bsPositions[srcBsId] && args.bsPositions[dstBsId]
      ? Math.max(1, distance2D(args.bsPositions[srcBsId], args.bsPositions[dstBsId]))
      : 1);

  const scale = dMeters * scalePerMeter;
  if (scale <= 0) {
    return 0;
  }

  return shape * scale * dataBytes;
}
