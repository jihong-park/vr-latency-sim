import { WebGPURenderer } from './render/webgpu/renderer';
import {
  makeInitialState,
  setServerToBs,
  setServerPos,
  setAssignmentMode,
  setUserCount,
  setVirtualSpaceCount
} from './state/simulatorState';
import { generateBSs } from './model/topology';
import { runIteration } from './engine/runner';
import { renderMetrics } from './render/ui/metricsPanel';
import { wireControls } from './render/ui/controls';
import { stepMobilityRandomWaypoint } from './model/mobility';
import type { SimulationResult } from './types';
import './index.css';

const root = document.getElementById('app') as HTMLDivElement | null;
if (!root) {
  throw new Error('Missing #app root');
}

let state = makeInitialState(1);
(() => {
  const legacyBackhaulScale = (state.params as { backhaulLatencyScale?: number }).backhaulLatencyScale;
  const legacyComputeScale = (state.params as { computeLatencyScale?: number }).computeLatencyScale;

  if (!Number.isFinite(state.params.backhaulLatencySec) || state.params.backhaulLatencySec < 0) {
    const converted = Number.isFinite(legacyBackhaulScale) ? Math.max(0, legacyBackhaulScale ?? 0) * 0.002 : 0.002;
    state.params.backhaulLatencySec = converted;
  }

  if (!Number.isFinite(state.params.computeLatencySec) || state.params.computeLatencySec < 0) {
    const converted = Number.isFinite(legacyComputeScale) ? Math.max(0, legacyComputeScale ?? 0) * 0.001 : 0.001;
    state.params.computeLatencySec = converted;
  }
})();
let result = null as any;
const mobilitySpeedMin = 0;
const mobilitySpeedMax = 50;
const metricsSmoothingWindowSec = 20;
const smoothingEnabled = true;
const simulationUpdateIntervalSec = 1.5;
const seedForBS = (n: number) => (n * 9973 + 12345) >>> 0;
type OptimizationObjective = 'meanE2E' | 'worstE2E';
type OptimizationCacheEntry = {
  signature: number;
  objective: OptimizationObjective;
  state: ReturnType<typeof makeInitialState>;
  result: SimulationResult;
};
let lastMeanOptimizationState: typeof state | null = null;
let lastMeanOptimizationSignature = -1;
let lastMeanOptimizationResult: SimulationResult | null = null;
let optimizationInProgress = false;
let pendingRerunWhileOptimizing = false;
let rerunQueued = false;
const optimizationCache = new Map<string, OptimizationCacheEntry>();

type TimedResult = { t: number; value: SimulationResult };
const smoothedMetricHistory: TimedResult[] = [];

function resetMetricSmoothing(): void {
  smoothedMetricHistory.length = 0;
}

function makeDeterministicRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function nearestBsIndex(
  bs: { pos: { x: number; y: number } }[],
  pos: { x: number; y: number }
): number {
  if (!bs.length) return 0;
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bs.length; i += 1) {
    const b = bs[i].pos;
    const dx = b.x - pos.x;
    const dy = b.y - pos.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestD) {
      bestD = distSq;
      best = i;
    }
  }
  return best;
}

