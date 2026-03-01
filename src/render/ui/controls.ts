export function wireControls(
  _state: any,
  onStateChange: (state: any, action?: { type: string; value?: any }) => void
): () => void {
  const get = (id: string, fallbackId?: string): HTMLInputElement | HTMLSpanElement | null => {
    const byPrimary = document.getElementById(id);
    if (byPrimary) return byPrimary as any;
    if (fallbackId) {
      const byFallback = document.getElementById(fallbackId);
      if (byFallback) return byFallback as any;
    }
    return null;
  };

  const bsCount = document.getElementById('bsCount') as HTMLInputElement | null;
  const mobilitySpeedPhysical = document.getElementById('mobilitySpeedPhysical') as HTMLInputElement | null;
  const mobilitySpeedPhysicalValue = document.getElementById('mobilitySpeedPhysicalValue') as HTMLSpanElement | null;
  const mobilitySpeedVirtual = document.getElementById('mobilitySpeedVirtual') as HTMLInputElement | null;
  const mobilitySpeedVirtualValue = document.getElementById('mobilitySpeedVirtualValue') as HTMLSpanElement | null;
  const userCount = document.getElementById('userCount') as HTMLInputElement | null;
  const userCountValue = document.getElementById('userCountValue') as HTMLSpanElement | null;
  const virtualSpaceCount = document.getElementById('virtualSpaceCount') as HTMLInputElement | null;
  const virtualSpaceCountValue = document.getElementById('virtualSpaceCountValue') as HTMLSpanElement | null;
  const virtualInteractionMode = document.getElementById('virtualInteractionMode') as HTMLSelectElement | null;
  const virtualK = document.getElementById('virtualK') as HTMLInputElement | null;
  const virtualRadius = document.getElementById('virtualRadius') as HTMLInputElement | null;
  const backhaulLatencySec = get('backhaulLatencySec', 'backhaulLatencyScale') as HTMLInputElement | null;
  const backhaulLatencySecValue = get('backhaulLatencySecValue', 'backhaulLatencyScaleValue') as HTMLSpanElement | null;
  const computeLatencySec = get('computeLatencySec', 'computeLatencyScale') as HTMLInputElement | null;
  const computeLatencySecValue = get('computeLatencySecValue', 'computeLatencyScaleValue') as HTMLSpanElement | null;
  const optimizeBtn = document.getElementById('optimizeBtn') as HTMLButtonElement | null;
  const optimizeObjective = document.getElementById('optimizeObjective') as HTMLSelectElement | null;

  const cleanup: Array<() => void> = [];

  if (bsCount) {
    const cb = () => {
      const v = Number(bsCount.value);
      if (Number.isFinite(v) && v >= 1) {
        onStateChange({ ..._state, bsCount: Math.max(1, Math.round(v)) }, { type: 'bsCount', value: Math.max(1, Math.round(v)) });
      }
    };
    bsCount.addEventListener('change', cb);
    cleanup.push(() => bsCount.removeEventListener('change', cb));
  }

  const decimalsFromStep = (step: number): number => {
    const s = String(step);
    const dot = s.indexOf('.');
    if (dot < 0) return 0;
    return Math.max(0, s.length - dot - 1);
  };

  const wireRange = (input: HTMLInputElement | null, valueEl: HTMLSpanElement | null, type: string, fixed = 0) => {
    if (!input || !valueEl) return;
    const speedMin = Number(input.min);
    const speedMax = Number(input.max);
    const speedStep = Number(input.step) || 1;
    const decimals = Number.isFinite(speedStep) ? decimalsFromStep(speedStep) : fixed;
    const formatValue = (value: number): string => {
      const shown = Number.isFinite(speedStep)
        ? Number((Math.round(value / speedStep) * speedStep).toFixed(decimals))
        : value;
      return shown.toFixed(Math.max(0, decimals)).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    };
    const cb = () => {
      const v = Number(input.value);
      const clamped = Math.min(speedMax, Math.max(speedMin, v));
      if (Number.isFinite(clamped)) {
        input.value = String(Number(clamped.toFixed(decimals)));
        valueEl.textContent = formatValue(clamped);
        onStateChange({ ..._state, [type]: clamped }, { type, value: clamped });
      }
    };
    input.addEventListener('input', cb);
    input.addEventListener('change', cb);
    cleanup.push(() => input.removeEventListener('input', cb));
    cleanup.push(() => input.removeEventListener('change', cb));
  };

  wireRange(mobilitySpeedPhysical, mobilitySpeedPhysicalValue, 'mobilitySpeedPhysical');
  wireRange(mobilitySpeedVirtual, mobilitySpeedVirtualValue, 'mobilitySpeedVirtual');
  wireRange(backhaulLatencySec, backhaulLatencySecValue, 'backhaulLatencySec', 4);
  wireRange(computeLatencySec, computeLatencySecValue, 'computeLatencySec', 4);
  if (userCount && userCountValue) {
    const cb = () => {
      const v = Number(userCount.value);
      if (Number.isFinite(v)) {
        const rounded = Math.max(1, Math.round(v));
        userCount.value = String(rounded);
        userCountValue.textContent = String(rounded);
        onStateChange({ ..._state, userCount: rounded }, { type: 'userCount', value: rounded });
      }
    };
    userCount.addEventListener('input', cb);
    cleanup.push(() => userCount.removeEventListener('input', cb));
  }

  if (virtualSpaceCount && virtualSpaceCountValue) {
    const cb = () => {
      const v = Number(virtualSpaceCount.value);
      if (Number.isFinite(v)) {
        const rounded = Math.max(1, Math.round(v));
        virtualSpaceCount.value = String(rounded);
        virtualSpaceCountValue.textContent = String(rounded);
        onStateChange(
          { ..._state, virtualSpaceCount: rounded },
          { type: 'virtualSpaceCount', value: rounded }
        );
      }
    };
    virtualSpaceCount.addEventListener('input', cb);
    cleanup.push(() => virtualSpaceCount.removeEventListener('input', cb));
  }

  if (virtualInteractionMode) {
    const cb = () => {
      onStateChange({ ..._state, virtualInteractionMode: virtualInteractionMode.value }, { type: 'virtualInteractionMode', value: virtualInteractionMode.value });
    };
    virtualInteractionMode.addEventListener('change', cb);
    cleanup.push(() => virtualInteractionMode.removeEventListener('change', cb));
  }

  if (virtualK) {
    const cb = () => {
      const v = Number(virtualK.value);
      if (Number.isFinite(v)) {
        onStateChange({ ..._state, virtualK: Math.max(1, Math.round(v)) }, { type: 'virtualK', value: Math.max(1, Math.round(v)) });
      }
    };
    virtualK.addEventListener('change', cb);
    cleanup.push(() => virtualK.removeEventListener('change', cb));
  }

  if (virtualRadius) {
    const cb = () => {
      const v = Number(virtualRadius.value);
      if (Number.isFinite(v)) {
        onStateChange({ ..._state, virtualRadius: v }, { type: 'virtualRadius', value: v });
      }
    };
    virtualRadius.addEventListener('change', cb);
    cleanup.push(() => virtualRadius.removeEventListener('change', cb));
  }

  if (optimizeBtn) {
    const cb = () => {
      const objective = optimizeObjective?.value === 'worstE2E' ? 'worstE2E' : 'meanE2E';
      onStateChange(_state, { type: 'optimize', value: objective });
    };
    optimizeBtn.addEventListener('click', cb);
    cleanup.push(() => optimizeBtn.removeEventListener('click', cb));
  }

  return () => {
    cleanup.forEach(fn => fn());
  };
}
