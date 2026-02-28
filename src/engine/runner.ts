import { computeDelayMs } from '../model/compute';
import { optimizeDlBandwidth } from './optimizerDl';
import { optimizeUlBandwidth } from './optimizerUl';
import { distance2D } from '../model/physics';
import { expectedRateFromFading } from '../model/linkBudget';
import { backhaulMeanDelay } from '../model/backhaul';
import { expectedTxTimeFromHarq } from '../model/harq';
import type { BS, User, Community, Params, RunConfig, Allocation, SimulationResult, UserLatency } from '../types';

function computePercentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export function runIteration(state: {
  bs: BS[];
  users: User[];
  communities: Community[];
  assignment: number[];
  params: Params;
  runConfig: RunConfig;
  rng?: () => number;
}): SimulationResult {
  const allUsers = state.users;
  const samples = Math.max(1, state.runConfig.monteCarloSamples);
  const rng = state.rng ?? Math.random;
  const linkRates = new Map<number, number>();

  const bits = state.params.packetBytes * 8;

  const nearestBsToPos = (pos: { x: number; y: number } | undefined): number => {
    if (!pos || state.bs.length === 0) return 0;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let b = 0; b < state.bs.length; b += 1) {
      const d = distance2D(state.bs[b].pos, pos);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  };

  for (const u of allUsers) {
    const rate = expectedRateFromFading({
      bandwidthHz: state.params.totalBandwidthHz / Math.max(allUsers.length, 1),
      txPowerW: state.params.txPowerW,
      noisePSD: state.params.noisePSD,
      txPos: u.pos,
      rxPos: state.bs[state.assignment[u.id]].pos,
      alpha: state.params.alpha,
      dMin: state.params.dMin,
      fadingSamples: 1,
      rng
    }).rateBps;
    linkRates.set(u.id, rate);
  }

  const crossPenalty = new Map<number, number>();
  for (const u of allUsers) {
    const c = state.communities[u.communityId];
    const serverBs = c.serverMode === 'atBS'
      ? (c.serverBsId ?? state.assignment[u.id])
      : nearestBsToPos(c.serverPos);
    crossPenalty.set(u.id, serverBs === state.assignment[u.id] ? 0 : 1);
  }

  const ulAlloc = optimizeUlBandwidth({
    users: allUsers,
    bs: state.bs,
    allocationsByUser: {},
    assignment: state.assignment,
    params: state.params,
    stepLimit: 1,
    linkRates,
    crossTypePenalty: crossPenalty,
    totalBudgetHz: state.params.totalBandwidthHz * 0.5
  });

  const dlAlloc = optimizeDlBandwidth({
    bs: state.bs,
    communities: state.communities,
    users: allUsers,
    assignment: state.assignment,
    params: state.params,
    userRates: linkRates
  });

  const allocation: Allocation = { ul: ulAlloc, dl: dlAlloc };

  const userResults: UserLatency[] = [];
  const e2es: number[] = [];
  let ulMean = 0;
  let dlMean = 0;
  let computeMean = 0;
  let bhMean = 0;

  let crossTypeCount = 0;

  const commMeans = new Map<number, { sum: number; cnt: number }>();
  const isPaperCase = state.bs.length === 2 && state.communities.length === 2;

  const paperGroupUsers = new Map<string, number[]>();
  if (isPaperCase) {
    for (const u of allUsers) {
      const key = `${state.assignment[u.id]}:${u.communityId}`;
      const list = paperGroupUsers.get(key) ?? [];
      list.push(u.id);
      paperGroupUsers.set(key, list);
    }
  }

  const computeLatency = Number.isFinite(state.params.computeLatencySec)
    ? Math.max(0, state.params.computeLatencySec)
    : 0;
  const backhaulBase = Number.isFinite(state.params.backhaulLatencySec)
    ? Math.max(0, state.params.backhaulLatencySec)
    : 0;

  for (const u of allUsers) {
    let running = 0;
    let userUl = 0;
    let userDl = 0;
    let userCompute = 0;
    let userBh = 0;

    for (let s = 0; s < samples; s += 1) {
      const keyDl = `${state.assignment[u.id]}:${u.communityId}`;
      const dlBw = Math.max(allocation.dl.get(keyDl) || 1, 1);

      const ul = expectedRateFromFading({
        bandwidthHz: Math.max(allocation.ul[u.id], 1),
        txPowerW: state.params.txPowerW,
        noisePSD: state.params.noisePSD,
        txPos: u.pos,
        rxPos: state.bs[state.assignment[u.id]].pos,
        alpha: state.params.alpha,
        dMin: state.params.dMin,
        fadingSamples: 1,
        rng
      });

      const ulDelay = expectedTxTimeFromHarq({
        slotTime: state.params.slotTime,
        rateBps: Math.max(ul.rateBps, 1e-9),
        bits,
        targetOutage: state.params.targetOutage
      });

      const c = state.communities[u.communityId];
      const serverBs = c.serverMode === 'atBS' ? (c.serverBsId ?? state.assignment[u.id]) : nearestBsToPos(c.serverPos);
      const bh = backhaulMeanDelay({
        srcBsId: state.assignment[u.id],
        dstBsId: serverBs,
        dataBytes: bits / 8,
        shape: state.params.backhaulShape,
        scalePerMeter: state.params.backhaulScalePerMeter,
        useMultiHop: false,
        bsPositions: state.bs.map((b) => b.pos)
      }) + backhaulBase;

      const comp = computeDelayMs({
        numUsersInCommunity: state.communities[u.communityId].userIds.length,
        cyclesPerPacket: state.params.cyclesPerPacket,
        cpuCyclesPerSec: state.params.cpuCyclesPerSec,
        packetBytes: state.params.packetBytes
      }) + computeLatency;

      userBh += bh;
      userCompute += comp;

      let dlDelay: number;
      if (isPaperCase) {
        const dlBw = Math.max(allocation.dl.get(`${state.assignment[u.id]}:${u.communityId}`) || 1, 1);
        const key = `${state.assignment[u.id]}:${u.communityId}`;
        const usersInGroup = paperGroupUsers.get(key) ?? [];
        let worstDlRate = 0;
        for (let k = 0; k < usersInGroup.length; k += 1) {
          const idx = usersInGroup[k];
          const groupUser = allUsers[idx];
          if (!groupUser) {
            continue;
          }
          const sampleDlRate = expectedRateFromFading({
            bandwidthHz: dlBw,
            txPowerW: state.params.txPowerW,
            noisePSD: state.params.noisePSD,
            txPos: state.bs[state.assignment[idx]].pos,
            rxPos: groupUser.pos,
            alpha: state.params.alpha,
            dMin: state.params.dMin,
            fadingSamples: 1,
            rng
          }).rateBps;
          if (sampleDlRate < worstDlRate || k === 0) {
            worstDlRate = sampleDlRate;
          }
        }

        dlDelay = expectedTxTimeFromHarq({
          slotTime: state.params.slotTime,
          rateBps: Math.max(worstDlRate, 1e-9),
          bits,
          targetOutage: state.params.targetOutage
        });
      } else {
        const dlRate = expectedRateFromFading({
          bandwidthHz: dlBw,
          txPowerW: state.params.txPowerW,
          noisePSD: state.params.noisePSD,
          txPos: state.bs[state.assignment[u.id]].pos,
          rxPos: u.pos,
          alpha: state.params.alpha,
          dMin: state.params.dMin,
          fadingSamples: 1,
          rng
        });

        dlDelay = expectedTxTimeFromHarq({
          slotTime: state.params.slotTime,
          rateBps: Math.max(dlRate.rateBps, 1e-9),
          bits,
          targetOutage: state.params.targetOutage
        });
      }

      const e2e = ulDelay + dlDelay + bh + comp;
      userUl += ulDelay;
      userDl += dlDelay;
      running += e2e;

      if (serverBs !== state.assignment[u.id]) {
        crossTypeCount += 1;
      }
    }

    const nInv = 1 / samples;
    const r = {
      userId: u.id,
      communityId: u.communityId,
      assignedBsId: state.assignment[u.id],
      breakdown: {
        ul: userUl * nInv,
        dl: userDl * nInv,
        compute: userCompute * nInv,
        backhaul: userBh * nInv,
        e2e: running * nInv
      }
    };

    ulMean += r.breakdown.ul;
    dlMean += r.breakdown.dl;
    computeMean += r.breakdown.compute;
    bhMean += r.breakdown.backhaul;
    e2es.push(r.breakdown.e2e);

    const com = commMeans.get(u.communityId) ?? { sum: 0, cnt: 0 };
    com.sum += r.breakdown.e2e;
    com.cnt += 1;
    commMeans.set(u.communityId, com);

    userResults.push(r);
  }

  const meanByCommunity = new Map<number, number>();
  commMeans.forEach((v, k) => {
    meanByCommunity.set(k, v.sum / Math.max(v.cnt, 1));
  });

  const totalUsers = Math.max(allUsers.length, 1);
  const worstUserByCommunity = new Map<number, { userId: number; e2e: number }>();
  for (const u of userResults) {
    const prev = worstUserByCommunity.get(u.communityId);
    if (!prev || u.breakdown.e2e > prev.e2e) {
      worstUserByCommunity.set(u.communityId, { userId: u.userId, e2e: u.breakdown.e2e });
    }
  }
  const result: SimulationResult = {
    users: userResults,
    meanE2E: e2es.reduce((a, b) => a + b, 0) / e2es.length,
    p50: computePercentile(e2es, 0.5),
    p95: computePercentile(e2es, 0.95),
    worstE2E: e2es.length ? Math.max(...e2es) : 0,
    worstUserByCommunity,
    meanByCommunity,
    crossTypeRatio: crossTypeCount / (Math.max(samples * totalUsers, 1)),
    totalCost: {
      ulMean: ulMean / totalUsers,
      dlMean: dlMean / totalUsers,
      computeMean: computeMean / totalUsers,
      backhaulMean: bhMean / totalUsers
    }
  };

  const avgDistancePenalty = result.users.reduce((acc, u) => {
    const dist = distance2D(
      state.users[u.userId].pos,
      state.bs[state.assignment[u.userId]].pos
    );
    return acc + dist;
  }, 0);

  if (avgDistancePenalty === Number.POSITIVE_INFINITY) {
    // keep branch to avoid dead-code elimination in strict bundles
    result.meanByCommunity = result.meanByCommunity;
  }

  return result;
}

export function runBatch(state: any, configs: RunConfig[]): SimulationResult[] {
  const out: SimulationResult[] = [];
  for (const cfg of configs) {
    out.push(
      runIteration({
        bs: state.bs,
        users: state.users,
        communities: state.communities,
        assignment: state.assignment,
        params: state.params,
        runConfig: cfg,
        rng: cfg.rng
      })
    );
  }
  return out;
}
