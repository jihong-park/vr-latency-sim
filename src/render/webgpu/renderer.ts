import type { SimState, SimulationResult } from '../../types';

type Pickable = { id: number; x: number; y: number; r: number; kind: 'user' | 'server' | 'bs' };

export class WebGPURenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private width = 0;
  private height = 0;
  private animPhase = 0;
  private hoveredUserId: number | null = null;
  private draggingServerId: number | null = null;
  private draggingServerWorldPos: { x: number; y: number } | null = null;
  private readonly draggingServerAnim = new Map<number, number>();
  private pickableUsers: Pickable[] = [];
  private pickableServers: Pickable[] = [];
  private readonly palette = ['#2f80ed', '#27ae60', '#f5a623', '#eb5757'];

  private virtualPanelY0 = 8;
  private virtualH = 0;
  private physicalY0 = 0;
  private physicalH = 0;
  private lastState: SimState | null = null;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.clientWidth;
    this.height = canvas.clientHeight;
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private toPhysical(x: number, y: number, state: SimState) {
    const physicalY0 = this.physicalY0;
    const physicalH = this.physicalH;
    const physicalXScale = this.width / state.width;
    const physicalYScale = physicalH / state.height;

    const nx = x / state.width;
    const ny = y / state.height;
    const baseX = x * physicalXScale;
    const baseY = y * physicalYScale + physicalY0;
    const cx = this.width * 0.5;
    const widthScale = 0.62 + 0.38 * ny;
    const yCompress = 0.58 + 0.42 * ny;

    return {
      x: cx + (baseX - cx) * widthScale + this.width * 0.1 * ny,
      y: physicalY0 + (baseY - physicalY0) * yCompress,
      depth: ny
    };
  }

  private physicalToWorld(x: number, y: number, state: SimState): { x: number; y: number } | null {
    const physicalY0 = this.physicalY0;
    const physicalH = this.physicalH;
    if (y < physicalY0 || y > physicalY0 + physicalH) {
      return null;
    }

    const t = (y - physicalY0) / Math.max(physicalH, 1);
    const disc = 0.58 * 0.58 + 1.68 * t;
    const ny = Math.max(0, Math.min(1, (-0.58 + Math.sqrt(Math.max(0, disc))) / 0.84));

    const cx = this.width * 0.5;
    const widthScale = 0.62 + 0.38 * ny;
    const baseX = ( (x - cx) / Math.max(widthScale, 1e-6) - this.width * 0.1 * ny ) / this.width + cx / this.width;
    const wx = baseX * state.width;

    return {
      x: Math.max(0, Math.min(state.width, wx)),
      y: Math.max(0, Math.min(state.height, ny * state.height))
    };
  }

  render(state: SimState, result: SimulationResult | null): void {
    if (!this.ctx) return;

    this.animPhase += 0.05;
    this.pickableUsers = [];
    this.pickableServers = [];
    this.lastState = state;

    const c = this.ctx;
    c.clearRect(0, 0, this.width, this.height);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, this.width, this.height);

    const drawPanel = (x: number, y: number, w: number, h: number, title: string) => {
      c.save();
      c.fillStyle = '#fbfdff';
      c.strokeStyle = '#dbe7f8';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(x + 10, y);
      c.arcTo(x + w, y, x + w, y + h, 10);
      c.arcTo(x + w, y + h, x, y + h, 10);
      c.arcTo(x, y + h, x, y, 10);
      c.arcTo(x, y, x + w, y, 10);
      c.closePath();
      c.fill();
      c.stroke();
      c.fillStyle = '#0f172a';
      c.font = '700 12px Inter, sans-serif';
      c.fillText(title, x + 10, y + 22);
      c.restore();
    };

    const drawRounded = (x: number, y: number, w: number, h: number, radius: number) => {
      c.beginPath();
      c.moveTo(x + radius, y);
      c.arcTo(x + w, y, x + w, y + h, radius);
      c.arcTo(x + w, y + h, x, y + h, radius);
      c.arcTo(x, y + h, x, y, radius);
      c.arcTo(x, y, x + w, y, radius);
      c.closePath();
    };

    const metricsPanelHeight = 132;
    this.virtualPanelY0 = 4 + metricsPanelHeight + 4;
    const virtualH = Math.max(130, this.height * 0.25);
    this.virtualH = virtualH;
    this.physicalY0 = this.virtualPanelY0 + virtualH + 14;
    this.physicalH = Math.max(166, this.height - this.physicalY0 - 12);
    const virtualTitleY = this.virtualPanelY0 + 20;
    const virtualSpaceTop = this.virtualPanelY0 + 44;
    const virtualSpaceHeight = Math.max(70, virtualH - 72);
    const virtualAreaTop = virtualSpaceTop + 10;
    const virtualAreaHeight = Math.max(28, virtualSpaceHeight - 18);
    const physicalTitleY = this.physicalY0 + 20;
    const clampVirtualY = (v: number) => Math.max(virtualSpaceTop, Math.min(virtualSpaceTop + virtualSpaceHeight, v));
    const metricLeft = 14;
    const metricRight = this.width - 12;
    const metricTrackW = Math.max(130, metricRight - metricLeft - 130);
    const trackColor = '#dce7fb';
    const metricLineColor = '#0f172a';
    const physicalPanelMargin = 12;
    const physicalPanelBounds = {
      x: physicalPanelMargin,
      y: physicalTitleY + 12,
      w: this.width - physicalPanelMargin * 2,
      h: Math.max(128, this.physicalH - 44)
    };
    const virtualPanelBounds = {
      x: physicalPanelMargin,
      y: virtualAreaTop,
      w: this.width - physicalPanelMargin * 2,
      h: virtualAreaHeight
    };
    const clampInBounds = (x: number, y: number, w: number, h: number, bounds: { x: number; y: number; w: number; h: number }) => ({
      x: Math.max(bounds.x, Math.min(bounds.x + bounds.w - w, x)),
      y: Math.max(bounds.y, Math.min(bounds.y + bounds.h - h, y))
    });
    const clampPointInBounds = (
      x: number,
      y: number,
      bounds: { x: number; y: number; w: number; h: number },
      radius = 0
    ) => ({
      x: Math.max(bounds.x + radius, Math.min(bounds.x + bounds.w - radius, x)),
      y: Math.max(bounds.y + radius, Math.min(bounds.y + bounds.h - radius, y))
    });
    const occupiedRectangles: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const textHeight = 10;
    const activeCommunityIds = new Set(state.communities.map((comm) => comm.id));
    for (const id of Array.from(this.draggingServerAnim.keys())) {
      if (!activeCommunityIds.has(id)) {
        this.draggingServerAnim.delete(id);
      }
    }
    const textFits = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      bounds: { x: number; y: number; w: number; h: number }
    ) => {
      if (x0 < bounds.x || y0 < bounds.y || x1 > bounds.x + bounds.w || y1 > bounds.y + bounds.h) return false;
      for (const prev of occupiedRectangles) {
        if (!(x1 <= prev.x0 || x0 >= prev.x1 || y1 <= prev.y0 || y0 >= prev.y1)) {
          return false;
        }
      }
      return true;
    };
    const placeLabel = (
      txt: string,
      x: number,
      y: number,
      color: string,
      font: string,
      bounds: { x: number; y: number; w: number; h: number },
      strokeColor?: string,
      strokeWidth = 0
    ) => {
      const offsets = [
        { dx: 0, dy: 0 },
        { dx: 10, dy: -10 },
        { dx: 10, dy: 10 },
        { dx: -24, dy: -10 },
        { dx: -24, dy: 10 },
        { dx: 0, dy: -16 },
        { dx: 0, dy: 16 }
      ];

      c.font = font;
      const tw = c.measureText(txt).width;
      const th = textHeight;
      for (const o of offsets) {
        const px = x + o.dx;
        const py = y + o.dy;
        const x0 = px;
        const y0 = py - th;
        const x1 = px + tw;
        const y1 = py;
        const clamped = clampInBounds(px, py, tw, th, bounds);
        const ccx0 = clamped.x;
        const ccy0 = clamped.y - th;
        const ccx1 = clamped.x + tw;
        const ccy1 = clamped.y;
        if (textFits(ccx0, ccy0, ccx1, ccy1, bounds)) {
          c.fillStyle = color;
          c.fillText(txt, clamped.x, clamped.y);
          if (strokeColor && strokeWidth > 0) {
            c.strokeStyle = strokeColor;
            c.lineWidth = strokeWidth;
            c.strokeText(txt, clamped.x, clamped.y);
          }
          occupiedRectangles.push({ x0: ccx0 - 1, y0: ccy0 - 1, x1: ccx1 + 1, y1: ccy1 + 1 });
          return true;
        }
      }
      return false;
    };

    drawPanel(8, 8, this.width - 16, metricsPanelHeight - 2, 'Latency analysis');
    if (result) {
      c.fillStyle = metricLineColor;
      c.font = '11px Inter, sans-serif';
      c.fillText(`Mean E2E: ${result.meanE2E.toFixed(4)} s`, metricLeft + 4, 42);
      c.fillText(`Worst: ${result.worstE2E.toFixed(4)} s`, metricLeft + 180, 42);
      c.fillText(`Cross-type ratio: ${(result.crossTypeRatio * 100).toFixed(1)}%`, metricLeft + 4, 60);

      const avgComponents = [
        { name: 'UL', value: result.totalCost.ulMean, color: '#2f80ed' },
        { name: 'DL', value: result.totalCost.dlMean, color: '#27ae60' },
        { name: 'Compute', value: result.totalCost.computeMean, color: '#f5a623' },
        { name: 'Backhaul', value: result.totalCost.backhaulMean, color: '#9b51e0' }
      ];
      const componentMax = Math.max(1e-9, ...avgComponents.map((x) => x.value));
      const metricValueBaseX = metricLeft + 48 + metricTrackW;

      const rowY0 = 76;
      avgComponents.forEach((comp, idx) => {
        const y = rowY0 + idx * 13;
        c.fillStyle = metricLineColor;
        c.fillText(`${comp.name}`, metricLeft, y);
        c.fillStyle = trackColor;
        drawRounded(metricLeft + 46, y - 7, metricTrackW, 6, 3);
        c.fill();
        c.fillStyle = comp.color;
        drawRounded(metricLeft + 46, y - 7, Math.max(1, (comp.value / componentMax) * metricTrackW), 6, 3);
        c.fill();
        const valText = `${comp.value.toFixed(4)} s`;
        const valWidth = c.measureText(valText).width;
        const valX = Math.max(metricLeft + 56, Math.min(metricValueBaseX + 4, metricRight - 8 - valWidth));
        c.fillText(valText, valX, y);
      });
    }

    const drawCircle = (x: number, y: number, r: number, color: string) => {
      c.fillStyle = color;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    };

    const drawText = (txt: string, x: number, y: number, color = '#334155') => {
      c.fillStyle = color;
      c.fillText(txt, x, y);
    };

    const virtualSpaceCount = Math.max(1, state.communities.length || 1);
    const virtualSpaceMap = new Map<number, number>();
    for (let i = 0; i < state.communities.length && i < virtualSpaceCount; i += 1) {
      virtualSpaceMap.set(state.communities[i].id, i);
    }

    const spacePad = 14;
    const interSpace = 10;
    const spaceW = (this.width - spacePad * 2 - interSpace * (virtualSpaceCount - 1)) / virtualSpaceCount;
    const mapToSpace = (communityId: number) =>
      Math.max(0, Math.min(virtualSpaceCount - 1, virtualSpaceMap.get(communityId) ?? communityId % virtualSpaceCount));

    const toVirtualSpace = (x: number, y: number, space: number) => {
      const sx0 = spacePad + space * (spaceW + interSpace);
      const localW = Math.max(20, spaceW - 18);
      const localH = virtualAreaHeight;
      const nx = Math.max(0, Math.min(1, x));
      const ny = Math.max(0, Math.min(1, y));
      const floatX = nx * localW + sx0 + 10;
      const floatY = virtualAreaTop + ny * localH;
      return { x: floatX, y: floatY, space };
    };

    const palette = this.palette;
    const communityColor = (id: number) => palette[Math.max(0, id) % palette.length];

    // Separation and panels
    c.strokeStyle = '#dbe7f8';
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(0, this.physicalY0);
    c.lineTo(this.width, this.physicalY0);
    c.stroke();

    drawPanel(8, this.virtualPanelY0 + 8, this.width - 16, virtualH - 16, 'Virtual spaces (intra-space UE interactions only)');
    drawPanel(8, this.physicalY0 + 2, this.width - 16, this.physicalH - 4, 'Physical BS-UE topology');
    c.fillStyle = '#334155';
    c.font = '13px Inter, sans-serif';

    for (let s = 0; s < virtualSpaceCount; s += 1) {
      const sx = spacePad + s * (spaceW + interSpace);
      c.fillStyle = 'rgba(237, 244, 255, 0.65)';
      c.strokeStyle = '#dbe7f8';
      drawRounded(sx + 2, virtualSpaceTop, spaceW - 4, virtualSpaceHeight, 8);
      c.fill();
      c.stroke();
      c.fillStyle = '#334155';
      placeLabel(`Virtual Space ${s + 1}`, sx + 10, virtualTitleY + 14, '#334155', '12px Inter, sans-serif', {
        x: sx + 2,
        y: virtualSpaceTop,
        w: spaceW - 4,
        h: 22
      });
    }

    const physicalMotionScale = Math.min(1, Math.max(0, state.mobility.physicalSpeed / 120));
    const virtualMotionScale = Math.min(1, Math.max(0, state.mobility.virtualSpeed / 120));
    const drift = Math.sin(this.animPhase) * 0.6 * physicalMotionScale;

    c.save();
    c.beginPath();
    c.rect(physicalPanelBounds.x, physicalPanelBounds.y, physicalPanelBounds.w, physicalPanelBounds.h);
    c.clip();

    // Physical layer: BS
    const bsBlack = '#000000';
    c.lineCap = 'round';
    state.bs.forEach((b) => {
      const p = this.toPhysical(b.pos.x, b.pos.y, state);
      const r = 6 + 4 * p.depth;
      drawCircle(p.x + drift, p.y, r, bsBlack);
      placeLabel(`BS ${b.id}`, p.x + 10 + drift, p.y + 10, bsBlack, '11px Inter, sans-serif', physicalPanelBounds);
      this.pickableServers.push({ id: b.id, x: p.x + drift, y: p.y, r, kind: 'bs' });
    });

    const worstByCommunity = result?.worstUserByCommunity ?? new Map<number, { userId: number; e2e: number }>();
    // Physical layer: links + UEs
    for (const u of state.users) {
      const assigned = state.assignment[u.id] ?? 0;
      const bPos = this.toPhysical(state.bs[assigned].pos.x, state.bs[assigned].pos.y, state);
      const uPos = this.toPhysical(u.pos.x, u.pos.y, state);
      const hover = this.hoveredUserId === u.id;
      const color = hover ? '#0f172a' : palette[u.communityId % palette.length];
      const jitter = Math.sin(this.animPhase * 2.2 + u.id) * 0.9 * uPos.depth * physicalMotionScale;
      const isWorstForSpace = worstByCommunity.get(u.communityId)?.userId === u.id;
      const uR = 3 + 3 * uPos.depth;
      const clampedUPos = clampPointInBounds(
        uPos.x + jitter,
        uPos.y + jitter * 0.25,
        physicalPanelBounds,
        hover ? uR * 1.4 + 1 : uR + 1
      );

      c.strokeStyle = color;
      c.lineWidth = 1 + 2 * uPos.depth + (hover ? 1.5 : 0);
      c.beginPath();
      c.moveTo(clampedUPos.x, clampedUPos.y);
      c.lineTo(bPos.x + jitter * 0.2, bPos.y + jitter * 0.35);
      c.stroke();

      if (isWorstForSpace) {
        c.strokeStyle = '#ef4444';
        c.lineWidth = 2.2;
        c.beginPath();
        c.arc(clampedUPos.x, clampedUPos.y, hover ? uR * 1.5 : uR + 2.8, 0, Math.PI * 2);
        c.stroke();
      }
      drawCircle(clampedUPos.x, clampedUPos.y, hover ? uR * 1.4 : uR, color);
      const baseX = clampedUPos.x + 5;
      const baseY = clampedUPos.y + 10;
      const idText = String(u.id);
      const idFont = `${Math.max(9, 11 * (0.8 + 0.2 * virtualMotionScale))}px Inter, sans-serif`;
      const idLabel = `U${idText}`;
      placeLabel(idLabel, baseX, baseY, isWorstForSpace ? '#ef4444' : color, idFont, physicalPanelBounds);
      if (isWorstForSpace) {
        c.fillStyle = '#b91c1c';
        placeLabel('worst', baseX, baseY + 14, '#b91c1c', `${Math.max(8, 10 * (0.8 + 0.2 * virtualMotionScale))}px Inter, sans-serif`, physicalPanelBounds);
      }
      this.pickableUsers.push({ id: u.id, x: clampedUPos.x, y: clampedUPos.y, r: hover ? uR * 1.4 : uR, kind: 'user' });
    }

    // Focus layer: dim topology while keeping servers as the highlight
    const overlayAlpha = this.draggingServerId === null ? 0.58 : 0.35;
    c.fillStyle = `rgba(255, 255, 255, ${overlayAlpha})`;
    c.fillRect(physicalPanelBounds.x, physicalPanelBounds.y, physicalPanelBounds.w, physicalPanelBounds.h);

    const serversByLocation = new Map<string, number[]>();
    const serverLocKey = (comm: { serverMode: 'atBS' | 'free2D'; serverBsId?: number; serverPos?: { x: number; y: number } }, bsCount: number) => {
      if (comm.serverMode === 'atBS') {
        return `bs:${comm.serverBsId ?? 0}/${bsCount}`;
      }
      const sx = Math.round((comm.serverPos?.x ?? 0) * 1000);
      const sy = Math.round((comm.serverPos?.y ?? 0) * 1000);
      return `xy:${sx},${sy}`;
    };

    state.communities.forEach((comm) => {
      const key = serverLocKey(comm, state.bs.length);
      const bucket = serversByLocation.get(key);
      if (bucket) {
        bucket.push(comm.id);
      } else {
        serversByLocation.set(key, [comm.id]);
      }
    });

    // Physical layer: servers (drawn last so they stay in front)
    state.communities.forEach((comm) => {
      const isDragging = this.draggingServerId === comm.id;
      const prevAnim = this.draggingServerAnim.get(comm.id) ?? 0;
      const targetAnim = isDragging ? 1 : 0;
      const animSpeed = isDragging ? 0.5 : 0.16;
      const dragAnim = prevAnim + (targetAnim - prevAnim) * animSpeed;
      this.draggingServerAnim.set(comm.id, dragAnim);

      let serverPos = comm.serverMode === 'atBS'
        ? state.bs[comm.serverBsId ?? 0].pos
        : (comm.serverPos ?? state.bs[comm.serverBsId ?? 0].pos);
      if (this.draggingServerId === comm.id && this.draggingServerWorldPos) {
        serverPos = this.draggingServerWorldPos;
      }
      const p = this.toPhysical(serverPos.x, serverPos.y, state);
      const group = serversByLocation.get(serverLocKey(comm, state.bs.length)) ?? [comm.id];
      const groupIndex = group.indexOf(comm.id);
      const groupSize = group.length;
      const spread = Math.min(7, 2 + groupSize * 0.9);
      const spreadAngle = (groupIndex / Math.max(1, groupSize)) * Math.PI * 2;
      const offsetDist = spread * Math.max(0.4, Math.min(1.6, groupSize / 4));
      const locOffsetX = Math.cos(spreadAngle) * offsetDist;
      const locOffsetY = Math.sin(spreadAngle) * offsetDist * 0.58;
      const pulse = 1 + 0.2 * physicalMotionScale * Math.sin(this.animPhase * 1.7 + comm.id);
      const rr = (7 + 3 * p.depth) * pulse * (1 + 0.18 * dragAnim + 0.06 * dragAnim * Math.sin(this.animPhase * 2.6 + comm.id));
      const ringR = rr * 1.35;
      c.save();
      if (dragAnim > 0.01) {
        c.shadowColor = `${communityColor(comm.id)}`;
        c.shadowBlur = 8 * dragAnim;
      }
      c.strokeStyle = communityColor(comm.id);
      c.lineWidth = 2.2 + 1.0 * dragAnim;
      c.globalAlpha = 0.85 + 0.15 * dragAnim;
      if (dragAnim > 0.01) {
        c.globalAlpha = Math.min(1, 0.85 + 0.15 * (1 + Math.sin(this.animPhase * 5 + comm.id * 0.7) * 0.35) * dragAnim);
      }
      if (dragAnim > 0.01) {
        c.beginPath();
        c.arc(p.x + drift + locOffsetX, p.y + locOffsetY, ringR * (1 + 0.06 * dragAnim), 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
      c.strokeStyle = communityColor(comm.id);
      c.lineWidth = 2.2;
        c.beginPath();
        c.arc(p.x + drift + locOffsetX, p.y + locOffsetY, ringR, 0, Math.PI * 2);
        c.stroke();
      drawCircle(p.x + drift + locOffsetX, p.y + locOffsetY, rr * (0.98 + 0.02 * dragAnim), '#ffffff');
      drawCircle(p.x + drift + locOffsetX, p.y + locOffsetY, rr * 0.86, communityColor(comm.id));
      if (comm.serverMode === 'free2D') {
        c.strokeStyle = communityColor(comm.id);
        c.setLineDash([4, 3]);
        c.beginPath();
        c.arc(p.x + drift + locOffsetX, p.y + locOffsetY, (11 + 2 * p.depth) * pulse * (1 + 0.08 * dragAnim), 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }
      const label = `S${comm.id + 1}`;
      const labelX = p.x + 10 + drift + locOffsetX;
      const labelY = p.y + 2 + locOffsetY;
      const labelFont = dragAnim > 0.01 ? 'bold 14px Inter, sans-serif' : 'bold 13px Inter, sans-serif';
      const labelPlaced = placeLabel(
        label,
        labelX,
        labelY,
        '#000000',
        labelFont,
        physicalPanelBounds
      );
      if (!labelPlaced) {
        c.font = labelFont;
        c.fillStyle = '#000000';
        c.save();
        c.globalAlpha = 1;
        c.fillText(label, labelX, labelY);
        c.restore();
      }
      c.font = '12px Inter, sans-serif';
      this.pickableServers.push({
        id: comm.id,
        x: p.x + drift + locOffsetX,
        y: p.y + locOffsetY,
        r: ringR * (1 + 0.2 * dragAnim),
        kind: 'server'
      });
    });
    c.restore();

    // Virtual layer
    const virtualNodes = state.users.map((u) => {
      const pLocal = state.mobility.userVirtualPos[u.id] ?? { x: u.pos.x / state.width, y: u.pos.y / state.height };
      const space = mapToSpace(u.communityId);
      const p = toVirtualSpace(pLocal.x, pLocal.y, space);
      const float = Math.sin(this.animPhase + u.id * 0.3) * 0.8 * virtualMotionScale;
      const clampedVirtual = clampPointInBounds(
        p.x + float,
        p.y + float * 0.5,
        virtualPanelBounds,
        4.5
      );
      return {
        id: u.id,
        communityId: u.communityId,
        nx: pLocal.x,
        ny: pLocal.y,
        space: p.space,
        x: clampedVirtual.x,
        y: clampedVirtual.y
      };
    });

    const virtualLinkBounds = {
      x: virtualPanelBounds.x + 6,
      y: virtualPanelBounds.y,
      w: virtualPanelBounds.w - 12,
      h: virtualPanelBounds.h + 4
    };
    c.save();
    c.beginPath();
    c.rect(virtualLinkBounds.x, virtualLinkBounds.y, virtualLinkBounds.w, virtualLinkBounds.h);
    c.clip();

    const nodesBySpace = Array.from({ length: virtualSpaceCount }, () => [] as number[]);
    for (let i = 0; i < virtualNodes.length; i += 1) {
      const node = virtualNodes[i];
      const space = Math.max(0, Math.min(virtualSpaceCount - 1, node.space));
      nodesBySpace[space].push(i);
    }

    const mode = state.mobility.virtualInteractionMode;
    const maxKRaw = Math.max(1, Math.round(mode === 'radius' ? 2 : state.mobility.virtualK ?? 2));
    const maxK = Math.min(12, Math.max(1, Math.floor(maxKRaw + state.communities.length * 0.5)));
    const maxRadiusPeers = Math.max(6, Math.min(18, virtualNodes.length));
    const maxAllPeers = Math.max(6, Math.min(20, Math.floor(35 / Math.max(1, virtualSpaceCount))));
    const radiusSq = Math.max(0, Math.min(1, state.mobility.virtualRadius)) ** 2;

    const keepClosest = (a: { nx: number; ny: number }, indices: number[], maxKeep: number) => {
      const out: { idx: number; distSq: number }[] = [];
      for (let t = 0; t < indices.length; t += 1) {
        const j = indices[t];
        const n = virtualNodes[j];
        const dx = a.nx - n.nx;
        const dy = a.ny - n.ny;
        const distSq = dx * dx + dy * dy;
        if (distSq <= 0) {
          continue;
        }
        let inserted = false;
        for (let p = 0; p < out.length; p += 1) {
          if (distSq < out[p].distSq) {
            out.splice(p, 0, { idx: j, distSq });
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          out.push({ idx: j, distSq });
        }
        if (out.length > maxKeep) {
          out.length = maxKeep;
        }
      }
      return out;
    };

    const samplePeers = (indices: number[], maxKeep: number, seedA: number) => {
      if (indices.length <= maxKeep) return indices.map((idx) => ({ idx, distSq: 0 }));
      const seed = Math.max(1, Math.floor(seedA));
      const out: { idx: number; distSq: number }[] = [];
      let step = seed % Math.max(1, indices.length - 1) + 1;
      for (let t = 0; t < maxKeep; t += 1) {
        const pick = (t * step) % indices.length;
        out.push({ idx: indices[pick], distSq: 0 });
      }
      return out;
    };

    let clearOccupied = true;
    for (let i = 0; i < virtualNodes.length; i += 1) {
      const a = virtualNodes[i];
      const bySameSpace = nodesBySpace[Math.max(0, Math.min(virtualSpaceCount - 1, a.space))];
      let peers: { idx: number; distSq: number }[] = [];
      let stroke = '#38bdf8';
      let strokeWidth = 1;
      let alpha = 0.25 + 0.35 * virtualMotionScale;

      if (mode === 'all') {
        stroke = '#0ea5e9';
        strokeWidth = 0.6;
        alpha = 0.06 + 0.22 * virtualMotionScale;
        peers = samplePeers(bySameSpace.filter((j) => j !== i), maxAllPeers, a.id + i * 7);
      } else if (mode === 'radius') {
        stroke = '#14b8a6';
        strokeWidth = 1.2;
        alpha = 0.22 + 0.45 * virtualMotionScale;
        const withDist = keepClosest(a, bySameSpace.filter((j) => j !== i), maxRadiusPeers);
        peers = withDist.filter((p) => p.distSq <= radiusSq);
      } else if (mode === 'randomM') {
        stroke = '#a78bfa';
        strokeWidth = 1.1;
        alpha = 0.22 + 0.45 * virtualMotionScale;
        const maxM = Math.max(1, Math.round(maxK));
        const sampled = samplePeers(bySameSpace.filter((j) => j !== i), maxM, a.id * 31 + 17);
        peers = sampled;
      } else {
        stroke = '#22d3ee';
        strokeWidth = 1;
        alpha = 0.2 + 0.45 * virtualMotionScale;
        peers = keepClosest(a, bySameSpace.filter((j) => j !== i), maxK);
      }

      if (clearOccupied) {
        occupiedRectangles.length = 0;
        clearOccupied = false;
      }

      c.strokeStyle = stroke;
      c.lineWidth = strokeWidth;
      c.globalAlpha = alpha;
      for (const p of peers) {
        const b = virtualNodes[p.idx];
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
      c.globalAlpha = 1;
    }

    const virtualNodeBounds = virtualLinkBounds;

    for (const n of virtualNodes) {
      const isWorstForSpace = worstByCommunity.get(n.communityId)?.userId === n.id;
      drawCircle(n.x, n.y, 3.2 + 0.8 * virtualMotionScale, palette[n.communityId % palette.length]);
      if (isWorstForSpace) {
        c.strokeStyle = '#ef4444';
        c.lineWidth = 2.4;
        c.beginPath();
        c.arc(n.x, n.y, 7 + 0.8 * virtualMotionScale, 0, Math.PI * 2);
        c.stroke();
      }
      const color = palette[n.communityId % palette.length];
      const idText = `U${n.id}`;
      const baseX = n.x + 5;
      const baseY = n.y + 6;
      const idFont = `${Math.max(9, 11 * (0.8 + 0.2 * virtualMotionScale))}px Inter, sans-serif`;
      placeLabel(idText, baseX, baseY, isWorstForSpace ? '#ef4444' : color, idFont, virtualNodeBounds);
      if (isWorstForSpace) {
        c.fillStyle = '#b91c1c';
        placeLabel('worst', baseX, baseY + 16, '#b91c1c', `${Math.max(8, 10 * (0.8 + 0.2 * virtualMotionScale))}px Inter, sans-serif`, virtualNodeBounds);
      }
    }
    c.restore();

    c.setLineDash([]);
  }

  pickAt(x: number, y: number): { kind: 'bs' | 'server' | 'user' | null; id: number } | null {
    let best: { kind: 'bs' | 'server' | 'user'; id: number; d2: number; priority: number } | null = null;
    const candidates = [...this.pickableUsers, ...this.pickableServers];
    const priority = (kind: 'bs' | 'server' | 'user') => {
      if (kind === 'user') return 2;
      if (kind === 'server') return 1;
      return 0;
    };
    for (const p of candidates) {
      const dx = x - p.x;
      const dy = y - p.y;
      const d2 = dx * dx + dy * dy;
      if (!best || d2 <= best.d2 && priority(p.kind) >= best.priority) {
        if (d2 <= p.r * p.r) {
          best = { kind: p.kind, id: p.id, d2, priority: priority(p.kind) };
        }
      }
    }

    return best ? { kind: best.kind, id: best.id } : null;
  }

  screenToWorld(x: number, y: number): { x: number; y: number } | null {
    if (!this.lastState) return null;
    return this.physicalToWorld(x, y, this.lastState);
  }

  setHoveredUser(userId: number | null): void {
    this.hoveredUserId = userId;
  }

  setDraggingServer(serverId: number | null): void {
    this.draggingServerId = serverId;
  }

  setDraggingServerWorldPos(pos: { x: number; y: number } | null): void {
    this.draggingServerWorldPos = pos;
  }

  dispose(): void {
    this.ctx = null;
    this.canvas = null;
    this.lastState = null;
  }
}
