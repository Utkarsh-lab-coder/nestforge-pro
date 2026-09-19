/*
 * NestForge Pro — Measure tool
 *
 * Lets the user double-check a layout on the canvas, in sheet millimetres:
 *
 *   • Two clicks → a dimension line with its length (and the horizontal and
 *     vertical components). Clicks snap to part corners and part edges, the
 *     sheet corners and edges, so a gap between two parts is measured
 *     edge to edge, not roughly where the mouse was.
 *   • A click inside one part, then inside another → the shortest distance
 *     between the two outlines (the real cutting gap), drawn where it is.
 *   • Measurements stay on the canvas until cleared, so several gaps can be
 *     checked against each other. Esc cancels a half-made measurement,
 *     Esc again (or the Clear button) removes them all.
 *
 * Renderer calls Measure.onClick / onMove / draw; App.toggleMeasure switches
 * it on and off. Everything is in sheet coordinates (mm, y down), the same
 * frame the Renderer draws placements in.
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system.
 */

const Measure = {
  active: false,
  items: [],        // finished measurements: {kind:'points'|'gap', a:[x,y], b:[x,y], label, sub}
  pending: null,    // first click of a measurement in progress: {pt, partIdx, snap}
  hover: null,      // live snap under the mouse: {pt, kind, partIdx}
  SNAP_PX: 9,       // snap radius in screen pixels

  // ── geometry ────────────────────────────────────────────────────────────
  _dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); },

  // Closest point on segment p-q to point s.
  _closestOnSeg(s, p, q) {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return [p[0], p[1]];
    let t = ((s[0] - p[0]) * dx + (s[1] - p[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return [p[0] + t * dx, p[1] + t * dy];
  },

  _inside(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi) inside = !inside;
    }
    return inside;
  },

  // World outline of a placement (sheet mm).
  _worldPoly(pl) {
    return PU.worldPolyOf(pl);
  },

  // Placements on the sheet currently shown.
  _placements() {
    const nr = (typeof App !== 'undefined') && App.nestResult;
    if (!nr || !nr.placements) return [];
    const sheet = Renderer.currentSheet || 0;
    const out = [];
    for (let i = 0; i < nr.placements.length; i++) {
      const pl = nr.placements[i];
      if ((pl.sheet || 0) !== sheet) continue;
      const wp = this._worldPoly(pl);
      if (wp && wp.length >= 3) out.push({ idx: i, pl, wp });
    }
    return out;
  },

  // Shortest distance between two outlines: every vertex of one against
  // every edge of the other, both ways. Returns {d, a, b} with the two
  // closest points, or d = 0 when the outlines cross or one is inside the other.
  _polyGap(P, Q) {
    let best = { d: Infinity, a: null, b: null };
    const scan = (V, E, flip) => {
      for (let i = 0; i < V.length; i++) {
        const v = V[i];
        for (let j = 0, k = E.length - 1; j < E.length; k = j++) {
          const c = this._closestOnSeg(v, E[k], E[j]);
          const d = this._dist(v, c);
          if (d < best.d) best = flip ? { d, a: c, b: v } : { d, a: v, b: c };
        }
      }
    };
    scan(P, Q, false);
    scan(Q, P, true);
    if (this._inside(Q, P[0][0], P[0][1]) || this._inside(P, Q[0][0], Q[0][1])) best.d = 0;
    return best;
  },

  // ── snapping ────────────────────────────────────────────────────────────
  // Nearest corner, else nearest edge point, within SNAP_PX screen pixels;
  // part outlines first, then the sheet. Falls back to the raw point.
  snap(x, y) {
    const tol = this.SNAP_PX / (Renderer.zoom || 1);
    const s = [x, y];
    const cands = [];
    for (const { idx, wp } of this._placements()) cands.push({ poly: wp, partIdx: idx });
    const so = Renderer.sheetOutline;
    if (so && so.length >= 3) cands.push({ poly: so, partIdx: -1 });
    else cands.push({ poly: [[0, 0], [Renderer.sheetW, 0], [Renderer.sheetW, Renderer.sheetH], [0, Renderer.sheetH]], partIdx: -1 });

    let bestV = null, dV = tol;          // vertex snap
    let bestE = null, dE = tol;          // edge snap
    for (const c of cands) {
      const poly = c.poly;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const d = this._dist(s, poly[i]);
        if (d < dV) { dV = d; bestV = { pt: [poly[i][0], poly[i][1]], kind: 'corner', partIdx: c.partIdx }; }
        const cp = this._closestOnSeg(s, poly[j], poly[i]);
        const de = this._dist(s, cp);
        if (de < dE) { dE = de; bestE = { pt: cp, kind: 'edge', partIdx: c.partIdx }; }
      }
    }
    if (bestV) return bestV;
    if (bestE) return bestE;
    // Inside a part (no edge near): a part pick, for part-to-part gaps.
    for (const { idx, wp } of this._placements()) {
      if (this._inside(wp, x, y)) return { pt: s, kind: 'part', partIdx: idx };
    }
    return { pt: s, kind: 'free', partIdx: -1 };
  },

  // ── interaction ─────────────────────────────────────────────────────────
  onMove(x, y) {
    if (!this.active) return;
    this.hover = this.snap(x, y);
    Renderer.draw();
  },

  onClick(x, y) {
    if (!this.active) return;
    const hit = this.snap(x, y);
    if (!this.pending) {
      this.pending = hit;
      this._status(hit.kind === 'part'
        ? 'Part picked. Click inside another part for the gap between them, or click a point.'
        : 'First point set. Click the second point (snaps to corners and edges).');
      Renderer.draw();
      return;
    }
    const a = this.pending;
    this.pending = null;
    if (a.kind === 'part' && hit.kind === 'part' && a.partIdx !== hit.partIdx) {
      const P = this._worldPoly(App.nestResult.placements[a.partIdx]);
      const Q = this._worldPoly(App.nestResult.placements[hit.partIdx]);
      const g = this._polyGap(P, Q);
      const na = App.nestResult.placements[a.partIdx].partName || 'part';
      const nb = App.nestResult.placements[hit.partIdx].partName || 'part';
      if (g.d === 0 || !g.a) {
        this.items.push({ kind: 'gap', a: a.pt, b: hit.pt, label: 'OVERLAP', sub: `${na} / ${nb}` });
        this._status(`${na} and ${nb} overlap or touch.`);
      } else {
        this.items.push({ kind: 'gap', a: g.a, b: g.b, label: `gap ${this._fmt(g.d)}`, sub: `${na} ↔ ${nb}` });
        this._status(`Shortest gap ${this._fmt(g.d)} between ${na} and ${nb}.`);
      }
    } else {
      const d = this._dist(a.pt, hit.pt);
      const dx = Math.abs(hit.pt[0] - a.pt[0]), dy = Math.abs(hit.pt[1] - a.pt[1]);
      this.items.push({ kind: 'points', a: a.pt, b: hit.pt, label: this._fmt(d), sub: `Δx ${this._fmt(dx)}  Δy ${this._fmt(dy)}` });
      this._status(`${this._fmt(d)}  (Δx ${this._fmt(dx)}, Δy ${this._fmt(dy)}). Click to start another; Esc clears.`);
    }
    Renderer.draw();
  },

  // Esc: cancel the pending point first, then clear everything.
  onEscape() {
    if (!this.active) return false;
    if (this.pending) { this.pending = null; this._status('Cancelled. Click a point to measure.'); }
    else if (this.items.length) { this.clear(); }
    else { App.toggleMeasure(false); return true; }
    Renderer.draw();
    return true;
  },

  clear() {
    this.items = [];
    this.pending = null;
    this._status(this.active ? 'Measurements cleared. Click a point, corner, edge or part.' : '');
    Renderer.draw();
  },

  _fmt(mm) { return (Math.round(mm * 100) / 100).toFixed(2) + ' mm'; },

  _status(msg) {
    const el = document.getElementById('nest-status');
    if (el && this.active) el.textContent = '📏 ' + msg;
  },

  // ── drawing (inside the Renderer's sheet transform) ─────────────────────
  draw(ctx, zoom) {
    if (!this.active && !this.items.length) return;
    const px = (n) => n / zoom;                 // n screen pixels in sheet units
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const it of this.items) this._drawDim(ctx, zoom, it.a, it.b, it.label, it.sub, it.kind === 'gap' ? '#d946ef' : '#0ea5e9');
    if (this.pending) {
      const a = this.pending.pt;
      if (this.hover) {
        const b = this.hover.pt;
        if (this.pending.kind === 'part' && this.hover.kind === 'part' && this.hover.partIdx !== this.pending.partIdx) {
          this._drawPartHalo(ctx, zoom, this.hover.partIdx, '#d946ef');
        } else {
          this._drawDim(ctx, zoom, a, b, this._fmt(this._dist(a, b)), null, 'rgba(14,165,233,0.75)');
        }
      }
      if (this.pending.kind === 'part') this._drawPartHalo(ctx, zoom, this.pending.partIdx, '#d946ef');
      else this._drawMarker(ctx, zoom, a, 'corner', '#0ea5e9');
    }
    if (this.hover && this.hover.kind !== 'free' && this.hover.kind !== 'part') {
      this._drawMarker(ctx, zoom, this.hover.pt, this.hover.kind, '#f97316');
    }
    // Crosshair at the cursor
    if (this.hover) {
      const [x, y] = this.hover.pt;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = px(1);
      ctx.beginPath();
      ctx.moveTo(x - px(14), y); ctx.lineTo(x + px(14), y);
      ctx.moveTo(x, y - px(14)); ctx.lineTo(x, y + px(14));
      ctx.stroke();
    }
    ctx.restore();
  },

  _drawMarker(ctx, zoom, pt, kind, color) {
    const r = 5 / zoom;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    if (kind === 'corner') ctx.rect(pt[0] - r, pt[1] - r, 2 * r, 2 * r);
    else ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2);
    ctx.stroke();
  },

  _drawPartHalo(ctx, zoom, idx, color) {
    const pl = App.nestResult && App.nestResult.placements[idx];
    const wp = pl && this._worldPoly(pl);
    if (!wp) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.beginPath();
    wp.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  },

  // A dimension line: the segment, end ticks square to it, and a label
  // pill beside its middle. Sizes are in screen pixels so they read the
  // same at any zoom.
  _drawDim(ctx, zoom, a, b, label, sub, color) {
    const px = (n) => n / zoom;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;       // unit normal
    const t = px(6);
    ctx.strokeStyle = color;
    ctx.lineWidth = px(2);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.moveTo(a[0] + nx * t, a[1] + ny * t); ctx.lineTo(a[0] - nx * t, a[1] - ny * t);
    ctx.moveTo(b[0] + nx * t, b[1] + ny * t); ctx.lineTo(b[0] - nx * t, b[1] - ny * t);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(a[0], a[1], px(3), 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(b[0], b[1], px(3), 0, Math.PI * 2); ctx.fill();

    // Label: drawn in screen space so the text is never scaled.
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const sx = Renderer.offsetX + mx * zoom, sy = Renderer.offsetY + my * zoom;
    // Offset the pill off the line, along the normal, in screen pixels.
    const ox = nx * 16, oy = ny * 16;
    ctx.font = 'bold 12px JetBrains Mono, Consolas, monospace';
    const lines = sub ? [label, sub] : [label];
    ctx.font = 'bold 12px JetBrains Mono, Consolas, monospace';
    const w1 = ctx.measureText(lines[0]).width;
    ctx.font = '10px JetBrains Mono, Consolas, monospace';
    const w2 = lines[1] ? ctx.measureText(lines[1]).width : 0;
    const w = Math.max(w1, w2) + 14, h = lines[1] ? 32 : 20;
    const bx = Math.round(sx + ox - w / 2), by = Math.round(sy + oy - h / 2);
    ctx.fillStyle = 'rgba(20,22,30,0.92)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, w, h, 4) : ctx.rect(bx, by, w, h);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 12px JetBrains Mono, Consolas, monospace';
    ctx.fillText(lines[0], bx + w / 2, by + (lines[1] ? 11 : h / 2));
    if (lines[1]) {
      ctx.font = '10px JetBrains Mono, Consolas, monospace';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(lines[1], bx + w / 2, by + 23);
    }
    ctx.restore();
  },
};
