export function computeDelayMs(args: {
  numUsersInCommunity: number;
  cyclesPerPacket: number;
  cpuCyclesPerSec: number;
  packetBytes: number;
  bandwidthUtilization?: number;
}): number {
  const util = Math.min(Math.max(args.bandwidthUtilization ?? 1, 0.01), 1);
  const cycles = args.numUsersInCommunity * args.cyclesPerPacket;
  const workSeconds = cycles / Math.max(args.cpuCyclesPerSec, 1);
  return workSeconds / util;
}
