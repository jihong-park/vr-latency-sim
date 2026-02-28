import { distance2D } from '../model/physics';
import { expectedRateFromFading } from '../model/linkBudget';
import { expectedTxTimeFromHarq } from '../model/harq';
import { backhaulMeanDelay } from '../model/backhaul';
import { computeDelayMs } from '../model/compute';
import type { Allocation, BS, Community, LatencyBreakdown, LinkSample, Params, SimulationResult, User, UserLatency } from '../types';

export function latencyForUser(args: {
  user: User;
  assignedBsId: number;
  community: Community;
  bs: BS[];
  params: Params;
  ulAllocHz: number;
  dlAllocHz: number;
  channelState: LinkSample;
  rng: () => number;
}): LatencyBreakdown {
  const bits = args.params.packetBytes * 8;

  const ulRate = Math.max(args.channelState.rateBps, 1e-9);
  const ul = expectedTxTimeFromHarq({
    slotTime: args.params.slotTime,
    rateBps: Math.max(args.ulAllocHz, 1e-9) * args.channelState.sinrLin,
    bits,
    targetOutage: args.params.targetOutage
  });

  const serverBs = args.community.serverMode === 'atBS'
    ? args.community.serverBsId ?? args.assignedBsId
    : args.assignedBsId;

  const targetServerPos = args.community.serverMode === 'atBS'
    ? args.bs[serverBs].pos
    : args.community.serverPos ?? args.bs[args.assignedBsId].pos;

  const distToServer = args.community.serverMode === 'atBS'
    ? distance2D(args.bs[args.assignedBsId].pos, args.bs[serverBs].pos)
    : distance2D(args.bs[args.assignedBsId].pos, targetServerPos);

  const bh = backhaulMeanDelay({
    srcBsId: args.assignedBsId,
    dstBsId: serverBs,
    dataBytes: bits / 8,
    shape: args.params.backhaulShape,
    scalePerMeter: args.params.backhaulScalePerMeter,
    bsPositions: args.bs.map((b) => b.pos),
    useMultiHop: false
  }) + (Number.isFinite(args.params.backhaulLatencySec) ? Math.max(0, args.params.backhaulLatencySec) : 0);

  const dlSampleRate = expectedRateFromFading({
    bandwidthHz: Math.max(args.dlAllocHz, 1e-9),
    txPowerW: args.params.txPowerW,
    noisePSD: args.params.noisePSD,
    txPos: args.bs[args.assignedBsId].pos,
    rxPos: args.user.pos,
    alpha: args.params.alpha,
    dMin: args.params.dMin,
    fadingSamples: 1,
    rng: args.rng
  }).rateBps;

  const dl = expectedTxTimeFromHarq({
    slotTime: args.params.slotTime,
    rateBps: Math.max(dlSampleRate, 1e-9),
    bits,
    targetOutage: args.params.targetOutage
  });

  return {
    ul,
    dl,
    compute: distToServer > 0 ? computeDelayMs({
      numUsersInCommunity: 1,
      cyclesPerPacket: args.params.cyclesPerPacket,
      cpuCyclesPerSec: args.params.cpuCyclesPerSec,
      packetBytes: args.params.packetBytes
    }) + (Number.isFinite(args.params.computeLatencySec) ? Math.max(0, args.params.computeLatencySec) : 0)
      : 0,
    backhaul: bh,
    e2e: ul + dl + (distToServer > 0 ? computeDelayMs({
      numUsersInCommunity: 1,
      cyclesPerPacket: args.params.cyclesPerPacket,
      cpuCyclesPerSec: args.params.cpuCyclesPerSec,
      packetBytes: args.params.packetBytes
    }) + (Number.isFinite(args.params.computeLatencySec) ? Math.max(0, args.params.computeLatencySec) : 0) : 0) + bh,
  } as LatencyBreakdown;
}

export function evaluateCommunity(
  users: User[],
  usersInCommunity: number[],
  state: {
    bs: BS[];
    params: Params;
    allocation: Allocation;
    communities: Community[];
    assignment: number[];
  },
  samples: number
): { mean: number; byUser: UserLatency[]; p95: number } {
  const byUser: UserLatency[] = [];
  const rng = () => Math.random();
  let sum = 0;
  const values: number[] = [];

  const computeUsers = users.filter((u) => usersInCommunity.includes(u.id));
  const compDelay = computeDelayMs({
    numUsersInCommunity: Math.max(usersInCommunity.length, 1),
    cyclesPerPacket: state.params.cyclesPerPacket,
    cpuCyclesPerSec: state.params.cpuCyclesPerSec,
    packetBytes: state.params.packetBytes
  }) + (Number.isFinite(state.params.computeLatencySec) ? Math.max(0, state.params.computeLatencySec) : 0);

  for (let s = 0; s < Math.max(1, samples); s += 1) {
    for (const u of computeUsers) {
      const c = state.communities[u.communityId];
      const ulLink = expectedRateFromFading({
        bandwidthHz: state.allocation.ul[u.id],
        txPowerW: state.params.txPowerW,
        noisePSD: state.params.noisePSD,
        txPos: u.pos,
        rxPos: state.bs[state.assignment[u.id]].pos,
        alpha: state.params.alpha,
        dMin: state.params.dMin,
        fadingSamples: 1,
        rng
      });

      const key = `${state.assignment[u.id]}:${u.communityId}`;
      const dlAlloc = state.allocation.dl.get(key) ?? state.params.totalBandwidthHz / (state.bs.length || 1);

      const b = latencyForUser({
        user: u,
        assignedBsId: state.assignment[u.id],
        community: c,
        bs: state.bs,
        params: state.params,
        ulAllocHz: state.allocation.ul[u.id],
        dlAllocHz: dlAlloc,
        channelState: ulLink,
        rng
      });

      b.compute = compDelay;
      b.e2e = b.ul + b.dl + b.compute + b.backhaul;
      values.push(b.e2e);
      sum += b.e2e;
      byUser.push({ userId: u.id, communityId: u.communityId, assignedBsId: state.assignment[u.id], breakdown: b });
    }
  }

  const pSorted = values.slice().sort((a, b2) => a - b2);
  const p95 = pSorted.length ? pSorted[Math.floor(0.95 * (pSorted.length - 1))] : 0;

  return { mean: values.length ? sum / values.length : 0, byUser, p95 };
}

export function e2eFromBreakdowns(breakdowns: LatencyBreakdown[]): number {
  if (!breakdowns.length) return 0;
  return breakdowns.reduce((acc, b) => acc + b.e2e, 0) / breakdowns.length;
}
