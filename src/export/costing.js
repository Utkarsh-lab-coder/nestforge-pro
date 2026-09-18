/*
 * NestForge Pro — Costing — per-worksheet cost report
 *
 * Original location: lines 14816..15994 of nestforge-pro.html (1179 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const Costing = {
  /* ── COSTING & NORM ─────────────────────────────────────────────────
     Norm = material consumed per piece (or per pair).
     Two accepted industry definitions for "material consumed":
       (a) Gross sheet area / count       — includes waste (MOST COMMON
           in shoe/leather industry — what you actually buy)
       (b) Net part area / count          — just the piece itself
     We use (a) since it reflects real purchasing cost. Waste is shown
     separately so you can see what's being lost. */
  _costMode: 'piece', // 'piece' | 'pair'
  _reportFmt: 'excel', // 'excel' | 'pdf'

  setupCosting() {
    const ids = ['cost-article','cost-component','cost-material','cost-price','cost-unit'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => this._updateCosting());
    }
    document.getElementById('cost-mode-piece').addEventListener('click', () => this._setCostMode('piece'));
    document.getElementById('cost-mode-pair').addEventListener('click', () => this._setCostMode('pair'));
    document.getElementById('cost-add-spec').addEventListener('click', () => this._addSpec());
  },

  _setCostMode(mode) {
    this._costMode = mode;
    document.getElementById('cost-mode-piece').classList.toggle('active', mode === 'piece');
    document.getElementById('cost-mode-pair').classList.toggle('active', mode === 'pair');
    this._updateCosting();
  },

  _setReportFmt(fmt) {
    this._reportFmt = fmt;
    document.getElementById('cost-fmt-excel').classList.toggle('active', fmt === 'excel');
    document.getElementById('cost-fmt-pdf').classList.toggle('active', fmt === 'pdf');
  },

  _addSpec(key, value) {
    const container = document.getElementById('cost-specs');
    const row = document.createElement('div');
    row.className = 'cost-spec-row';
    row.innerHTML = `
      <input type="text" class="cost-spec-key" placeholder="Field (e.g. Brand)">
      <input type="text" class="cost-spec-val" placeholder="Value">
      <button class="cost-spec-del" type="button">✕</button>`;
    if (key)   row.querySelector('.cost-spec-key').value = key;
    if (value) row.querySelector('.cost-spec-val').value = value;
    row.querySelector('.cost-spec-del').addEventListener('click', () => row.remove());
    container.appendChild(row);
  },

  _collectSpecs() {
    const specs = [];
    document.querySelectorAll('#cost-specs .cost-spec-row').forEach(row => {
      const k = row.querySelector('.cost-spec-key').value.trim();
      const v = row.querySelector('.cost-spec-val').value.trim();
      if (k || v) specs.push({ key: k, value: v });
    });
    return specs;
  },

  _clearSpecs() {
    document.getElementById('cost-specs').innerHTML = '';
  },

  /* ── PRODUCT IMAGE ────────────────────────────────────────────────
     Stored in-memory as base64 data URL. Session-only — not persisted
     to the workspace save, so user re-uploads on reload.             */
  _productImage: null,   // { dataURL, width, height }

  _onProductImageChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (PNG, JPG, etc.)');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Image is too large. Maximum 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        this._productImage = { dataURL: e.target.result, width: img.width, height: img.height };
        this._renderProductImagePreview();
      };
      img.onerror = () => alert('Could not load that image.');
      img.src = e.target.result;
    };
    reader.onerror = () => alert('Could not read that file.');
    reader.readAsDataURL(file);
  },

  _removeProductImage() {
    this._productImage = null;
    document.getElementById('cost-image-input').value = '';
    this._renderProductImagePreview();
  },

  _renderProductImagePreview() {
    const preview = document.getElementById('cost-image-preview');
    const removeBtn = document.getElementById('cost-image-remove');
    if (!preview) return;
    if (this._productImage) {
      preview.innerHTML = `<img src="${this._productImage.dataURL}" style="max-width:100%;max-height:140px;border-radius:3px;display:block;margin:0 auto">`;
      preview.style.padding = '6px';
      preview.style.borderStyle = 'solid';
      if (removeBtn) removeBtn.style.display = 'block';
    } else {
      preview.innerHTML = '📷 Click to upload product image';
      preview.style.padding = '16px';
      preview.style.borderStyle = 'dashed';
      if (removeBtn) removeBtn.style.display = 'none';
    }
  },


  _mmSqToUnit(mm2, unit) {
    switch (unit) {
      case 'sqcm': return mm2 / 100;
      case 'sqdm': return mm2 / 10000;
      case 'sqm':  return mm2 / 1000000;
      case 'sqft': return mm2 / 92903.04;
      default:     return mm2 / 10000;
    }
  },

  _unitLabel(unit) {
    return { sqcm:'sq.cm', sqdm:'sq.dm', sqm:'sq.m', sqft:'sq.ft' }[unit] || 'sq.dm';
  },

  /* ── Convex hull via Andrew's monotone chain ──────────────────────
     O(n log n). Input: array of [x,y] points. Output: hull vertices
     in CCW order, no duplicate of first point at end. Returns the
     input verbatim if fewer than 3 points (degenerate). */
  _convexHull(points) {
    if (!points || points.length < 3) return points || [];
    // Sort by x, then y
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const n = pts.length;
    // Cross product of OA and OB vectors (z-component)
    const cross = (O, A, B) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
    // Build lower hull
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop();
      }
      lower.push(p);
    }
    // Build upper hull
    const upper = [];
    for (let i = n - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop();
      }
      upper.push(p);
    }
    // Concatenate (drop duplicate endpoints)
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  },

  /* Compute all the costing numbers in one place so both the live
     panel and the Excel/PDF report use identical logic.                 */
  _computeCosting() {
    const result = this.nestResult;
    if (!result || result.placed === 0) return null;
    const settings = this.getSettings();
    const mode = this._costMode;
    const unit = document.getElementById('cost-unit').value;
    const price = parseFloat(document.getElementById('cost-price').value) || 0;

    // Material area: for RECTANGULAR sheets, full earlier sheets + trimmed
    // last sheet. For LEATHER HIDE sheets, each used sheet is one full hide
    // area (no trimming of organic shapes).
    const sheets = result.sheets || [];
    const hasHideOutline = !!(this._sheetOutline && this._sheetOutline.length >= 3);
    const hideArea = hasHideOutline ? polyArea(this._sheetOutline) : 0;
    let sheetAreaMm = 0;
    for (let i = 0; i < sheets.length; i++) {
      const sh = sheets[i];
      if (hasHideOutline) {
        if (sh.placements.length > 0) sheetAreaMm += hideArea;
      } else {
        let maxY = 0;
        for (const p of sh.placements) {
          const bb = polyBBox(p.pts);
          const bottom = p.y + bb.h;
          if (bottom > maxY) maxY = bottom;
        }
        maxY = Math.min(settings.sheetH, Math.ceil(maxY) + settings.margin);
        const isLast = (i === sheets.length - 1);
        const height = isLast ? maxY : settings.sheetH;
        sheetAreaMm += settings.sheetW * height;
      }
    }
    if (sheetAreaMm === 0) {
      sheetAreaMm = hasHideOutline
        ? hideArea * Math.max(1, result.sheetCount)
        : settings.sheetW * settings.sheetH * result.sheetCount;
    }
    const partsAreaMm = result.placements.reduce((s, p) => s + polyArea(p.pts), 0);
    const util = sheetAreaMm > 0 ? (partsAreaMm / sheetAreaMm) : 0;

    // Fractional pair count — a single piece = 0.5 pair, 5 pieces = 2.5 pairs.
    const count = mode === 'pair' ? (result.placed / 2) : result.placed;
    const sheetAreaInUnit = this._mmSqToUnit(sheetAreaMm, unit);
    const partsAreaInUnit = this._mmSqToUnit(partsAreaMm, unit);
    const norm = count > 0 ? sheetAreaInUnit / count : 0;
    const costPer = norm * price;
    const total = sheetAreaInUnit * price;

    // Per-part breakdown — net area + GROSS area via CONVEX-HULL method.
    // ─────────────────────────────────────────────────────────────────
    // NET area = sum of polygon areas for that component's pieces.
    //
    // GROSS area = area of the convex hull enclosing all placements of
    //   that component, clipped to the sheet outline. This captures the
    //   "region of the hide actually used" by that component, including
    //   the inter-part gaps and margins WITHIN the cluster.
    //
    //   Empty hide regions outside any component's hull are NOT charged
    //   to any component — they're pure waste of unutilized hide.
    //
    //   Where two components' hulls overlap, the overlap is split by
    //   net-area share within that overlap region. Geometric exact
    //   overlap calculation is complex; we approximate by computing
    //   each hull's solo area then capping the sum at total sheet area
    //   if needed (avoids over-attribution when hulls overlap heavily).
    //
    // This matches the user's mental model: "how much of the hide did
    // each component actually consume in its nest region."
    const byPart = new Map();
    for (const pl of result.placements) {
      const key = pl.partName;
      if (!byPart.has(key)) byPart.set(key, { count: 0, area: 0, points: [] });
      const e = byPart.get(key);
      e.count++;
      e.area += polyArea(pl.pts);
      // Collect all vertices of all pieces of this component, for hull
      for (const pt of pl.pts) e.points.push(pt);
    }

    // Compute hull-based gross area for each component
    const componentGross = new Map();
    let totalHullArea = 0;
    for (const [name, e] of byPart) {
      // Use Costing._convexHull directly (not this._convexHull) because
      // App delegates _computeCosting and rebinds `this` to App, but
      // _convexHull lives on Costing only. Same pattern for _mmSqToUnit
      // wouldn't work either if it weren't already proxied — keep helpers
      // self-referential to the Costing module.
      const hull = Costing._convexHull(e.points);
      const grossMm = polyArea(hull);
      componentGross.set(name, grossMm);
      totalHullArea += grossMm;
    }

    // If sum of hulls exceeds sheet area (overlapping hulls), normalize
    // proportionally to total sheet area. This conservatively splits the
    // overlap zones by hull-share.
    let scale = 1;
    if (totalHullArea > sheetAreaMm && sheetAreaMm > 0) {
      scale = sheetAreaMm / totalHullArea;
    }

    const partBreakdown = [...byPart.entries()].map(([name, e]) => {
      const netAreaUnit = this._mmSqToUnit(e.area, unit);
      const grossMm = (componentGross.get(name) || 0) * scale;
      const grossAreaUnit = this._mmSqToUnit(grossMm, unit);
      const piecesForNorm = (mode === 'pair') ? (e.count / 2) : e.count;
      const netNormPer = piecesForNorm > 0 ? netAreaUnit / piecesForNorm : 0;
      const grossNormPer = piecesForNorm > 0 ? grossAreaUnit / piecesForNorm : 0;
      const wasteNormPer = grossNormPer - netNormPer;
      const utilizationPct = grossAreaUnit > 0 ? (netAreaUnit / grossAreaUnit) * 100 : 0;
      return {
        name,
        count: e.count,
        areaUnit: netAreaUnit,         // back-compat alias
        netAreaUnit,
        grossAreaUnit,
        netNormPer,
        grossNormPer,
        wasteNormPer,
        utilizationPct,
        costPer: grossNormPer * price,
      };
    });

    return {
      mode, unit, uLbl: this._unitLabel(unit), price,
      sheetW: settings.sheetW, sheetH: settings.sheetH, sheetCount: result.sheetCount,
      margin: settings.margin, gap: settings.gap,
      placed: result.placed, unplaced: result.unplaced,
      count, norm, costPer, total, util: util * 100, wastePct: (1 - util) * 100,
      sheetAreaInUnit, partsAreaInUnit, partBreakdown,
    };
  },

  _updateCosting() {
    const mode = this._costMode;
    const c = this._computeCosting();
    const badge = document.getElementById('cost-live-badge');
    const normEl = document.getElementById('cost-norm');
    const perEl  = document.getElementById('cost-per-unit');
    const countEl = document.getElementById('cost-count');
    const totalEl = document.getElementById('cost-total');
    const wasteEl = document.getElementById('cost-waste');
    const perLbl = document.getElementById('cost-per-lbl');
    const countLbl = document.getElementById('cost-count-lbl');

    perLbl.textContent  = mode === 'pair' ? 'Cost per pair'  : 'Cost per piece';
    countLbl.textContent = mode === 'pair' ? 'Pairs produced' : 'Pieces produced';

    if (!c) {
      badge.textContent = 'run nesting first';
      normEl.textContent = '—'; perEl.textContent = '—';
      countEl.textContent = '—'; totalEl.textContent = '—'; wasteEl.textContent = '—';
      const breakList = document.getElementById('cost-breakdown-list');
      const breakMode = document.getElementById('cost-breakdown-mode');
      if (breakList) breakList.innerHTML = '<div style="color:var(--text3);font-style:italic;font-family:var(--font);text-align:center;padding:8px 0">run nesting first</div>';
      if (breakMode) breakMode.textContent = '—';
      return;
    }

    const fmtMoney = v => '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    const fmtCount = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');

    badge.textContent = mode === 'pair' ? 'per pair' : 'per piece';
    normEl.textContent = c.norm.toFixed(3) + ' ' + c.uLbl + '/' + mode;
    perEl.textContent = fmtMoney(c.costPer);
    countEl.textContent = fmtCount(c.count);
    totalEl.textContent = fmtMoney(c.total);
    wasteEl.textContent = c.wastePct.toFixed(1) + '%';

    // Per-component breakdown table — net vs gross norm per piece/pair
    const breakList = document.getElementById('cost-breakdown-list');
    const breakMode = document.getElementById('cost-breakdown-mode');
    if (breakList && c.partBreakdown && c.partBreakdown.length) {
      if (breakMode) breakMode.textContent = c.uLbl + '/' + mode;
      let html = '<table style="width:100%;border-collapse:collapse">';
      html += '<thead><tr style="border-bottom:1px solid var(--border2);color:var(--text2);font-size:9px;font-weight:600">'
        + '<th style="text-align:left;padding:3px 4px">Part</th>'
        + '<th style="text-align:right;padding:3px 4px">Qty</th>'
        + '<th style="text-align:right;padding:3px 4px;color:var(--accent)">Net</th>'
        + '<th style="text-align:right;padding:3px 4px;color:var(--green)">Gross</th>'
        + '<th style="text-align:right;padding:3px 4px;color:var(--yellow)">Waste</th>'
        + '<th style="text-align:right;padding:3px 4px">Util</th>'
        + '</tr></thead><tbody>';
      for (const p of c.partBreakdown) {
        const netPer = p.netNormPer != null ? p.netNormPer : ((p.netAreaUnit || p.areaUnit) / p.count);
        const grossPer = p.grossNormPer != null ? p.grossNormPer : netPer;
        const wastePer = p.wasteNormPer != null ? p.wasteNormPer : 0;
        const utilPct = p.utilizationPct != null ? p.utilizationPct : 100;
        // Use user's custom display name if set
        const dispName = (typeof App !== 'undefined' && App.getDisplayName)
          ? App.getDisplayName(p.name) : p.name;
        const safeName = String(dispName).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
        const truncName = safeName.length > 18 ? safeName.slice(0, 16) + '…' : safeName;
        html += '<tr style="border-bottom:1px dotted var(--border2)">'
          + '<td style="padding:3px 4px;font-family:var(--font);font-weight:500" title="' + safeName + '">' + truncName + '</td>'
          + '<td style="text-align:right;padding:3px 4px">' + p.count + '</td>'
          + '<td style="text-align:right;padding:3px 4px;color:var(--accent)">' + netPer.toFixed(2) + '</td>'
          + '<td style="text-align:right;padding:3px 4px;color:var(--green);font-weight:600">' + grossPer.toFixed(2) + '</td>'
          + '<td style="text-align:right;padding:3px 4px;color:var(--yellow)">' + wastePer.toFixed(2) + '</td>'
          + '<td style="text-align:right;padding:3px 4px">' + utilPct.toFixed(0) + '%</td>'
          + '</tr>';
      }
      html += '</tbody></table>';
      breakList.innerHTML = html;
    } else if (breakList) {
      breakList.innerHTML = '<div style="color:var(--text3);font-style:italic;font-family:var(--font);text-align:center;padding:8px 0">no parts placed</div>';
      if (breakMode) breakMode.textContent = '—';
    }
  },

  /* Render the current sheet's nested layout to a PNG dataURL.
     White background, solid black outlines, no labels or clutter —
     designed for clean embedding in Excel and PDF reports.             */
  /* Render a specific worksheet's nested-layout image WITHOUT activating it.
     Mirrors _renderLayoutToDataURL but reads state from the passed-in ws
     object instead of `this`. Used for consolidated reports where we need
     to embed each component's layout side-by-side. Returns PNG data URL
     or null if the worksheet has no nest result.                          */
  _renderWorksheetLayoutToDataURL(ws, pxW = 1000, pxH = 700) {
    if (!ws || !ws.nestResult) return null;
    const placements = ws.nestResult.placements.filter(p => (p.sheet || 0) === 0);
    if (!placements.length) return null;

    // Settings — prefer stored ws.settings, fall back to inferring from
    // nestResult (usableW/H + assumed 5mm margin).
    let sheetW, sheetH, margin;
    if (ws.settings && ws.settings.sheetW) {
      sheetW = ws.settings.sheetW;
      sheetH = ws.settings.sheetH;
      margin = ws.settings.margin;
    } else if (ws.nestResult.usableW && ws.nestResult.usableH) {
      // Infer: usable + 2×default-margin(5mm)
      margin = 5;
      sheetW = ws.nestResult.usableW + 2 * margin;
      sheetH = ws.nestResult.usableH + 2 * margin;
    } else {
      // Last resort: bbox of placements
      let mnx=Infinity, mny=Infinity, mxx=-Infinity, mxy=-Infinity;
      for (const p of placements) {
        const bb = polyBBox(p.pts);
        if (p.x + bb.x < mnx) mnx = p.x + bb.x;
        if (p.y + bb.y < mny) mny = p.y + bb.y;
        if (p.x + bb.x + bb.w > mxx) mxx = p.x + bb.x + bb.w;
        if (p.y + bb.y + bb.h > mxy) mxy = p.y + bb.y + bb.h;
      }
      margin = 5;
      sheetW = (mxx - mnx) + 2 * margin;
      sheetH = (mxy - mny) + 2 * margin;
    }
    if (!isFinite(sheetW) || sheetW <= 0 || !isFinite(sheetH) || sheetH <= 0) return null;

    // Keep canvas aspect matching sheet aspect
    const aspect = sheetW / sheetH;
    if (aspect > pxW / pxH) pxH = Math.round(pxW / aspect);
    else                    pxW = Math.round(pxH * aspect);

    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pxW, pxH);

    const pad = 16;
    const scale = Math.min((pxW - pad*2) / sheetW, (pxH - pad*2) / sheetH);
    const ox = pad + ((pxW - pad*2) - sheetW * scale) / 2;
    const oy = pad + ((pxH - pad*2) - sheetH * scale) / 2;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    // Sheet boundary
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, sheetW, sheetH);

    // Margin (dashed)
    ctx.strokeStyle = '#aabbff';
    ctx.setLineDash([4/scale, 4/scale]);
    ctx.lineWidth = 0.6 / scale;
    ctx.strokeRect(margin, margin, sheetW - 2*margin, sheetH - 2*margin);
    ctx.setLineDash([]);

    // Placements
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const pl of placements) {
      const { pts, x, y, color, innerLines } = pl;
      const bb = polyBBox(pts);
      const dx = x - bb.x, dy = y - bb.y;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] + dx, pts[0][1] + dy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + dx, pts[i][1] + dy);
      ctx.closePath();
      ctx.fillStyle = (color || '#3b82f6') + '22';
      ctx.fill();
      ctx.strokeStyle = color || '#1f2937';
      ctx.lineWidth = 1.2 / scale;
      ctx.stroke();

      if (innerLines && innerLines.length) {
        ctx.lineWidth = 0.6 / scale;
        for (const il of innerLines) {
          if (!il.pts || il.pts.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(il.pts[0][0] + dx, il.pts[0][1] + dy);
          for (let i = 1; i < il.pts.length; i++) ctx.lineTo(il.pts[i][0] + dx, il.pts[i][1] + dy);
          if (il.closed) ctx.closePath();
          ctx.strokeStyle = il.color || '#666';
          ctx.stroke();
        }
      }
    }
    ctx.restore();
    return canvas.toDataURL('image/png');
  },

  _renderLayoutToDataURL(pxW = 1400, pxH = 1000) {
    if (!this.nestResult) return null;
    const settings = this.getSettings();
    const sheetIdx = Renderer.currentSheet || 0;
    const placements = this.nestResult.placements.filter(p => p.sheet === sheetIdx);

    // Match canvas aspect to sheet aspect so parts don't get squashed
    const aspect = settings.sheetW / settings.sheetH;
    if (aspect > pxW / pxH) pxH = Math.round(pxW / aspect);
    else                    pxW = Math.round(pxH * aspect);

    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pxW, pxH);

    const pad = 20;
    const scale = Math.min((pxW - pad*2) / settings.sheetW, (pxH - pad*2) / settings.sheetH);
    const ox = pad + ((pxW - pad*2) - settings.sheetW * scale) / 2;
    const oy = pad + ((pxH - pad*2) - settings.sheetH * scale) / 2;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    // Sheet boundary
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, settings.sheetW, settings.sheetH);

    // Margin dashed
    const m = settings.margin;
    ctx.strokeStyle = '#aabbff';
    ctx.setLineDash([4/scale, 4/scale]);
    ctx.lineWidth = 0.6 / scale;
    ctx.strokeRect(m, m, settings.sheetW - 2*m, settings.sheetH - 2*m);
    ctx.setLineDash([]);

    // Placements — solid outlines with light fills
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const pl of placements) {
      const { pts, x, y, color, innerLines } = pl;
      const bb = polyBBox(pts);
      const dx = x - bb.x, dy = y - bb.y;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] + dx, pts[0][1] + dy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + dx, pts[i][1] + dy);
      ctx.closePath();
      ctx.fillStyle = (color || '#3b82f6') + '22';
      ctx.fill();
      ctx.strokeStyle = color || '#1f2937';
      ctx.lineWidth = 1.2 / scale;
      ctx.stroke();

      if (innerLines && innerLines.length) {
        ctx.lineWidth = 0.6 / scale;
        for (const il of innerLines) {
          if (!il.pts || il.pts.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(il.pts[0][0] + dx, il.pts[0][1] + dy);
          for (let i = 1; i < il.pts.length; i++) ctx.lineTo(il.pts[i][0] + dx, il.pts[i][1] + dy);
          if (il.closed) ctx.closePath();
          ctx.strokeStyle = il.color || '#666';
          ctx.stroke();
        }
      }
    }
    ctx.restore();
    return canvas.toDataURL('image/png');
  },

  /* Main export entry point. Dispatches to Excel or PDF based on toggle. */
  async exportCostingReport() {
    const c = this._computeCosting();
    if (!c) {
      alert('Run nesting first before exporting a costing report.');
      return;
    }
    if (this._reportFmt === 'pdf') return this._exportReportPDF(c);
    return this._exportReportExcel(c);
  },

  _reportMeta(c) {
    const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const brand     = (document.getElementById('cost-brand')?.value || '').trim() || '';
    const article   = document.getElementById('cost-article').value.trim()   || '(unnamed)';
    const component = document.getElementById('cost-component').value.trim() || '(unspecified)';
    const material  = document.getElementById('cost-material').value.trim()  || '(unspecified)';
    const specs = this._collectSpecs();
    const ws = this._worksheets[this._activeWS];
    const sheetName = ws ? ws.name : 'Sheet 1';
    const slugBase = (brand ? brand + '_' : '') + article + '_' + component;
    const slug = slugBase.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,48) || 'costing';
    const productImage = this._productImage;
    return { dateStr, timeStr, brand, article, component, material, specs,
             sheetName, slug, d, pad, productImage };
  },

  /* ── EXCEL EXPORT (via ExcelJS) ──────────────────────────────────── */
  async _exportReportExcel(c) {
    if (typeof ExcelJS === 'undefined') {
      alert('Excel library failed to load. Check your internet connection or switch to PDF.');
      return;
    }
    const meta = this._reportMeta(c);
    const layoutDataURL = this._renderLayoutToDataURL(1400, 1000);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'NestForge Pro';
    wb.created = new Date();

    const ws = wb.addWorksheet('Costing Report', {
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 }
    });

    // ─── Column widths: 6 columns, each ~15 wide ─────────────────
    ws.columns = [
      { width: 20 }, { width: 15 }, { width: 18 },
      { width: 15 }, { width: 18 }, { width: 14 }
    ];

    // ── Style helpers ─────────────────────────────────────────────
    const COLORS = {
      brandOrange: 'FFEA580C',
      brandDark:   'FFC2410C',
      textDark:    'FF1F2937',
      textMuted:   'FF6B7280',
      bgLight:     'FFFAFAFA',
      bgStripe:    'FFF3F4F6',
      border:      'FFD1D5DB',
      borderDark:  'FF9CA3AF',
      green:       'FF16A34A',
      yellow:      'FFCA8A04',
      blue:        'FF2563EB',
    };
    const borderAll = (color=COLORS.border) => ({
      top:    { style: 'thin', color: { argb: color } },
      bottom: { style: 'thin', color: { argb: color } },
      left:   { style: 'thin', color: { argb: color } },
      right:  { style: 'thin', color: { argb: color } },
    });
    const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

    let r = 1;

    // ════════════════════════════════════════════════════════════════
    // SECTION 1: HEADER BANNER (brand + article + product image)
    // ════════════════════════════════════════════════════════════════
    // Row 1: brand name (if provided), else "COSTING REPORT"
    ws.mergeCells(r, 1, r, 4);
    const brandCell = ws.getCell(r, 1);
    brandCell.value = meta.brand || 'COSTING REPORT';
    brandCell.font = { bold: true, size: 22, color: { argb: 'FFFFFFFF' } };
    brandCell.fill = fill(COLORS.brandOrange);
    brandCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
    // Date/time on the right
    ws.mergeCells(r, 5, r, 6);
    const dateHeader = ws.getCell(r, 5);
    dateHeader.value = meta.dateStr + '  ' + meta.timeStr;
    dateHeader.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    dateHeader.fill = fill(COLORS.brandOrange);
    dateHeader.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
    ws.getRow(r).height = 36;
    r++;

    // Row 2: article name (subtitle under brand)
    ws.mergeCells(r, 1, r, 4);
    const articleCell = ws.getCell(r, 1);
    articleCell.value = meta.article;
    articleCell.font = { bold: true, size: 13, color: { argb: COLORS.textDark } };
    articleCell.fill = fill(COLORS.bgLight);
    articleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
    ws.mergeCells(r, 5, r, 6);
    const componentCell = ws.getCell(r, 5);
    componentCell.value = meta.component;
    componentCell.font = { italic: true, size: 11, color: { argb: COLORS.textMuted } };
    componentCell.fill = fill(COLORS.bgLight);
    componentCell.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
    ws.getRow(r).height = 22;
    r++;

    // Blank spacer row
    ws.getRow(r).height = 6;
    r++;

    // ════════════════════════════════════════════════════════════════
    // SECTION 2: PRODUCT IMAGE (if uploaded)
    // ════════════════════════════════════════════════════════════════
    if (meta.productImage) {
      // Reserve 12 rows for the image (roughly 200px tall)
      const imgRowStart = r;
      const imgRows = 12;
      for (let i = 0; i < imgRows; i++) ws.getRow(r + i).height = 17;

      try {
        const dataURL = meta.productImage.dataURL;
        const ext = dataURL.startsWith('data:image/png') ? 'png'
                  : dataURL.startsWith('data:image/jpeg') ? 'jpeg'
                  : dataURL.startsWith('data:image/jpg')  ? 'jpeg'
                  : 'png';
        const imageId = wb.addImage({ base64: dataURL.split(',')[1], extension: ext });
        // Compute display size maintaining aspect ratio, centered
        const maxW = 360, maxH = 200;
        const ratio = meta.productImage.width / meta.productImage.height;
        let dispW = maxW, dispH = maxW / ratio;
        if (dispH > maxH) { dispH = maxH; dispW = maxH * ratio; }
        // Center horizontally — col 2 start roughly mid-page
        ws.addImage(imageId, {
          tl: { col: 1.5, row: imgRowStart - 0.5 },
          ext: { width: dispW, height: dispH }
        });
      } catch (e) {
        console.warn('Could not embed product image:', e);
      }

      r += imgRows;
      ws.getRow(r).height = 6; r++;
    }

    // ════════════════════════════════════════════════════════════════
    // SECTION 3: KPI DASHBOARD (4 big tiles)
    // ════════════════════════════════════════════════════════════════
    const dashTitleRow = r;
    ws.mergeCells(r, 1, r, 6);
    const dashTitle = ws.getCell(r, 1);
    dashTitle.value = 'SUMMARY';
    dashTitle.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    dashTitle.fill = fill(COLORS.brandDark);
    dashTitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(r).height = 20;
    r++;

    // Dashboard row: 4 tiles (2 cols each), label on top, big value below
    const tiles = [
      { label: 'TOTAL COST',    value: '₹' + c.total.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}), color: COLORS.green },
      { label: 'PIECES',        value: String(c.placed), color: COLORS.blue },
      { label: 'UTILIZATION',   value: c.util.toFixed(1) + ' %', color: COLORS.brandOrange },
      { label: 'WASTAGE',       value: c.wastePct.toFixed(1) + ' %', color: COLORS.yellow },
    ];
    // Labels row
    const labelRow = r;
    for (let i = 0; i < 4; i++) {
      // Wait — only 6 cols but 4 tiles → use 1.5 cols each doesn't align.
      // Use: col 1-2, 3-4, 5-6... we have 3 groups of 2. Use 3 tiles instead, or
      // first three on this row. Or reorganize to 4x single column.
      // Use pairs of columns: 1-2, 3-4, 5-6 = only 3 pairs → 3 tiles.
      // Alternative: single-column tiles across 6 cols = 6 tiles possible.
      // Stick with layout: first two tiles span cols 1-3 and 4-6 (wide), then
      // second row of two more tiles cols 1-3 and 4-6. 2x2 grid.
    }
    // ── 2x2 tile grid ──────────────────────────────────────────────
    //   Row A: tile 1 (cols 1-3) | tile 2 (cols 4-6)
    //   Row B: tile 3 (cols 1-3) | tile 4 (cols 4-6)
    const paintTile = (startRow, startCol, endCol, label, value, valueColor) => {
      // Label row
      ws.mergeCells(startRow, startCol, startRow, endCol);
      const lc = ws.getCell(startRow, startCol);
      lc.value = label;
      lc.font = { bold: true, size: 9, color: { argb: COLORS.textMuted } };
      lc.alignment = { vertical: 'middle', horizontal: 'center' };
      lc.fill = fill(COLORS.bgLight);
      lc.border = {
        top:    { style: 'medium', color: { argb: valueColor } },
        left:   { style: 'thin',   color: { argb: COLORS.border } },
        right:  { style: 'thin',   color: { argb: COLORS.border } },
      };
      ws.getRow(startRow).height = 18;

      // Value row
      ws.mergeCells(startRow + 1, startCol, startRow + 1, endCol);
      const vc = ws.getCell(startRow + 1, startCol);
      vc.value = value;
      vc.font = { bold: true, size: 18, color: { argb: valueColor } };
      vc.alignment = { vertical: 'middle', horizontal: 'center' };
      vc.fill = fill(COLORS.bgLight);
      vc.border = {
        bottom: { style: 'thin', color: { argb: COLORS.border } },
        left:   { style: 'thin', color: { argb: COLORS.border } },
        right:  { style: 'thin', color: { argb: COLORS.border } },
      };
      ws.getRow(startRow + 1).height = 32;
    };

    paintTile(r, 1, 3, tiles[0].label, tiles[0].value, tiles[0].color);
    paintTile(r, 4, 6, tiles[1].label, tiles[1].value, tiles[1].color);
    r += 2;
    paintTile(r, 1, 3, tiles[2].label, tiles[2].value, tiles[2].color);
    paintTile(r, 4, 6, tiles[3].label, tiles[3].value, tiles[3].color);
    r += 2;

    ws.getRow(r).height = 8; r++;

    // ════════════════════════════════════════════════════════════════
    // SECTION HELPER — boxed section with title bar and bordered content
    // ════════════════════════════════════════════════════════════════
    const sectionTitle = (text) => {
      ws.mergeCells(r, 1, r, 6);
      const t = ws.getCell(r, 1);
      t.value = text;
      t.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      t.fill = fill(COLORS.brandOrange);
      t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(r).height = 20;
      r++;
    };

    // 2-column key-value row inside a section (k in col 1-2, v in col 3-6)
    const kvRow = (key, value, opts={}) => {
      const stripe = opts.stripe === true;
      const highlight = opts.highlight || null;
      ws.mergeCells(r, 1, r, 2);
      const kc = ws.getCell(r, 1);
      kc.value = key;
      kc.font = { bold: true, size: 10, color: { argb: COLORS.textMuted } };
      kc.alignment = { vertical: 'middle', indent: 1 };
      kc.fill = fill(stripe ? COLORS.bgStripe : 'FFFFFFFF');
      kc.border = {
        bottom: { style: 'thin', color: { argb: COLORS.border } },
        left:   { style: 'thin', color: { argb: COLORS.border } },
        right:  { style: 'hair', color: { argb: COLORS.border } },
      };
      ws.mergeCells(r, 3, r, 6);
      const vc = ws.getCell(r, 3);
      vc.value = value;
      vc.font = highlight
        ? { bold: true, size: 11, color: { argb: highlight } }
        : { size: 10, color: { argb: COLORS.textDark } };
      vc.alignment = { vertical: 'middle', indent: 1 };
      vc.fill = fill(stripe ? COLORS.bgStripe : 'FFFFFFFF');
      vc.border = {
        bottom: { style: 'thin', color: { argb: COLORS.border } },
        left:   { style: 'hair', color: { argb: COLORS.border } },
        right:  { style: 'thin', color: { argb: COLORS.border } },
      };
      ws.getRow(r).height = 18;
      r++;
    };

    // ════════════════════════════════════════════════════════════════
    // SECTION 4: IDENTITY
    // ════════════════════════════════════════════════════════════════
    sectionTitle('PRODUCT DETAILS');
    let stripe = false;
    if (meta.brand) { kvRow('Brand',     meta.brand,     { stripe }); stripe = !stripe; }
    kvRow('Article',   meta.article,   { stripe }); stripe = !stripe;
    kvRow('Component', meta.component, { stripe }); stripe = !stripe;
    kvRow('Material',  meta.material,  { stripe }); stripe = !stripe;
    kvRow('Sheet',     meta.sheetName, { stripe }); stripe = !stripe;
    ws.getRow(r).height = 8; r++;

    // ════════════════════════════════════════════════════════════════
    // SECTION 5: SHEET / MATERIAL
    // ════════════════════════════════════════════════════════════════
    sectionTitle('SHEET & MATERIAL');
    stripe = false;
    kvRow('Sheet size',       `${c.sheetW} × ${c.sheetH} mm`, { stripe }); stripe = !stripe;
    kvRow('Sheets used',      c.sheetCount, { stripe }); stripe = !stripe;
    kvRow('Total area',       c.sheetAreaInUnit.toFixed(3) + ' ' + c.uLbl, { stripe }); stripe = !stripe;
    kvRow('Margin / Gap',     `${c.margin} mm / ${c.gap} mm`, { stripe }); stripe = !stripe;
    ws.getRow(r).height = 8; r++;

    // ════════════════════════════════════════════════════════════════
    // SECTION 6: PRODUCTION
    // ════════════════════════════════════════════════════════════════
    sectionTitle('PRODUCTION');
    stripe = false;
    kvRow('Pieces placed',    c.placed, { stripe }); stripe = !stripe;
    if (c.mode === 'pair') {
      kvRow('Pairs produced', Number.isInteger(c.count) ? c.count : c.count.toFixed(2), { stripe });
      stripe = !stripe;
    }
    kvRow('Utilization',      c.util.toFixed(1) + ' %', { stripe, highlight: COLORS.brandOrange });
    stripe = !stripe;
    kvRow('Wastage',          c.wastePct.toFixed(1) + ' %', { stripe, highlight: COLORS.yellow });
    stripe = !stripe;
    ws.getRow(r).height = 8; r++;

    // ════════════════════════════════════════════════════════════════
    // SECTION 7: COSTING
    // ════════════════════════════════════════════════════════════════
    sectionTitle('COSTING');
    stripe = false;
    kvRow('Price',                `₹${c.price.toFixed(2)} per ${c.uLbl}`, { stripe }); stripe = !stripe;
    kvRow('Norm basis',           'Per ' + c.mode.toUpperCase(), { stripe }); stripe = !stripe;
    kvRow('Norm (gross)',         c.norm.toFixed(3) + ' ' + c.uLbl + ' / ' + c.mode, { stripe });
    stripe = !stripe;
    kvRow('Cost per ' + c.mode,   '₹' + c.costPer.toFixed(2), { stripe, highlight: COLORS.green });
    stripe = !stripe;
    kvRow('TOTAL RUN COST',       '₹' + c.total.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}),
          { stripe, highlight: COLORS.green });
    stripe = !stripe;
    ws.getRow(r).height = 8; r++;

    // ════════════════════════════════════════════════════════════════
    // SECTION 8: PART BREAKDOWN TABLE
    // ════════════════════════════════════════════════════════════════
    sectionTitle('PART BREAKDOWN — Net vs Gross Norm');
    // Table header row — now 8 columns:
    //   Part | Qty | Net/piece | Gross/piece | Waste/piece | Net total | Gross total | Util%
    const pbHeaders = [
      'Part Name', 'Qty',
      'Net/' + c.mode + ' (' + c.uLbl + ')',
      'Gross/' + c.mode + ' (' + c.uLbl + ')',
      'Waste/' + c.mode + ' (' + c.uLbl + ')',
      'Net Total (' + c.uLbl + ')',
      'Gross Total (' + c.uLbl + ')',
      'Util %',
    ];
    const NCOL = pbHeaders.length;
    const thRow = ws.getRow(r);
    for (let i = 0; i < NCOL; i++) {
      const cell = ws.getCell(r, i + 1);
      cell.value = pbHeaders[i];
      cell.font = { bold: true, size: 10, color: { argb: COLORS.textDark } };
      cell.fill = fill(COLORS.bgStripe);
      cell.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'right', indent: 1 };
      cell.border = borderAll(COLORS.borderDark);
    }
    ws.getRow(r).height = 20;
    r++;

    const totalPartArea = c.partBreakdown.reduce((s, p) => s + (p.netAreaUnit || p.areaUnit), 0) || 1;
    let pbStripe = false;
    for (const p of c.partBreakdown) {
      // Backwards-compat: older breakdowns might lack the new fields
      const netTot = p.netAreaUnit != null ? p.netAreaUnit : p.areaUnit;
      const grossTot = p.grossAreaUnit != null ? p.grossAreaUnit : netTot;
      const netPer = p.netNormPer != null ? p.netNormPer : (netTot / p.count);
      const grossPer = p.grossNormPer != null ? p.grossNormPer : netPer;
      const wastePer = p.wasteNormPer != null ? p.wasteNormPer : (grossPer - netPer);
      const utilPct = p.utilizationPct != null ? p.utilizationPct : 100;
      const dispName = (typeof App !== 'undefined' && App.getDisplayName)
        ? App.getDisplayName(p.name) : p.name;
      const vals = [
        dispName, p.count,
        netPer.toFixed(3),
        grossPer.toFixed(3),
        wastePer.toFixed(3),
        netTot.toFixed(3),
        grossTot.toFixed(3),
        utilPct.toFixed(1) + '%',
      ];
      for (let i = 0; i < NCOL; i++) {
        const cell = ws.getCell(r, i + 1);
        cell.value = vals[i];
        cell.font = { size: 10, color: { argb: COLORS.textDark }, bold: i === 0 };
        cell.fill = fill(pbStripe ? COLORS.bgStripe : 'FFFFFFFF');
        cell.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'right', indent: 1 };
        cell.border = borderAll(COLORS.border);
      }
      ws.getRow(r).height = 18;
      pbStripe = !pbStripe;
      r++;
    }
    ws.getRow(r).height = 8; r++;

    // ════════════════════════════════════════════════════════════════
    // SECTION 9: SPECIFICATIONS (if any)
    // ════════════════════════════════════════════════════════════════
    if (meta.specs.length) {
      sectionTitle('SPECIFICATIONS');
      stripe = false;
      for (const s of meta.specs) {
        kvRow(s.key || '(field)', s.value, { stripe });
        stripe = !stripe;
      }
      ws.getRow(r).height = 8; r++;
    }

    // ════════════════════════════════════════════════════════════════
    // SECTION 10: NESTED LAYOUT IMAGE
    // ════════════════════════════════════════════════════════════════
    if (layoutDataURL) {
      sectionTitle('NESTED LAYOUT');
      const imageId = wb.addImage({ base64: layoutDataURL.split(',')[1], extension: 'png' });
      ws.addImage(imageId, {
        tl: { col: 0, row: r - 1 },
        ext: { width: 640, height: 450 }
      });
      for (let i = 0; i < 26; i++) ws.getRow(r + i).height = 18;
      r += 26;
    }

    // ════════════════════════════════════════════════════════════════
    // FOOTER
    // ════════════════════════════════════════════════════════════════
    ws.mergeCells(r, 1, r, 6);
    const footer = ws.getCell(r, 1);
    footer.value = 'Generated by NestForge Pro — ' + meta.dateStr + ' ' + meta.timeStr;
    footer.font = { italic: true, size: 9, color: { argb: COLORS.textMuted } };
    footer.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(r).height = 18;
    r++;

    // ════════════════════════════════════════════════════════════════
    // SHEET 2: RAW DATA (unchanged — used for formulas/pivot)
    // ════════════════════════════════════════════════════════════════
    const ws2 = wb.addWorksheet('Raw Data');
    ws2.columns = [ { header: 'Field', key: 'k', width: 24 }, { header: 'Value', key: 'v', width: 32 } ];
    ws2.addRows([
      ['brand', meta.brand], ['article', meta.article], ['component', meta.component], ['material', meta.material],
      ['date', meta.dateStr], ['time', meta.timeStr], ['sheet_name', meta.sheetName],
      ['sheet_w_mm', c.sheetW], ['sheet_h_mm', c.sheetH], ['sheet_count', c.sheetCount],
      ['margin_mm', c.margin], ['gap_mm', c.gap],
      ['pieces', c.placed], ['count_' + c.mode, c.count],
      ['util_pct', +c.util.toFixed(3)], ['waste_pct', +c.wastePct.toFixed(3)],
      ['unit', c.uLbl], ['price_per_unit', c.price],
      ['norm', +c.norm.toFixed(4)], ['cost_per_' + c.mode, +c.costPer.toFixed(2)],
      ['total_run_cost', +c.total.toFixed(2)],
    ]);
    // Per-part rows in raw data
    for (const p of c.partBreakdown) {
      const safe = String(p.name).replace(/[^a-zA-Z0-9]/g, '_');
      ws2.addRow(['part_' + safe + '__qty', p.count]);
      const netTot = p.netAreaUnit != null ? p.netAreaUnit : p.areaUnit;
      const grossTot = p.grossAreaUnit != null ? p.grossAreaUnit : netTot;
      ws2.addRow(['part_' + safe + '__net_total_' + c.uLbl, +netTot.toFixed(4)]);
      ws2.addRow(['part_' + safe + '__gross_total_' + c.uLbl, +grossTot.toFixed(4)]);
      if (p.netNormPer != null) {
        ws2.addRow(['part_' + safe + '__net_per_' + c.mode, +p.netNormPer.toFixed(4)]);
        ws2.addRow(['part_' + safe + '__gross_per_' + c.mode, +p.grossNormPer.toFixed(4)]);
        ws2.addRow(['part_' + safe + '__waste_per_' + c.mode, +p.wasteNormPer.toFixed(4)]);
        ws2.addRow(['part_' + safe + '__util_pct', +p.utilizationPct.toFixed(2)]);
        ws2.addRow(['part_' + safe + '__cost_per_' + c.mode, +p.costPer.toFixed(2)]);
      }
    }
    for (const s of meta.specs) ws2.addRow(['spec: ' + s.key, s.value]);
    // Style header
    ws2.getRow(1).font = { bold: true };
    ws2.getRow(1).fill = fill(COLORS.bgStripe);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${meta.slug}_costing_${meta.d.getFullYear()}${meta.pad(meta.d.getMonth()+1)}${meta.pad(meta.d.getDate())}.xlsx`;
    a.click();
  },

  /* ── PDF EXPORT (via jsPDF) — matches Excel layout ──────────────── */
  _exportReportPDF(c) {
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      alert('PDF library failed to load. Check your internet connection or switch to Excel.');
      return;
    }
    const { jsPDF } = window.jspdf;
    const meta = this._reportMeta(c);
    const layoutDataURL = this._renderLayoutToDataURL(1400, 1000);

    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297;
    const M = 12;
    const CW = W - 2 * M;   // content width
    let y = 0;

    // Color palette (matches Excel)
    const C = {
      brandOrange: [234, 88, 12],
      brandDark:   [194, 65, 12],
      textDark:    [31, 41, 55],
      textMuted:   [107, 114, 128],
      bgLight:     [250, 250, 250],
      bgStripe:    [243, 244, 246],
      border:      [209, 213, 219],
      borderDark:  [156, 163, 175],
      green:       [22, 163, 74],
      yellow:      [202, 138, 4],
      blue:        [37, 99, 235],
      white:       [255, 255, 255],
    };

    const setFill = ([r,g,b]) => pdf.setFillColor(r, g, b);
    const setText = ([r,g,b]) => pdf.setTextColor(r, g, b);
    const setDraw = ([r,g,b]) => pdf.setDrawColor(r, g, b);

    const ensureSpace = (needed) => {
      if (y + needed > H - M) {
        pdf.addPage();
        y = M;
      }
    };

    // ════════════════════════════════════════════════════════════════
    // HEADER BANNER
    // ════════════════════════════════════════════════════════════════
    setFill(C.brandOrange);
    pdf.rect(0, 0, W, 22, 'F');
    setText(C.white);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(20);
    pdf.text(meta.brand || 'COSTING REPORT', M, 11);
    pdf.setFontSize(10);
    pdf.text(meta.dateStr + '   ' + meta.timeStr, W - M, 11, { align: 'right' });
    // Article subtitle
    pdf.setFontSize(12);
    pdf.text(meta.article, M, 18);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.text(meta.component, W - M, 18, { align: 'right' });
    y = 22;

    // Article subheader band
    setFill(C.bgLight);
    pdf.rect(0, y, W, 4, 'F');
    y += 6;

    // ════════════════════════════════════════════════════════════════
    // PRODUCT IMAGE (if uploaded)
    // ════════════════════════════════════════════════════════════════
    if (meta.productImage) {
      try {
        const maxImgH = 55;
        const ratio = meta.productImage.width / meta.productImage.height;
        let imgH = maxImgH;
        let imgW = imgH * ratio;
        if (imgW > CW * 0.8) { imgW = CW * 0.8; imgH = imgW / ratio; }
        ensureSpace(imgH + 4);
        const imgX = (W - imgW) / 2;
        // Detect format from data URL
        const fmt = meta.productImage.dataURL.startsWith('data:image/png') ? 'PNG' : 'JPEG';
        pdf.addImage(meta.productImage.dataURL, fmt, imgX, y, imgW, imgH, undefined, 'FAST');
        y += imgH + 4;
      } catch (e) {
        console.warn('Could not embed product image:', e);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // KPI DASHBOARD — 4 tiles in 2x2 grid
    // ════════════════════════════════════════════════════════════════
    ensureSpace(36);
    // Section header
    setFill(C.brandDark);
    pdf.rect(M, y, CW, 6, 'F');
    setText(C.white);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text('SUMMARY', M + 2, y + 4);
    y += 7;

    const drawTile = (tx, ty, tw, th, label, value, accentColor) => {
      // Top accent bar
      setFill(accentColor);
      pdf.rect(tx, ty, tw, 1.2, 'F');
      // Body bg
      setFill(C.bgLight);
      pdf.rect(tx, ty + 1.2, tw, th - 1.2, 'F');
      // Borders
      setDraw(C.border);
      pdf.setLineWidth(0.2);
      pdf.rect(tx, ty, tw, th);
      // Label
      setText(C.textMuted);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7);
      pdf.text(label, tx + tw/2, ty + 5, { align: 'center' });
      // Value
      setText(accentColor);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(14);
      pdf.text(value, tx + tw/2, ty + 13, { align: 'center' });
    };

    const tileW = (CW - 4) / 2;
    const tileH = 18;
    drawTile(M, y, tileW, tileH, 'TOTAL COST',
      '\u20B9' + c.total.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}),
      C.green);
    drawTile(M + tileW + 4, y, tileW, tileH, 'PIECES', String(c.placed), C.blue);
    y += tileH + 2;
    drawTile(M, y, tileW, tileH, 'UTILIZATION',
      c.util.toFixed(1) + ' %', C.brandOrange);
    drawTile(M + tileW + 4, y, tileW, tileH, 'WASTAGE',
      c.wastePct.toFixed(1) + ' %', C.yellow);
    y += tileH + 6;

    // ════════════════════════════════════════════════════════════════
    // SECTION HELPERS
    // ════════════════════════════════════════════════════════════════
    const section = (title) => {
      ensureSpace(10);
      setFill(C.brandOrange);
      pdf.rect(M, y, CW, 6, 'F');
      setText(C.white);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(title, M + 2, y + 4);
      y += 7;
    };

    let stripe = false;
    const kvRow = (key, value, highlight = null) => {
      ensureSpace(6);
      const rowH = 5.5;
      // Background
      setFill(stripe ? C.bgStripe : C.white);
      pdf.rect(M, y - 1, CW, rowH, 'F');
      // Border
      setDraw(C.border);
      pdf.setLineWidth(0.1);
      pdf.line(M, y + rowH - 1, M + CW, y + rowH - 1);
      // Key
      setText(C.textMuted);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(String(key), M + 2, y + 2.5);
      // Value
      if (highlight) {
        setText(highlight);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(10);
      } else {
        setText(C.textDark);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
      }
      pdf.text(String(value), M + 55, y + 2.5);
      y += rowH;
      stripe = !stripe;
    };

    // ════════════════════════════════════════════════════════════════
    // PRODUCT DETAILS
    // ════════════════════════════════════════════════════════════════
    section('PRODUCT DETAILS');
    stripe = false;
    if (meta.brand) kvRow('Brand', meta.brand);
    kvRow('Article',   meta.article);
    kvRow('Component', meta.component);
    kvRow('Material',  meta.material);
    kvRow('Sheet',     meta.sheetName);
    y += 3;

    // ════════════════════════════════════════════════════════════════
    // SHEET & MATERIAL
    // ════════════════════════════════════════════════════════════════
    section('SHEET & MATERIAL');
    stripe = false;
    kvRow('Sheet size',    `${c.sheetW} \u00D7 ${c.sheetH} mm`);
    kvRow('Sheets used',   String(c.sheetCount));
    kvRow('Total area',    c.sheetAreaInUnit.toFixed(3) + ' ' + c.uLbl);
    kvRow('Margin / Gap',  `${c.margin} mm / ${c.gap} mm`);
    y += 3;

    // ════════════════════════════════════════════════════════════════
    // PRODUCTION
    // ════════════════════════════════════════════════════════════════
    section('PRODUCTION');
    stripe = false;
    kvRow('Pieces placed', String(c.placed));
    if (c.mode === 'pair') kvRow('Pairs produced',
      Number.isInteger(c.count) ? String(c.count) : c.count.toFixed(2));
    kvRow('Utilization',   c.util.toFixed(1) + ' %', C.brandOrange);
    kvRow('Wastage',       c.wastePct.toFixed(1) + ' %', C.yellow);
    y += 3;

    // ════════════════════════════════════════════════════════════════
    // COSTING
    // ════════════════════════════════════════════════════════════════
    section('COSTING');
    stripe = false;
    kvRow('Price',              `\u20B9${c.price.toFixed(2)} per ${c.uLbl}`);
    kvRow('Norm basis',         'Per ' + c.mode.toUpperCase());
    kvRow('Norm (gross)',       c.norm.toFixed(3) + ' ' + c.uLbl + ' / ' + c.mode);
    kvRow('Cost per ' + c.mode, '\u20B9' + c.costPer.toFixed(2), C.green);
    // Highlighted total row
    ensureSpace(10);
    setFill(C.green);
    pdf.rect(M, y, CW, 8, 'F');
    setText(C.white);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('TOTAL RUN COST', M + 2, y + 5);
    pdf.text('\u20B9' + c.total.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}),
             W - M - 2, y + 5, { align: 'right' });
    y += 10;
    stripe = false;

    // ════════════════════════════════════════════════════════════════
    // PART BREAKDOWN TABLE
    // ════════════════════════════════════════════════════════════════
    section('PART BREAKDOWN — Net vs Gross');
    // Table header — 6 columns: Part | Qty | Net/per | Gross/per | Waste/per | Util%
    ensureSpace(8);
    setFill(C.bgStripe);
    pdf.rect(M, y, CW, 6, 'F');
    setDraw(C.borderDark);
    pdf.setLineWidth(0.25);
    pdf.rect(M, y, CW, 6);
    setText(C.textDark);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7.5);
    const colX = [M + 2, M + CW*0.36, M + CW*0.50, M + CW*0.65, M + CW*0.80, M + CW*0.95];
    pdf.text('Part Name', colX[0], y + 4);
    pdf.text('Qty', colX[1], y + 4, { align: 'right' });
    pdf.text('Net/' + c.mode, colX[2], y + 4, { align: 'right' });
    pdf.text('Gross/' + c.mode, colX[3], y + 4, { align: 'right' });
    pdf.text('Waste/' + c.mode, colX[4], y + 4, { align: 'right' });
    pdf.text('Util%', colX[5], y + 4, { align: 'right' });
    y += 6;

    let pbStripe = false;
    for (const p of c.partBreakdown) {
      ensureSpace(6);
      const rowH = 5.5;
      setFill(pbStripe ? C.bgStripe : C.white);
      pdf.rect(M, y, CW, rowH, 'F');
      setDraw(C.border);
      pdf.setLineWidth(0.1);
      pdf.line(M, y + rowH, M + CW, y + rowH);
      setText(C.textDark);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8.5);
      const dispName = (typeof App !== 'undefined' && App.getDisplayName)
        ? App.getDisplayName(p.name) : p.name;
      pdf.text(String(dispName).slice(0, 24), colX[0], y + 3.5);
      pdf.setFont('helvetica', 'normal');
      const netTot = p.netAreaUnit != null ? p.netAreaUnit : p.areaUnit;
      const netPer = p.netNormPer != null ? p.netNormPer : (netTot / p.count);
      const grossPer = p.grossNormPer != null ? p.grossNormPer : netPer;
      const wastePer = p.wasteNormPer != null ? p.wasteNormPer : (grossPer - netPer);
      const utilPct = p.utilizationPct != null ? p.utilizationPct : 100;
      pdf.text(String(p.count), colX[1], y + 3.5, { align: 'right' });
      pdf.text(netPer.toFixed(3), colX[2], y + 3.5, { align: 'right' });
      pdf.text(grossPer.toFixed(3), colX[3], y + 3.5, { align: 'right' });
      pdf.text(wastePer.toFixed(3), colX[4], y + 3.5, { align: 'right' });
      pdf.text(utilPct.toFixed(0) + '%', colX[5], y + 3.5, { align: 'right' });
      y += rowH;
      pbStripe = !pbStripe;
    }
    y += 4;

    // ════════════════════════════════════════════════════════════════
    // SPECIFICATIONS
    // ════════════════════════════════════════════════════════════════
    if (meta.specs.length) {
      section('SPECIFICATIONS');
      stripe = false;
      for (const s of meta.specs) kvRow(s.key || '(field)', s.value);
      y += 3;
    }

    // ════════════════════════════════════════════════════════════════
    // NESTED LAYOUT IMAGE
    // ════════════════════════════════════════════════════════════════
    if (layoutDataURL) {
      const imgW = CW;
      const imgH = imgW * (1000/1400);
      ensureSpace(imgH + 12);
      section('NESTED LAYOUT');
      pdf.addImage(layoutDataURL, 'PNG', M, y, imgW, imgH, undefined, 'FAST');
      y += imgH + 4;
    }

    // ════════════════════════════════════════════════════════════════
    // FOOTER on every page
    // ════════════════════════════════════════════════════════════════
    const pageCount = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      pdf.setPage(i);
      setText(C.textMuted);
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(8);
      pdf.text('NestForge Pro  —  ' + meta.dateStr + ' ' + meta.timeStr, M, H - 5);
      pdf.text(`Page ${i} / ${pageCount}`, W - M, H - 5, { align: 'right' });
    }

    pdf.save(`${meta.slug}_costing_${meta.d.getFullYear()}${meta.pad(meta.d.getMonth()+1)}${meta.pad(meta.d.getDate())}.pdf`);
  },
};



