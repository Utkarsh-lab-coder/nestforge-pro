/*
 * NestForge Pro — Canvas renderer — draws sheet, zone overlay, placements, selected-highlight
 *
 * Original location: lines 13269..13777 of nestforge-pro.html (509 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const Renderer = {
  canvas: null, ctx: null,
  offsetX: 0, offsetY: 0, zoom: 1,
  showGrid: true, currentSheet: 0,
  nestResult: null, parts: [],
  sheetW: 1200, sheetH: 600,
  sheetOutline: null,   // null = rectangle; otherwise [[x,y],...] hide polygon
  sheetZones: null,     // array of polylines (zone boundary curves, mm)
  sheetLabels: null,    // array of {x,y,text,rot} zone labels (mm)
  showZones: false,     // toggle for zone overlay
  selectedPlacementIdx: -1,  // index of currently-selected placement for replace UI
  defects: [],          // [{x,y,r,type,id}, ...]

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.initPan();
  },

  resize() {
    const wrap = this.canvas.parentElement;
    this.canvas.width = wrap.clientWidth;
    this.canvas.height = wrap.clientHeight;
    this.draw();
  },

  initPan() {
    let dragging = false, lastX, lastY;
    let pressX = 0, pressY = 0, totalDrag = 0;
    let placementDragState = null;  // non-null when dragging a selected placement

    // Helper: convert screen (clientX,Y) to sheet-space mm
    const toSheet = (cx, cy) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (cx - rect.left - this.offsetX) / this.zoom,
        y: (cy - rect.top  - this.offsetY) / this.zoom,
      };
    };
    // Helper: point-in-placement hit test → returns placement index or -1
    const hitTestPlacement = (sx, sy) => {
      if (!App.nestResult || !App.nestResult.placements) return -1;
      const pls = App.nestResult.placements;
      for (let i = pls.length - 1; i >= 0; i--) {
        const pl = pls[i];
        const wp = pl.worldPoly || (pl.pts && pl.pts.map(p => [p[0]+pl.x, p[1]+pl.y]));
        if (!wp || wp.length < 3) continue;
        let inside = false;
        for (let ii=0, jj=wp.length-1; ii<wp.length; jj=ii++) {
          const yi = wp[ii][1], yj = wp[jj][1];
          if ((yi > sy) !== (yj > sy)) {
            const xi = wp[ii][0], xj = wp[jj][0];
            if (sx < (xj-xi)*(sy-yi)/(yj-yi+1e-12)+xi) inside = !inside;
          }
        }
        if (inside) return i;
      }
      return -1;
    };

    this.canvas.addEventListener('mousedown', e => {
      // Button codes: 0=left, 1=middle, 2=right
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      const isRightClick = e.button === 2;

      // Right-click on ANY placement → duplicate + drag the copy
      if (isRightClick && App && App.nestResult && App.nestResult.placements) {
        const s = toSheet(e.clientX, e.clientY);
        const hitIdx = hitTestPlacement(s.x, s.y);
        if (hitIdx >= 0) {
          const newIdx = App._duplicatePlacement(hitIdx);
          if (newIdx >= 0) {
            App._selectedPlacementIdx = newIdx;
            // Inherit current edit mode; default to 'move' if none set
            if (!App._placementEditMode || App._placementEditMode === 'none') {
              App._placementEditMode = 'move';
            }
            Renderer.selectedPlacementIdx = newIdx;
            placementDragState = App._beginPlacementDrag(s.x, s.y, true /*isCopy*/);
            pressX = e.clientX; pressY = e.clientY; totalDrag = 0;
            e.preventDefault();
            return;
          }
        }
        // Right-click on empty area — swallow event (don't pan on right-click)
        e.preventDefault();
        return;
      }

      // Left-click on SELECTED placement in edit mode → normal drag
      if (!isRightClick && App && App._selectedPlacementIdx != null && App._selectedPlacementIdx >= 0
          && App._placementEditMode && App._placementEditMode !== 'none') {
        const s = toSheet(e.clientX, e.clientY);
        const hitIdx = hitTestPlacement(s.x, s.y);
        if (hitIdx === App._selectedPlacementIdx) {
          placementDragState = App._beginPlacementDrag(s.x, s.y, false);
          pressX = e.clientX; pressY = e.clientY; totalDrag = 0;
          e.preventDefault();
          return;
        }
      }
      // Otherwise: standard pan
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      pressX = e.clientX; pressY = e.clientY; totalDrag = 0;
      this.canvas.classList.add('panning');
    });
    // Suppress browser context menu on canvas — right-click is our duplicate-drag
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('mouseup', e => {
      // Placement drag end
      if (placementDragState) {
        App._endPlacementDrag(placementDragState);
        placementDragState = null;
        return;
      }
      if (dragging) {
        // If this was a CLICK (minimal drag) and defect edit mode is on,
        // convert screen coords to sheet-space mm and add/remove defect.
        if (totalDrag < 5 && App && App._defectEditMode) {
          const rect = this.canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          // Inverse of the draw() transform: translate(ox,oy) then scale(zoom)
          const sheetX = (mx - this.offsetX) / this.zoom;
          const sheetY = (my - this.offsetY) / this.zoom;
          App._onDefectClick(sheetX, sheetY);
        } else if (totalDrag < 5 && App && App.nestResult && !App._defectEditMode) {
          // Placement-click handler: select a placed part for replacement/edit
          const rect = this.canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const sheetX = (mx - this.offsetX) / this.zoom;
          const sheetY = (my - this.offsetY) / this.zoom;
          console.log('[Replace] click at sheet (' + sheetX.toFixed(1) + ',' + sheetY.toFixed(1) + '), placements=' + (App.nestResult.placements ? App.nestResult.placements.length : 0));
          App._onPlacementClick(sheetX, sheetY);
        }
      }
      dragging = false;
      this.canvas.classList.remove('panning');
    });
    // ALSO add direct click handler as fallback (in case mouseup misses)
    this.canvas.addEventListener('click', e => {
      if (App && App._defectEditMode) return;  // handled by mouseup path
      if (!App || !App.nestResult) return;
      // Only handle if mouseup didn't already fire (totalDrag tracker would be reset)
      if (this._lastClickHandled && Date.now() - this._lastClickHandled < 100) return;
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const sheetX = (mx - this.offsetX) / this.zoom;
      const sheetY = (my - this.offsetY) / this.zoom;
      console.log('[Replace-click] sheet (' + sheetX.toFixed(1) + ',' + sheetY.toFixed(1) + ')');
      App._onPlacementClick(sheetX, sheetY);
      this._lastClickHandled = Date.now();
    });
    window.addEventListener('mousemove', e => {
      // Placement drag in progress — update position/rotation
      if (placementDragState) {
        const s = toSheet(e.clientX, e.clientY);
        totalDrag += Math.abs(e.clientX - lastX || 0) + Math.abs(e.clientY - lastY || 0);
        App._updatePlacementDrag(s.x, s.y, placementDragState);
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      totalDrag += Math.abs(dx) + Math.abs(dy);
      // If defect edit mode, don't pan on drag — reserve drag for future defect-resize feature
      if (!(App && App._defectEditMode)) {
        this.offsetX += dx; this.offsetY += dy;
      }
      lastX = e.clientX; lastY = e.clientY;
      this.draw();
    });
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      this.offsetX = mx - factor * (mx - this.offsetX);
      this.offsetY = my - factor * (my - this.offsetY);
      this.zoom *= factor;
      this.draw();
      document.getElementById('zoom-val').textContent = Math.round(this.zoom*100)+'%';
    }, { passive: false });
  },

  /* Draw subtle horizontal lines between alternating rotation groups
     so the cutting lanes are visible on the canvas.                 */
  _drawFlowLanes(placements) {
    if (!placements.length) return;
    const { ctx, zoom } = this;

    // Group placements by rotation: find Y boundaries between rot groups
    const rot0 = placements.filter(p => p.rotation === 0 || p.rotation === 90);
    const rot1 = placements.filter(p => p.rotation === 180 || p.rotation === 270);
    if (!rot0.length || !rot1.length) return;

    // Collect all "row bottom" Y values as boundaries between lanes
    // Approximate: find Y values where rotation changes between consecutive placements
    const sorted = [...placements].sort((a,b) => a.y - b.y);
    const laneLines = new Set();
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].rotation !== sorted[i-1].rotation) {
        const yLine = (sorted[i-1].y + polyBBox(sorted[i-1].pts).h / 2 +
                       sorted[i].y + polyBBox(sorted[i].pts).y) / 2;
        laneLines.add(Math.round(yLine * 2) / 2); // round to 0.5mm
      }
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(34,197,94,0.3)';
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([6/zoom, 4/zoom]);
    for (const y of laneLines) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.sheetW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  },

  fitView() {
    const cw = this.canvas.width, ch = this.canvas.height;
    const pad = 60;
    const scaleX = (cw - pad*2) / this.sheetW;
    const scaleY = (ch - pad*2) / this.sheetH;
    this.zoom = Math.min(scaleX, scaleY);
    this.offsetX = (cw - this.sheetW * this.zoom) / 2;
    this.offsetY = (ch - this.sheetH * this.zoom) / 2;
    document.getElementById('zoom-val').textContent = Math.round(this.zoom*100)+'%';
    this.draw();
  },

  draw() {
    const { canvas: cv, ctx, zoom, offsetX: ox, offsetY: oy } = this;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(zoom, zoom);

    // Sheet background
    if (this.sheetOutline && this.sheetOutline.length >= 3) {
      // Leather hide / custom polygon sheet
      ctx.fillStyle = '#fff7ed';  // cream/tan tint for leather
      ctx.beginPath();
      for (let i = 0; i < this.sheetOutline.length; i++) {
        const [x, y] = this.sheetOutline[i];
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#b58a5a';
      ctx.lineWidth = 2 / zoom;
      ctx.stroke();
      // Fill BG outside outline back to a neutral color so bbox area looks clean
      // (already handled by canvas clear + zoom transform)
    } else {
      // Rectangle sheet — solid white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.sheetW, this.sheetH);
      ctx.strokeStyle = '#aaaacc';
      ctx.lineWidth = 2 / zoom;
      ctx.strokeRect(0, 0, this.sheetW, this.sheetH);
    }

    // ── Norm Calc native decoration (when user clicked "Apply to Canvas") ──
    // Draws all the Norm Calc visual decorations natively on the main canvas:
    //   • 1cm graph-paper grid covering the parallelogram region
    //   • Dashed blue parallelogram outline
    //   • Red dimension arrows on top + right with mm labels
    //   • Title text at top
    //   • NORM BREAKDOWN table at bottom with stat rows
    // All scales perfectly with zoom because it's drawn natively (not bitmap).
    if (this.normCalcDecoration) {
      const dec = this.normCalcDecoration;
      const ss = dec.sideSpace || 0;
      const ts = dec.titleSpace || 0;
      // Parallelogram region inside the sheet
      const px0 = ss;
      const py0 = ts;
      const px1 = ss + dec.paraW;
      const py1 = ts + dec.paraH;

      // ── 1cm grid lines (graph paper) inside parallelogram region ──
      ctx.save();
      ctx.strokeStyle = '#d0d8e8';
      ctx.lineWidth = 0.5 / zoom;
      const step = dec.gridStep || 10;
      // Vertical lines
      for (let x = px0; x <= px1 + 0.001; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, py0);
        ctx.lineTo(x, py1);
        ctx.stroke();
      }
      // Horizontal lines
      for (let y = py0; y <= py1 + 0.001; y += step) {
        ctx.beginPath();
        ctx.moveTo(px0, y);
        ctx.lineTo(px1, y);
        ctx.stroke();
      }
      ctx.restore();

      // ── Dashed blue parallelogram outline ──
      ctx.save();
      ctx.strokeStyle = '#3a6ea5';
      ctx.lineWidth = 1.5 / zoom;
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.strokeRect(px0, py0, dec.paraW, dec.paraH);
      ctx.restore();

      // ── Red dimension arrows ──
      // Top arrow: horizontal, with "{paraW} mm" label centered above
      // Right arrow: vertical, with "{paraH} mm" label rotated 90° to the right
      ctx.save();
      ctx.strokeStyle = '#cc3333';
      ctx.fillStyle = '#cc3333';
      ctx.lineWidth = 0.8 / zoom;
      const arrowSize = 6 / zoom;
      const labelOff = ts * 0.45;
      // Top horizontal dimension
      const topY = Math.max(py0 - labelOff, 4 / zoom);
      ctx.beginPath();
      ctx.moveTo(px0, topY);
      ctx.lineTo(px1, topY);
      ctx.stroke();
      // Arrowheads at both ends
      ctx.beginPath();
      ctx.moveTo(px0, topY);
      ctx.lineTo(px0 + arrowSize, topY - arrowSize / 2);
      ctx.lineTo(px0 + arrowSize, topY + arrowSize / 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px1, topY);
      ctx.lineTo(px1 - arrowSize, topY - arrowSize / 2);
      ctx.lineTo(px1 - arrowSize, topY + arrowSize / 2);
      ctx.closePath();
      ctx.fill();
      // Width label centered above arrow — 14px screen size constant
      ctx.font = `bold ${14 / zoom}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${(dec.paraW / 10).toFixed(1)} cm`, (px0 + px1) / 2, topY - 2 / zoom);

      // Right vertical dimension
      const rightX = Math.min(px1 + ss * 0.4, this.sheetW - 4 / zoom);
      ctx.beginPath();
      ctx.moveTo(rightX, py0);
      ctx.lineTo(rightX, py1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(rightX, py0);
      ctx.lineTo(rightX - arrowSize / 2, py0 + arrowSize);
      ctx.lineTo(rightX + arrowSize / 2, py0 + arrowSize);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(rightX, py1);
      ctx.lineTo(rightX - arrowSize / 2, py1 - arrowSize);
      ctx.lineTo(rightX + arrowSize / 2, py1 - arrowSize);
      ctx.closePath();
      ctx.fill();
      // Height label rotated 90° next to right arrow — 14px screen size
      ctx.save();
      ctx.translate(rightX + 5 / zoom, (py0 + py1) / 2);
      ctx.rotate(Math.PI / 2);
      ctx.font = `bold ${14 / zoom}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${(dec.paraH / 10).toFixed(1)} cm`, 0, 0);
      ctx.restore();
      ctx.restore();

      // ── Title text at top of sheet ──
      ctx.save();
      ctx.fillStyle = '#1a1a1a';
      ctx.font = `bold ${14 / zoom}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(dec.title || '', px0, 2 / zoom);
      ctx.restore();

      // ── NORM BREAKDOWN table at bottom of sheet ──
      // Two columns: label (left) + value (right), drawn inside breakdownSpace
      // region below the parallelogram. Fonts are sized in SCREEN pixels (so
      // they stay readable at any zoom level) by dividing constant pixel
      // values by zoom — `14 / zoom` canvas units × zoom = 14 screen pixels.
      if (Array.isArray(dec.breakdown) && dec.breakdown.length > 0) {
        ctx.save();
        const tableX0 = px0;
        const tableX1 = px1;
        const tableY0 = py1 + (dec.breakdownSpace * 0.12);
        const rowH = (dec.breakdownSpace * 0.78) / (dec.breakdown.length + 1);
        // Header — bigger, bolder
        ctx.fillStyle = '#1a1a1a';
        ctx.font = `bold ${14 / zoom}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('📐 NORM BREAKDOWN', tableX0, tableY0);
        // Underline
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 1 / zoom;
        ctx.beginPath();
        ctx.moveTo(tableX0, tableY0 + rowH * 0.45);
        ctx.lineTo(tableX1, tableY0 + rowH * 0.45);
        ctx.stroke();
        // Data rows — uniform 12px screen size, highlight rows bolder + orange
        for (let i = 0; i < dec.breakdown.length; i++) {
          const row = dec.breakdown[i];
          const ry = tableY0 + (i + 1) * rowH;
          ctx.fillStyle = row.highlight ? '#cc6600' : '#333';
          ctx.font = `${row.highlight ? 'bold ' : ''}${12 / zoom}px sans-serif`;
          ctx.textAlign = 'left';
          ctx.fillText(row.label || '', tableX0, ry);
          ctx.textAlign = 'right';
          ctx.fillText(row.value || '', tableX1, ry);
        }
        ctx.restore();
      }
    }

    // ── Anatomical zones overlay (user toggle) ──
    // Draws zone boundary curves + labels on the hide. Only shown when
    // this.showZones is true AND we have zone data (full-hide only).
    if (this.showZones && this.sheetZones && this.sheetZones.length) {
      ctx.save();
      // Zone boundary curves — thick brown lines (matching SVG design)
      ctx.strokeStyle = '#4a3a28';
      ctx.lineWidth = 2.5 / zoom;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const curve of this.sheetZones) {
        if (!curve || curve.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < curve.length; i++) {
          const [x, y] = curve[i];
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Zone labels — black bold text with white halo so they're readable
      if (this.sheetLabels && this.sheetLabels.length) {
        // Calculate a font size that scales sensibly with sheet dimensions
        // (the source labels were 564 SVG units; hide is ~15000 wide;
        //  target ~3.5% of hide width)
        const fontSize = this.sheetW * 0.035;
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        for (const lbl of this.sheetLabels) {
          ctx.save();
          ctx.translate(lbl.x, lbl.y);
          if (lbl.rot) ctx.rotate(lbl.rot * Math.PI / 180);
          // White halo for readability over any background
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.lineWidth = 4 / zoom;
          ctx.lineJoin = 'round';
          ctx.strokeText(lbl.text, 0, 0);
          // Black fill on top
          ctx.fillStyle = '#1a1a1a';
          ctx.fillText(lbl.text, 0, 0);
          ctx.restore();
        }
      }
      ctx.restore();
    }

    // Grid
    if (this.showGrid) this.drawGrid();

    // Defects overlay (drawn on top of sheet, beneath margin/placements)
    if (this.defects && this.defects.length) {
      ctx.save();
      // Type-specific colors for realism:
      //   hole    → dark brown (deep damage, nearly black)
      //   scar    → red-brown (old healed wound)
      //   mark    → brown (brand, rub mark)
      //   scratch → light orange (surface scratch)
      const typeColors = {
        hole:    { fill: 'rgba(80, 40, 20, 0.75)',   stroke: 'rgba(40, 20, 10, 0.95)' },
        scar:    { fill: 'rgba(180, 60, 40, 0.55)',  stroke: 'rgba(140, 30, 20, 0.95)' },
        mark:    { fill: 'rgba(140, 90, 60, 0.50)',  stroke: 'rgba(90, 50, 25, 0.95)' },
        scratch: { fill: 'rgba(200, 130, 80, 0.45)', stroke: 'rgba(160, 80, 40, 0.90)' },
      };
      for (const d of this.defects) {
        const c = typeColors[d.type] || typeColors.scar;
        ctx.fillStyle = c.fill;
        ctx.strokeStyle = c.stroke;
        ctx.lineWidth = 1 / zoom;
        ctx.beginPath();
        if (d.shape && d.shape.length >= 3) {
          // Irregular defect outline
          for (let i = 0; i < d.shape.length; i++) {
            const [x, y] = d.shape[i];
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
        } else {
          // Fallback: circle
          ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Margin
    const margin = parseFloat(document.getElementById('s-margin').value) || 5;
    ctx.strokeStyle = 'rgba(100,120,255,0.25)';
    ctx.setLineDash([4/zoom, 4/zoom]);
    ctx.lineWidth = 1/zoom;
    if (this.sheetOutline && this.sheetOutline.length >= 3) {
      // Leather sheet: draw the margin as a shrunken polygon (visual hint
      // only; actual engine uses PU.offsetSingle with proper offsetting).
      // Approximate by pulling each vertex toward the polygon centroid.
      let cx = 0, cy = 0;
      for (const [x, y] of this.sheetOutline) { cx += x; cy += y; }
      cx /= this.sheetOutline.length; cy /= this.sheetOutline.length;
      ctx.beginPath();
      for (let i = 0; i < this.sheetOutline.length; i++) {
        const [x, y] = this.sheetOutline[i];
        const dx = cx - x, dy = cy - y;
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        // Shrink vertex toward centroid by approximately `margin` mm
        const sx = x + (dx / len) * margin;
        const sy = y + (dy / len) * margin;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.strokeRect(margin, margin, this.sheetW-2*margin, this.sheetH-2*margin);
    }
    ctx.setLineDash([]);

    // Flow lane guides (faint horizontal lines showing cutting passes)
    if (this.nestResult && this.nestResult.cuttingFlow) {
      this._drawFlowLanes(this.nestResult.placements.filter(p=>p.sheet===this.currentSheet));
    }

    // Placements
    const allPlacements = this.nestResult ? this.nestResult.placements : [];
    const placements = this.nestResult
      ? allPlacements.filter(p => p.sheet === this.currentSheet)
      : [];

    if (placements.length > 0) {
      // Find selected placement (by ABSOLUTE index in nestResult.placements)
      const selIdx = (typeof this.selectedPlacementIdx === 'number') ? this.selectedPlacementIdx : -1;
      const selected = (selIdx >= 0 && selIdx < allPlacements.length) ? allPlacements[selIdx] : null;
      for (const pl of placements) this.drawPlacement(pl, pl === selected);
    } else if (this.parts.length > 0) {
      // Preview mode: draw parts in top-left corner
      this.drawPreview();
    }

    ctx.restore();
  },

  drawGrid() {
    const { ctx, sheetW, sheetH, zoom } = this;
    const step = 50;
    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 0.5 / zoom;
    for (let x = 0; x <= sheetW; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, sheetH); ctx.stroke();
    }
    for (let y = 0; y <= sheetH; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(sheetW, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1/zoom;
    for (let x = 0; x <= sheetW; x += 100) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, sheetH); ctx.stroke();
    }
    for (let y = 0; y <= sheetH; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(sheetW, y); ctx.stroke();
    }
    // Rulers
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.font = `${Math.max(6, 9/zoom)}px JetBrains Mono, monospace`;
    ctx.textAlign = 'center';
    for (let x = 100; x < sheetW; x += 100) {
      ctx.fillText(x+'mm', x, -4/zoom);
    }
    ctx.textAlign = 'right';
    for (let y = 100; y < sheetH; y += 100) {
      ctx.fillText(y, -4/zoom, y+3/zoom);
    }
  },

  drawPlacement(pl, selected) {
    const { ctx, zoom } = this;
    const { pts, x, y, color, partName, rotation } = pl;
    const bbox = polyBBox(pts);
    const tx = x - bbox.x, ty = y - bbox.y;
    const dispPts = translatePts(pts, tx, ty);

    ctx.beginPath();
    ctx.moveTo(dispPts[0][0], dispPts[0][1]);
    for (let i = 1; i < dispPts.length; i++) ctx.lineTo(dispPts[i][0], dispPts[i][1]);
    ctx.closePath();

    // Invalid placement (user dragged to bad spot, hasn't fixed yet) — RED
    // hatched overlay so user clearly sees something's wrong but the part
    // stays where they put it. They can drag again to fix or right-click
    // delete to discard. Drawn FIRST so selected highlight goes on top.
    if (pl._invalid) {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.45)';  // red-600 with alpha
      ctx.fill();
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 4 / zoom;
      ctx.setLineDash([8 / zoom, 4 / zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Warning icon at centroid
      const ibb = polyBBox(dispPts);
      const icx = ibb.x + ibb.w / 2;
      const icy = ibb.y + ibb.h / 2;
      const sz = Math.max(14 / zoom, Math.min(ibb.w, ibb.h) * 0.25);
      ctx.save();
      ctx.fillStyle = '#dc2626';
      ctx.font = `bold ${sz}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚠', icx, icy);
      // Reason text below if zoomed in enough
      if (zoom > 0.4 && pl._invalidReason) {
        ctx.font = `${Math.max(8, 11/zoom)}px sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 3 / zoom;
        ctx.strokeText(pl._invalidReason, icx, icy + sz * 0.7);
        ctx.fillText(pl._invalidReason, icx, icy + sz * 0.7);
      }
      ctx.restore();
    }

    if (selected) {
      // Selected highlight: bright glow + thicker border
      ctx.fillStyle = '#ffff00aa';   // bright yellow fill
      ctx.fill();
      ctx.strokeStyle = '#ffff00';   // bright yellow border
      ctx.lineWidth = 4 / zoom;
      ctx.stroke();
      // Outer glow
      ctx.save();
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 20;
      ctx.strokeStyle = '#ff8800';
      ctx.lineWidth = 2 / zoom;
      ctx.stroke();
      ctx.restore();

      // Edit-mode indicator (arrow/rotate icon at centroid)
      const mode = (typeof App !== 'undefined') && App._placementEditMode;
      if (mode === 'move' || mode === 'rotate') {
        const bb = polyBBox(dispPts);
        const cx = bb.x + bb.w / 2;
        const cy = bb.y + bb.h / 2;
        ctx.save();
        if (mode === 'rotate') {
          // Rotate indicator: curved arrow arc around centroid
          const r = Math.min(bb.w, bb.h) * 0.35;
          ctx.strokeStyle = '#ff4444';
          ctx.lineWidth = 3 / zoom;
          ctx.beginPath();
          ctx.arc(cx, cy, r, -Math.PI * 0.7, Math.PI * 0.5, false);
          ctx.stroke();
          // Arrowhead
          const ah = Math.max(6 / zoom, r * 0.25);
          const ax = cx + r * Math.cos(Math.PI * 0.5);
          const ay = cy + r * Math.sin(Math.PI * 0.5);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - ah * 0.7, ay - ah);
          ctx.lineTo(ax + ah * 0.7, ay - ah);
          ctx.closePath();
          ctx.fillStyle = '#ff4444';
          ctx.fill();
          // Label
          ctx.fillStyle = '#ff4444';
          ctx.font = `bold ${Math.max(9, 12/zoom)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('ROTATE', cx, cy + r + 14 / zoom);
        } else {
          // Move indicator: 4-way arrow
          const r = Math.min(bb.w, bb.h) * 0.20;
          ctx.strokeStyle = '#22c55e';
          ctx.fillStyle = '#22c55e';
          ctx.lineWidth = 3 / zoom;
          ctx.beginPath();
          ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
          ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
          ctx.stroke();
          // Arrowheads (4 corners)
          const ah = Math.max(5 / zoom, r * 0.35);
          const drawArrow = (dx, dy) => {
            const ax = cx + dx * r, ay = cy + dy * r;
            ctx.beginPath();
            if (Math.abs(dx) > 0) {
              ctx.moveTo(ax, ay);
              ctx.lineTo(ax - dx * ah, ay - ah);
              ctx.lineTo(ax - dx * ah, ay + ah);
            } else {
              ctx.moveTo(ax, ay);
              ctx.lineTo(ax - ah, ay - dy * ah);
              ctx.lineTo(ax + ah, ay - dy * ah);
            }
            ctx.closePath();
            ctx.fill();
          };
          drawArrow(1, 0); drawArrow(-1, 0); drawArrow(0, 1); drawArrow(0, -1);
          // Label
          ctx.font = `bold ${Math.max(9, 12/zoom)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('MOVE', cx, cy + r + 14 / zoom);
        }
        ctx.restore();
      }
    } else {
      ctx.fillStyle = color + '33';   // lighter fill so overlap (if any) is visible
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / zoom;         // thicker boundary for clarity
      ctx.stroke();
    }

    // ── Inner marking lines (seam lines, stitch guides, notch marks) ──
    if (pl.innerLines && pl.innerLines.length > 0) {
      ctx.save();
      ctx.lineWidth = 0.8 / zoom;
      ctx.lineJoin = 'round';  // prevent miter-limit bevel on shallow-angle joins
      ctx.lineCap  = 'round';
      for (const il of pl.innerLines) {
        if (!il.pts || il.pts.length < 2) continue;
        const ilPts = translatePts(il.pts, tx, ty);
        ctx.beginPath();
        ctx.moveTo(ilPts[0][0], ilPts[0][1]);
        if (il.closed) {
          // Closed shape: draw all segments without gap detection, then closePath
          for (let i = 1; i < ilPts.length; i++) ctx.lineTo(ilPts[i][0], ilPts[i][1]);
          ctx.closePath();
        } else {
          // Open path: use pen-up detection for jumps > 26mm
          let _lx2 = ilPts[0][0], _ly2 = ilPts[0][1];
          for (let i = 1; i < ilPts.length; i++) {
            const _dx = ilPts[i][0]-_lx2, _dy = ilPts[i][1]-_ly2;
            if (_dx*_dx + _dy*_dy > 676) {
              ctx.moveTo(ilPts[i][0], ilPts[i][1]);
            } else {
              ctx.lineTo(ilPts[i][0], ilPts[i][1]);
            }
            _lx2 = ilPts[i][0]; _ly2 = ilPts[i][1];
          }
        }
        ctx.strokeStyle = (il.color || '#888') + 'cc';
        ctx.stroke();
      }
      ctx.restore();
    }

    // Label
    const lbbox = polyBBox(dispPts);
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(7, 10/zoom)}px Barlow Condensed, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Use custom display name if user has renamed this component
    const displayName = (typeof App !== 'undefined' && App.getDisplayName)
      ? App.getDisplayName(partName) : partName;
    const label = displayName.length > 10 ? displayName.slice(0,9)+'…' : displayName;
    ctx.fillText(label, lbbox.cx, lbbox.cy);
    if (rotation !== 0) {
      ctx.font = `${Math.max(6, 8/zoom)}px JetBrains Mono, monospace`;
      ctx.fillStyle = color + 'aa';
      ctx.fillText(rotation+'°', lbbox.cx, lbbox.cy + 12/zoom);
    }
  },

  drawPreview() {
    const { ctx, zoom } = this;
    const margin = parseFloat(document.getElementById('s-margin').value) || 5;
    let x = margin + 10, y = margin + 10, rowH = 0;
    for (const part of this.parts) {
      // Use combined bbox of boundary + inner lines for translation
      // (same approach as the import modal preview, guarantees alignment)
      const allPartPts = [...part.pts];
      (part.innerLines||[]).forEach(il => { if(il.pts) il.pts.forEach(p => allPartPts.push(p)); });
      const bbox = polyBBox(allPartPts);
      if (x + bbox.w > this.sheetW - margin - 10) {
        x = margin + 10; y += rowH + 10; rowH = 0;
      }
      const tx = x - bbox.x, ty = y - bbox.y;
      const dispPts = translatePts(part.pts, tx, ty);

      // Outer boundary fill + stroke
      ctx.beginPath();
      ctx.moveTo(dispPts[0][0], dispPts[0][1]);
      for (let i = 1; i < dispPts.length; i++) ctx.lineTo(dispPts[i][0], dispPts[i][1]);
      ctx.closePath();
      ctx.fillStyle = part.color + '44';
      ctx.fill();
      ctx.strokeStyle = part.color;
      ctx.lineWidth = 1/zoom;
      ctx.stroke();

      // Inner marking lines — same tx,ty offset as boundary
      if (part.innerLines && part.innerLines.length > 0) {
        ctx.save();
        ctx.lineWidth = 0.65 / zoom;
        ctx.lineJoin = 'round';  // prevent miter-limit bevel on shallow-angle joins
        ctx.lineCap  = 'round';
        for (const il of part.innerLines) {
          if (!il.pts || il.pts.length < 2) continue;
          const ilPts = translatePts(il.pts, tx, ty);
          ctx.beginPath();
          ctx.moveTo(ilPts[0][0], ilPts[0][1]);
          if (il.closed) {
            // Closed shape: draw all segments then closePath
            for (let k = 1; k < ilPts.length; k++) ctx.lineTo(ilPts[k][0], ilPts[k][1]);
            ctx.closePath();
          } else {
            // Open path: pen-up detection for jumps > 26mm
            let _lx = ilPts[0][0], _ly = ilPts[0][1];
            for (let k = 1; k < ilPts.length; k++) {
              const _dx = ilPts[k][0]-_lx, _dy = ilPts[k][1]-_ly;
              if (_dx*_dx + _dy*_dy > 676) { // 26mm threshold
                ctx.moveTo(ilPts[k][0], ilPts[k][1]); // pen up
              } else {
                ctx.lineTo(ilPts[k][0], ilPts[k][1]); // pen down
              }
              _lx = ilPts[k][0]; _ly = ilPts[k][1];
            }
          }
          ctx.strokeStyle = il.color || '#888888';
          ctx.stroke();
        }
        ctx.restore();
      }

      x += bbox.w + 10;
      rowH = Math.max(rowH, bbox.h);
    }
  }
};


/* ═══════════════════════════════════════════════════════════════════
   SECTION 6: APP CONTROLLER
═══════════════════════════════════════════════════════════════════ */

