# VR Latency Simulator (Multi-BS 2D)

This is a starter scaffold for simulating E2E latency based on wireless
uplink/downlink + computing + backhaul terms, with support for multiple
base stations, community-level server placement, and WebGPU-compatible rendering.

## Quick start

```bash
cd /Users/jihongpark/Desktop/vr-latency-sim
npm install
npm run dev
```

Then open the Vite URL and use the controls to run Monte Carlo updates.

## Files implemented

- `src/model/*`: radio/backhaul/compute/placement helper functions
- `src/engine/*`: UL/DL optimizers + latency evaluator
- `src/state/simulatorState.ts`: in-memory simulation state
- `src/render/webgpu/renderer.ts`: renderer class (canvas fallback with line-of-sight
  topology links)
- `src/render/ui/*`: controls and metrics panel wiring
- `src/main.ts`: app bootstrap
