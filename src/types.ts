export type Vec2 = { x: number; y: number };

export type BS = {
  id: number;
  pos: Vec2;
};

export type User = {
  id: number;
  pos: Vec2;
  communityId: number;
};

export type Community = {
  id: number;
  userIds: number[];
  serverMode: 'atBS' | 'free2D';
  serverBsId?: number;
  serverPos?: Vec2;
};

export type Params = {
  totalBandwidthHz: number;
  txPowerW: number;
  noisePSD: number;
  alpha: number;
  dMin: number;
  targetOutage: number;
  packetBytes: number;
  cyclesPerPacket: number;
  cpuCyclesPerSec: number;
  backhaulShape: number;
  backhaulScalePerMeter: number;
  backhaulLatencySec: number;
  computeLatencySec: number;
  slotTime: number;
  assignmentMode?: 'nearest' | 'fixed' | 'greedyDl' | 'optAssociation';
};

export type LinkSample = {
  sinrLin: number;
  rateBps: number;
};

export type RunConfig = {
  monteCarloSamples: number;
  optimizeAssociation: boolean;
  optimizeServer: boolean;
  rng?: () => number;
};

export type MobilityRuntime = {
  enabled: boolean;
  physicalSpeed: number;
  virtualSpeed: number;
  virtualInteractionMode: 'nearestK' | 'radius' | 'randomM' | 'all';
  virtualK: number;
  virtualRadius: number;
  pauseMinSec: number;
  pauseMaxSec: number;
  physicalTargets: Vec2[];
  physicalPauseSec: number[];
  virtualTargets: Vec2[];
  virtualPauseSec: number[];
  userVirtualPos: Vec2[];
};

export type Allocation = {
  ul: number[];
  dl: Map<string, number>;
};

export type LatencyBreakdown = {
  ul: number;
  dl: number;
  compute: number;
  backhaul: number;
  e2e: number;
};

export type UserLatency = {
  userId: number;
  communityId: number;
  assignedBsId: number;
  breakdown: LatencyBreakdown;
};

export type SimulationResult = {
  users: UserLatency[];
  meanE2E: number;
  p50: number;
  p95: number;
  worstE2E: number;
  worstUserByCommunity: Map<number, { userId: number; e2e: number }>;
  meanByCommunity: Map<number, number>;
  crossTypeRatio: number;
  totalCost: {
    ulMean: number;
    dlMean: number;
    computeMean: number;
    backhaulMean: number;
  };
};