function seedFromSnapshot(stateSnapshot: typeof state): number {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 16777619) >>> 0;
  };

  mix(stateSnapshot.width);
  mix(stateSnapshot.height);
  mix(stateSnapshot.bs.length);
  mix(stateSnapshot.users.length);
  mix(stateSnapshot.communities.length);
  mix(stateSnapshot.assignment.length);
  mix(Math.round(stateSnapshot.mobility.physicalSpeed * 1000));
  mix(Math.round(stateSnapshot.mobility.virtualSpeed * 1000));
  mix(Math.round(stateSnapshot.params.backhaulLatencySec * 1e6));
  mix(Math.round(stateSnapshot.params.computeLatencySec * 1e6));
  mix(Math.round(stateSnapshot.params.backhaulShape * 1e6));
  mix(Math.round(stateSnapshot.params.backhaulScalePerMeter * 1e9));

  stateSnapshot.communities.forEach((comm) => {
    mix(comm.id);
    mix(comm.userIds.length);
    mix(comm.serverMode === 'free2D' ? 1 : 2);
    if (comm.serverMode === 'free2D' && comm.serverPos) {
      mix(Math.round(comm.serverPos.x * 10));
      mix(Math.round(comm.serverPos.y * 10));
    } else {
      mix(comm.serverBsId ?? 0);
    }
  });

  return h;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function averageOverWindow(rawResult: SimulationResult): SimulationResult {
  const now = performance.now() / 1000;
  smoothedMetricHistory.push({ t: now, value: rawResult });

  const cutoff = now - metricsSmoothingWindowSec;
  while (smoothedMetricHistory.length > 0 && smoothedMetricHistory[0].t < cutoff) {
    smoothedMetricHistory.shift();
  }

  const samples = smoothedMetricHistory.length;
  if (samples === 0) {
    return rawResult;
  }

  let meanE2E = 0;
  let p50Input: number[] = [];
  let ulTotal = 0;
  let dlTotal = 0;
  let computeTotal = 0;
  let bhTotal = 0;
  let crossType = 0;
  let worstE2E = 0;
  const worstByCommunity: Map<number, { userId: number; e2e: number }> = new Map();
  const byCommunity = new Map<number, { sum: number; cnt: number }>();

  for (const s of smoothedMetricHistory) {
    const value = s.value;
    meanE2E += value.meanE2E;
    crossType += value.crossTypeRatio;
    ulTotal += value.totalCost.ulMean;
    dlTotal += value.totalCost.dlMean;
    computeTotal += value.totalCost.computeMean;
    bhTotal += value.totalCost.backhaulMean;
    for (const user of value.users) {
      p50Input.push(user.breakdown.e2e);
      const c = user.communityId;
      const prev = worstByCommunity.get(c);
      if (!prev || user.breakdown.e2e > prev.e2e) {
        worstByCommunity.set(c, { userId: user.userId, e2e: user.breakdown.e2e });
      }
    }
    worstE2E = value.worstE2E;

    value.meanByCommunity.forEach((v, k) => {
      const acc = byCommunity.get(k) ?? { sum: 0, cnt: 0 };
      acc.sum += v;
      acc.cnt += 1;
      byCommunity.set(k, acc);
    });
  }

  const meanByCommunity = new Map<number, number>();
  byCommunity.forEach((v, k) => {
    meanByCommunity.set(k, v.sum / Math.max(v.cnt, 1));
  });

  return {
    users: rawResult.users,
    meanE2E: meanE2E / samples,
    p50: percentile(p50Input, 0.5),
    p95: percentile(p50Input, 0.95),
    worstE2E,
    worstUserByCommunity: worstByCommunity,
    meanByCommunity,
    crossTypeRatio: crossType / samples,
    totalCost: {
      ulMean: ulTotal / samples,
      dlMean: dlTotal / samples,
      computeMean: computeTotal / samples,
      backhaulMean: bhTotal / samples
    }
  };
}

const canvas = document.createElement('canvas');
canvas.width = state.width;
canvas.height = state.height;

