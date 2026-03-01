export function renderMetrics(
  container: HTMLElement,
  result: any | null
): void {
  if (!result) {
    container.innerHTML = '<p>No sample yet. Adjust controls to update metrics.</p>';
    return;
  }

  const components = [
    { name: 'UL', value: result.totalCost.ulMean, color: '#0ea5e9' },
    { name: 'DL', value: result.totalCost.dlMean, color: '#10b981' },
    { name: 'Compute', value: result.totalCost.computeMean, color: '#f59e0b' },
    { name: 'Backhaul', value: result.totalCost.backhaulMean, color: '#a78bfa' }
  ];

  const componentTotal = components.reduce((acc, c) => acc + c.value, 0) || 1;
  const bars = components
    .map((c) => {
      const pct = Math.max(0, Math.min(100, (c.value / componentTotal) * 100));
      return `<div class=\"metric-row\">
        <span>${c.name}</span>
        <div class=\"metric-bar\"><div class=\"metric-fill\" style=\"width:${pct}%;background:${c.color}\"></div></div>
        <strong>${c.value.toFixed(4)} s</strong>
      </div>`;
    })
    .join('');

  const lines: string[] = [];
  lines.push(`<h3 style=\"margin:0 0 6px 0\">Latency Analysis</h3>`);
  lines.push(`<div class=\"metric-title-row\"><span>Mean E2E</span><div class=\"metric-bar\"></div><strong class=\"metric-value\">${result.meanE2E.toFixed(4)} s</strong></div>`);
  lines.push(`<div class=\"metric-title-row\"><span>Worst E2E</span><div class=\"metric-bar\"></div><strong class=\"metric-value\">${result.worstE2E.toFixed(4)} s</strong></div>`);
  lines.push(`<h4 style=\"margin:8px 0 4px 0\">Average components</h4>`);
  lines.push(`<div class=\"metric-chart\">${bars}</div>`);
  lines.push(`<div class=\"metric-line\"><span>Cross-type ratio</span><strong>${(result.crossTypeRatio * 100).toFixed(1)}%</strong></div>`);

  container.innerHTML = lines.join('');
}