const side = document.createElement('aside');
side.className = 'sidebar';
side.innerHTML = `
  <div>
    <label>Optimization objective</label>
    <select id="optimizeObjective">
      <option value="meanE2E">Minimize mean E2E</option>
      <option value="worstE2E">Minimize worst-case E2E</option>
    </select>
  </div>
  <button id="optimizeBtn">Optimize</button>
  <label>UE count <span id="userCountValue">${state.users.length}</span></label>
  <input id="userCount" type="range" value="${state.users.length}" min="10" max="250" step="1" />
  <div id="ueCounter">UEs: ${state.users.length} (Space 1: 40, Space 2: 40)</div>
  <label>BS count <input id="bsCount" type="number" value="4" min="1" max="12" /></label>
  <label>Virtual space count <span id="virtualSpaceCountValue">${state.communities.length}</span></label>
  <input id="virtualSpaceCount" type="range" value="${state.communities.length}" min="1" max="8" step="1" />
  <label>Physical UE speed (m/s) <span id="mobilitySpeedPhysicalValue">${Math.round(state.mobility.physicalSpeed)}</span></label>
  <input id="mobilitySpeedPhysical" type="range" value="${Math.round(state.mobility.physicalSpeed)}" min="${mobilitySpeedMin}" max="${mobilitySpeedMax}" step="1" />
  <label>Virtual UE speed (m/s) <span id="mobilitySpeedVirtualValue">${Math.round(state.mobility.virtualSpeed)}</span></label>
  <input id="mobilitySpeedVirtual" type="range" value="${Math.round(state.mobility.virtualSpeed)}" min="${mobilitySpeedMin}" max="${mobilitySpeedMax}" step="1" />
 <label>Virtual interaction
    <select id="virtualInteractionMode">
      <option value="nearestK" ${state.mobility.virtualInteractionMode === 'nearestK' ? 'selected' : ''}>Nearest K</option>
      <option value="radius" ${state.mobility.virtualInteractionMode === 'radius' ? 'selected' : ''}>Radius</option>
      <option value="randomM" ${state.mobility.virtualInteractionMode === 'randomM' ? 'selected' : ''}>Random M</option>
      <option value="all" ${state.mobility.virtualInteractionMode === 'all' ? 'selected' : ''}>All-to-All</option>
    </select>
  </label>
  <label>Virtual K <input id="virtualK" type="number" value="${state.mobility.virtualK}" min="1" max="20" /></label>
  <label>Virtual radius <input id="virtualRadius" type="number" value="${state.mobility.virtualRadius}" min="0.01" max="1" step="0.01" /></label>
  <label>Backhaul latency (s) <span id="backhaulLatencySecValue">${state.params.backhaulLatencySec.toFixed(4)}</span></label>
  <input id="backhaulLatencySec" type="range" value="${state.params.backhaulLatencySec}" min="0" max="1" step="0.001" />
  <label>Server compute latency (s) <span id="computeLatencySecValue">${state.params.computeLatencySec.toFixed(4)}</span></label>
  <input id="computeLatencySec" type="range" value="${state.params.computeLatencySec}" min="0" max="2" step="0.001" />
`;

root.appendChild(side);
root.appendChild(canvas);

const metrics = side.querySelector('#metrics') as HTMLDivElement | null;
const renderer = new WebGPURenderer();
void renderer.init(canvas);
const ueCounter = side.querySelector('#ueCounter') as HTMLDivElement | null;
const userCountSeedBase = 12345;

let draggingServer: number | null = null;
let draggingServerPos: { x: number; y: number } | null = null;
let lastTs = performance.now();
let lastSimulationRunTs = 0;

function updateUeCounter() {
  if (!ueCounter) return;
  const byComm = state.communities.map((c) => `Space ${c.id + 1}: ${c.userIds.length}`);
  ueCounter.textContent = `UEs: ${state.users.length} (${byComm.join(', ')})`;
}

function cloneForEval(nextState: typeof state) {
  return {
    ...nextState,
    bs: nextState.bs,
    users: nextState.users,
    assignment: nextState.assignment.slice(),
    communities: nextState.communities.map((c) => ({
      ...c,
      userIds: c.userIds.slice(),
      serverPos: c.serverPos ? { ...c.serverPos } : undefined
    }))
  };
}

function cloneSimulationResult(result: SimulationResult): SimulationResult {
  return {
    ...result,
    users: result.users.map((u) => ({ ...u, breakdown: { ...u.breakdown } })),
    worstUserByCommunity: new Map(result.worstUserByCommunity),
    meanByCommunity: new Map(result.meanByCommunity)
  };
}

function autoMonteCarloSamples(): number {
  const userScale = Math.max(0, Math.round(state.users.length * 0.35));
  const speedScale = Math.max(
    0,
    (state.mobility.physicalSpeed + state.mobility.virtualSpeed) / (mobilitySpeedMax * 2)
  );
  const speedPenalty = Math.min(0.9, speedScale);
  const base = Math.max(20, Math.min(160, 70 + userScale));
  const adjusted = Math.max(20, Math.min(160, Math.round(base * (1 - 0.5 * speedPenalty))));
  return adjusted;
}

function queueOrRunRerun(): void {
  if (optimizationInProgress) {
    pendingRerunWhileOptimizing = true;
    return;
  }
  if (rerunQueued) {
    return;
  }
  rerunQueued = true;
  requestAnimationFrame(() => {
    rerunQueued = false;
    if (optimizationInProgress) {
      pendingRerunWhileOptimizing = true;
      return;
    }
    rerun();
  });
}

function evaluateObjective(
  stateSnapshot: typeof state,
  objective: OptimizationObjective,
  rngSeed?: number,
  monteCarloSamples?: number
): { result: SimulationResult; score: number } {
  const deterministicRng = typeof rngSeed === 'number' ? makeDeterministicRng(rngSeed) : undefined;
  const originalSamples = stateSnapshot.runConfig.monteCarloSamples;
  const adjustedState = {
    ...stateSnapshot,
    runConfig: {
      ...stateSnapshot.runConfig,
      monteCarloSamples: monteCarloSamples ?? originalSamples
    }
  };
  const result = runIteration({
    bs: adjustedState.bs,
    users: adjustedState.users,
    communities: adjustedState.communities,
    assignment: adjustedState.assignment,
    params: adjustedState.params,
    runConfig: adjustedState.runConfig,
    rng: deterministicRng
  });
  return {
    result,
    score: objective === 'worstE2E' ? result.worstE2E : result.meanE2E
  };
}

async function optimizeServers(objective: OptimizationObjective = 'meanE2E') {
  if (optimizationInProgress) {
    return;
  }
  if (!state.bs.length || !state.users.length) return;
  if (!state.communities.length) return;
  const baselineSignature = seedFromSnapshot(state);
  const isStaticOptimization = state.mobility.physicalSpeed === 0 && state.mobility.virtualSpeed === 0;
  const cacheKey = `${objective}:${baselineSignature}`;
  const cached = optimizationCache.get(cacheKey);
  if (isStaticOptimization && cached && cached.signature === baselineSignature) {
    if (cached.result) {
      state = cloneForEval(cached.state);
      state.bs = cached.state.bs;
      state.users = cached.state.users;
      state.assignment = cached.state.assignment.slice();
      state.params = cached.state.params;
      setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
      const cachedResult = cloneSimulationResult(cached.result);
      resetMetricSmoothing();
      result = smoothingEnabled && metricsSmoothingWindowSec > 0 ? averageOverWindow(cachedResult) : cachedResult;
      if (metrics) {
        renderMetrics(metrics, result);
      }
      updateUeCounter();
    }
    return;
  }
  optimizationInProgress = true;

  const yieldIfNeeded = (lastYieldMs: { value: number }) => {
    const now = performance.now();
    if (now - lastYieldMs.value < 8) {
      return Promise.resolve();
    }
    lastYieldMs.value = now;
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  };

  const communityCount = Math.max(1, state.communities.length);
  const extraSpaces = Math.max(0, communityCount - 2);
  const userScale = Math.max(1, state.users.length / 60);
  const complexityBudget = Math.max(
      20,
      Math.min(
        150,
        Math.floor(110 / Math.sqrt(userScale) - communityCount * 12)
      )
  );
  const maxIterations = objective === 'worstE2E'
    ? Math.max(2, Math.min(6, 5 - Math.max(0, extraSpaces - 1)))
    : Math.max(2, Math.min(4, 4 - Math.max(0, extraSpaces - 1)));
  const iterations = Math.max(1, Math.min(maxIterations, Math.max(1, Math.floor(complexityBudget / (communityCount * 2)))));
  const maxProposalsPerServer = objective === 'worstE2E'
    ? Math.max(3, Math.min(10, 12 - extraSpaces * 2))
    : Math.max(2, Math.min(8, 8 - extraSpaces));
  const proposalsPerServer = Math.max(
    objective === 'worstE2E' ? 2 : 2,
    Math.min(maxProposalsPerServer, Math.max(1, Math.floor(complexityBudget / Math.max(1, iterations * communityCount))))
  );
  const optimizeSamples = objective === 'worstE2E'
    ? Math.max(2, Math.min(6, Math.floor(6 / userScale) + 2 + extraSpaces))
    : Math.max(2, Math.min(5, Math.floor(5 / userScale) + 2 + extraSpaces));
  const objectiveSeed = seedFromSnapshot(state) ^ (objective === 'worstE2E' ? 0xa511 : 0x9e3779b9);
  const optimizationRng = makeDeterministicRng(objectiveSeed);
  const yieldState = { value: performance.now() };

  resetMetricSmoothing();
  const workingState = cloneForEval(state);
  const bsCount = Math.max(1, state.bs.length);
  for (const comm of workingState.communities) {
    const sourcePos = comm.serverMode === 'atBS'
      ? state.bs[comm.serverBsId ?? 0]?.pos
      : comm.serverPos;
    const nearest = sourcePos ? nearestBsIndex(state.bs, sourcePos) : 0;
    comm.serverMode = 'atBS';
    comm.serverBsId = nearest % bsCount;
    comm.serverPos = undefined;
  }

  const randomBs = (base: number) => {
    if (bsCount <= 1) return 0;
    let candidate = Math.floor(optimizationRng() * bsCount);
    if (bsCount === 2) {
      return base === 0 ? 1 : 0;
    }
    while (candidate === base) {
      candidate = Math.floor(optimizationRng() * bsCount);
    }
    return candidate;
  }

  try {
    const isPaperOptimizationCase =
      workingState.bs.length === 2 &&
      workingState.communities.length === 2 &&
      workingState.users.length > 0;

    if (isPaperOptimizationCase) {
      let bestState = cloneForEval(workingState);
      let bestResult = evaluateObjective(bestState, objective, seedFromSnapshot(bestState), optimizeSamples);
      let bestScore = bestResult.score;

      for (const candidateA of [0, 1]) {
        for (const candidateB of [0, 1]) {
          const proposal = cloneForEval(workingState);
          proposal.communities[0].serverMode = 'atBS';
          proposal.communities[0].serverBsId = candidateA % bsCount;
          proposal.communities[0].serverPos = undefined;
          proposal.communities[1].serverMode = 'atBS';
          proposal.communities[1].serverBsId = candidateB % bsCount;
          proposal.communities[1].serverPos = undefined;
          const proposalSeed = seedFromSnapshot(proposal);
          const evalState = evaluateObjective(proposal, objective, proposalSeed, optimizeSamples);
          if (evalState.score < bestScore) {
            bestScore = evalState.score;
            bestState = cloneForEval(proposal);
            bestResult = evalState;
          }
        }
      }

      state.communities = bestState.communities;
      state.bs = bestState.bs;
      state.users = bestState.users;
      state.assignment = bestState.assignment;
      state.params = bestState.params;
      setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
      result = smoothingEnabled && metricsSmoothingWindowSec > 0 ? averageOverWindow(bestResult.result) : bestResult.result;
      if (metrics) {
        renderMetrics(metrics, result);
      }
      optimizationCache.set(cacheKey, {
        signature: baselineSignature,
        objective,
        state: cloneForEval(state),
        result: cloneSimulationResult(bestResult.result)
      });
      if (objective === 'meanE2E') {
        lastMeanOptimizationState = cloneForEval(state);
        lastMeanOptimizationSignature = seedFromSnapshot(state);
        lastMeanOptimizationResult = bestResult.result;
      }
      updateUeCounter();
      return;
    }

    const baseline = evaluateObjective(workingState, objective, seedFromSnapshot(workingState), optimizeSamples);
    let bestScore = baseline.score;
    let bestState = cloneForEval(workingState);
    let bestResult = baseline.result;
    let workingScore = baseline.score;

    let meanBaselineState: typeof state | null = null;
    let meanBaselineResult: SimulationResult | null = null;
    if (objective === 'worstE2E') {
      if (lastMeanOptimizationState && lastMeanOptimizationSignature === baselineSignature) {
        meanBaselineState = cloneForEval(lastMeanOptimizationState);
        meanBaselineResult = lastMeanOptimizationResult;
      } else {
        const meanBaseline = evaluateObjective(cloneForEval(workingState), 'meanE2E', seedFromSnapshot(workingState), optimizeSamples);
        meanBaselineState = cloneForEval(workingState);
        meanBaselineResult = meanBaseline.result;
      }
    }

    for (let iter = 0; iter < iterations; iter += 1) {
      let improved = false;
      const exhaustiveWorstCandidates = objective === 'worstE2E' && communityCount <= 4 && bsCount <= 12;

      for (const comm of workingState.communities) {
        const baseBs = comm.serverBsId ?? 0;
        let bestLocalBs = baseBs;
        let bestLocalScore = workingScore;
        let bestLocalResult = bestResult;
        const proposals = exhaustiveWorstCandidates ? bsCount : proposalsPerServer;

        for (let p = 0; p < proposals; p += 1) {
          const candidate = exhaustiveWorstCandidates
            ? p
            : randomBs(baseBs);
          if (candidate === baseBs && objective === 'worstE2E' && !exhaustiveWorstCandidates && p > 0) {
            // keep at least one non-trivial proposal path in random mode
            continue;
          }

          const proposal = cloneForEval(workingState);
          proposal.communities[comm.id].serverMode = 'atBS';
          proposal.communities[comm.id].serverBsId = candidate;
          proposal.communities[comm.id].serverPos = undefined;
          const proposalSeed = seedFromSnapshot(proposal) + p + iter * 97 + comm.id * 13;
          const evalState = evaluateObjective(proposal, objective, proposalSeed, optimizeSamples);
          if (evalState.score < bestLocalScore) {
            bestLocalScore = evalState.score;
            bestLocalBs = candidate;
            bestLocalResult = evalState.result;
          }

          await yieldIfNeeded(yieldState);
        }

        if (bestLocalScore < bestScore) {
          workingState.communities[comm.id].serverMode = 'atBS';
          workingState.communities[comm.id].serverBsId = bestLocalBs;
          workingState.communities[comm.id].serverPos = undefined;
          bestScore = bestLocalScore;
          workingScore = bestLocalScore;
          bestState = cloneForEval(workingState);
          bestResult = bestLocalResult;
          improved = true;
        }

        await yieldIfNeeded(yieldState);
      }

      if (!improved) {
        break;
      }
      await yieldIfNeeded(yieldState);
    }

    let finalState = bestState;
    let finalResult = bestResult;

    if (
      objective === 'worstE2E' &&
      meanBaselineResult &&
      meanBaselineState &&
      meanBaselineResult.worstE2E < finalResult.worstE2E
    ) {
      finalState = cloneForEval(meanBaselineState);
      finalResult = meanBaselineResult;
    }

    state.communities = finalState.communities;
    state.bs = finalState.bs;
    state.users = finalState.users;
    state.assignment = finalState.assignment;
    state.params = finalState.params;
    setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
    result = smoothingEnabled && metricsSmoothingWindowSec > 0 ? averageOverWindow(finalResult) : finalResult;
    if (metrics) {
      renderMetrics(metrics, result);
    }
    optimizationCache.set(cacheKey, {
      signature: baselineSignature,
      objective,
      state: cloneForEval(state),
      result: cloneSimulationResult(finalResult)
    });

    if (objective === 'meanE2E') {
      lastMeanOptimizationState = cloneForEval(state);
      lastMeanOptimizationSignature = seedFromSnapshot(state);
      lastMeanOptimizationResult = finalResult;
    }
    updateUeCounter();
  } finally {
    optimizationInProgress = false;
    if (pendingRerunWhileOptimizing) {
      pendingRerunWhileOptimizing = false;
      queueOrRunRerun();
    }
  }
}

function rerun() {
  if (optimizationInProgress) {
    pendingRerunWhileOptimizing = true;
    return;
  }
  state.runConfig.monteCarloSamples = autoMonteCarloSamples();
  const current = runIteration({
    bs: state.bs,
    users: state.users,
    communities: state.communities,
    assignment: state.assignment,
    params: state.params,
    runConfig: state.runConfig,
    rng: makeDeterministicRng(seedFromSnapshot(state))
  });

  result = smoothingEnabled && metricsSmoothingWindowSec > 0 ? averageOverWindow(current) : current;
  if (metrics) {
    renderMetrics(metrics, result);
  }
  updateUeCounter();
}

function tick(ts: number) {
  const dtSec = (ts - lastTs) / 1000;
  lastTs = ts;

    const shouldAnimateMobility = state.mobility.enabled && dtSec > 0;
    if (shouldAnimateMobility) {
      const communityCount = Math.max(1, state.communities.length || 1);
      const communities = Array.from({ length: communityCount }, (_, i) => i);
      const virtualSpeedFactor = Math.max(state.width, state.height) > 0 ? 6 / Math.max(state.width, state.height) : 1;
      stepMobilityRandomWaypoint({
        users: state.users,
        communities,
        state: state.mobility,
        dtSec,
        physicalW: state.width,
        physicalH: state.height,
        virtualSpeedFactor
      });

    setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
    const nowSec = ts / 1000;
    if ((state.mobility.physicalSpeed > 0 || state.mobility.virtualSpeed > 0) && (nowSec - lastSimulationRunTs / 1000) >= simulationUpdateIntervalSec) {
      queueOrRunRerun();
      lastSimulationRunTs = ts;
    }
  }

  renderer.render(state, result);
  requestAnimationFrame(tick);
}

canvas.addEventListener('pointermove', (evt) => {
  const rect = canvas.getBoundingClientRect();
  const hit = renderer.pickAt(evt.clientX - rect.left, evt.clientY - rect.top);
  renderer.setHoveredUser(hit?.kind === 'user' ? hit.id : null);

  if (draggingServer !== null) {
      const p = renderer.screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
      if (p) {
        draggingServerPos = p;
        renderer.setDraggingServerWorldPos(draggingServerPos);
      }
    }
});

canvas.addEventListener('pointerdown', (evt) => {
  const rect = canvas.getBoundingClientRect();
  const hit = renderer.pickAt(evt.clientX - rect.left, evt.clientY - rect.top);
  if (hit?.kind === 'server') {
    draggingServer = hit.id;
    const p = renderer.screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
    draggingServerPos = p ?? null;
    renderer.setDraggingServerWorldPos(draggingServerPos);
    renderer.setDraggingServer(draggingServer);
    if (p) {
      (evt.target as Element).setPointerCapture(evt.pointerId);
    }
  }
});

canvas.addEventListener('pointerup', () => {
  if (draggingServer !== null && draggingServerPos) {
    resetMetricSmoothing();
  }
  if (draggingServer !== null && draggingServerPos) {
    setServerPos(state, draggingServer, draggingServerPos);
  }
  draggingServer = null;
  renderer.setDraggingServer(null);
  renderer.setDraggingServerWorldPos(null);
  draggingServerPos = null;
  queueOrRunRerun();
});

canvas.addEventListener('pointerleave', () => {
  renderer.setHoveredUser(null);
});

canvas.addEventListener('pointercancel', () => {
  if (draggingServer !== null && draggingServerPos) {
    resetMetricSmoothing();
  }
  if (draggingServer !== null && draggingServerPos) {
    setServerPos(state, draggingServer, draggingServerPos);
  }
  draggingServer = null;
  renderer.setDraggingServer(null);
  renderer.setDraggingServerWorldPos(null);
  draggingServerPos = null;
});

wireControls(state, (_nextState, action) => {

  if (action?.type === 'bsCount') {
    resetMetricSmoothing();
    const count = Math.max(1, Math.round(action.value ?? state.runConfig?.bsCount ?? state.bs.length));
    state.bs = generateBSs(count, state.width, state.height, seedForBS(count));

    for (const c of state.communities) {
      if (c.serverMode === 'atBS') {
        const current = c.serverBsId ?? 0;
        c.serverBsId = ((current % state.bs.length) + state.bs.length) % state.bs.length;
      }
    }

    setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
    queueOrRunRerun();
  }

  if (action?.type === 'userCount') {
    const userCount = Math.max(10, Math.round(action.value ?? state.users.length));
    resetMetricSmoothing();
    setUserCount(state, userCount, userCountSeedBase + userCount);
    queueOrRunRerun();
  }

  if (action?.type === 'virtualSpaceCount') {
    const nextCount = Math.max(1, Math.round(action.value ?? state.communities.length));
    if (nextCount !== state.communities.length) {
      resetMetricSmoothing();
      setVirtualSpaceCount(state, nextCount);
      const sliderValue = side.querySelector('#virtualSpaceCountValue');
      if (sliderValue) {
        sliderValue.textContent = String(nextCount);
      }
      queueOrRunRerun();
    }
  }

  if (action?.type === 'mobilitySpeedPhysical') {
    const maxSpeed = mobilitySpeedMax;
    const minSpeed = mobilitySpeedMin;
    resetMetricSmoothing();
    state.mobility.physicalSpeed = Math.min(maxSpeed, Math.max(minSpeed, action.value ?? minSpeed));
    queueOrRunRerun();
  }

  if (action?.type === 'mobilitySpeedVirtual') {
    const maxSpeed = mobilitySpeedMax;
    const minSpeed = mobilitySpeedMin;
    resetMetricSmoothing();
    state.mobility.virtualSpeed = Math.min(maxSpeed, Math.max(minSpeed, action.value ?? minSpeed));
    queueOrRunRerun();
  }

  if (action?.type === 'virtualInteractionMode') {
    const next = action.value;
    if (next === 'nearestK' || next === 'radius' || next === 'randomM' || next === 'all') {
      resetMetricSmoothing();
      state.mobility.virtualInteractionMode = next;
      queueOrRunRerun();
    }
  }

  if (action?.type === 'virtualK') {
    if (Number.isFinite(action.value) && action.value >= 1) {
      resetMetricSmoothing();
      state.mobility.virtualK = Math.max(1, Math.round(action.value));
      queueOrRunRerun();
    }
  }

  if (action?.type === 'virtualRadius') {
    if (Number.isFinite(action.value) && action.value >= 0) {
      resetMetricSmoothing();
      state.mobility.virtualRadius = Math.min(1, Math.max(0, action.value));
      queueOrRunRerun();
    }
  }

  if (action?.type === 'backhaulLatencySec' || action?.type === 'backhaulLatencyScale') {
    if (Number.isFinite(action.value)) {
      const normalized = Math.max(0, action.value);
      resetMetricSmoothing();
      state.params.backhaulLatencySec = normalized;
      queueOrRunRerun();
    }
  }

  if (action?.type === 'computeLatencySec' || action?.type === 'computeLatencyScale') {
    if (Number.isFinite(action.value)) {
      const normalized = Math.max(0, action.value);
      resetMetricSmoothing();
      state.params.computeLatencySec = normalized;
      queueOrRunRerun();
    }
  }

  if (action?.type === 'optimize') {
    const objective = action.value === 'worstE2E' ? 'worstE2E' : 'meanE2E';
    void optimizeServers(objective);
    return;
  }

  if (!action) {
    resetMetricSmoothing();
    queueOrRunRerun();
  }
});

state.communities.forEach((_, i) => {
  setServerToBs(state, i, i % state.bs.length);
  setAssignmentMode(state, state.params.assignmentMode ?? 'nearest');
});
updateUeCounter();

for (let i = 0; i < state.communities.length; i += 1) {
  if (!state.bs.length) {
    break;
  }
  setServerToBs(state, i, i % state.bs.length);
}
queueOrRunRerun();
if (metrics) {
  renderMetrics(metrics, result);
}
requestAnimationFrame((t) => {
  lastTs = t;
  lastSimulationRunTs = t;
  requestAnimationFrame(tick);
});

window.addEventListener('resize', () => {
  const rect = root.getBoundingClientRect();
  canvas.width = rect.width - 250;
  renderer.resize(rect.width - 250, rect.height);
});
