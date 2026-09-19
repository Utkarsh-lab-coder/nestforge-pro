/*
 * NestForge Pro — App controller — main UI, parts list, settings, rules dialog, replacement toolbar
 *
 * Original location: lines 18831..21344 of nestforge-pro.html (2514 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const App = {
  parts: [],          // { id, name, pts, color, qty, area, bbox }
  nestResult: null,
  selectedPart: null,

  // ── Leather sheet state ────────────────────────────────────
  _sheetType: 'rectangle',   // 'rectangle'|'full-hide'|'side'|'shoulder'|'belly'|'bend'|'custom'
  _leatherGrade: 'C',        // 'A'|'B'|'C'|'D'|'E'
  _sheetOutline: null,       // polygon pts for non-rectangular sheets (or null for rect)
  _sheetZones: null,         // zone boundary curves (full-hide only)
  _sheetLabels: null,        // zone name labels (full-hide only)
  _showZones: false,         // user toggle for the zone overlay
  _defects: [],              // [{ x, y, r, type, id }, ...]
  _defectSeed: 12345,        // RNG seed so defects reproducible until user regenerates
  _defectEditMode: false,    // when true, clicks on canvas add/remove defects

  // ── Workspace (multi-sheet) system ──────────────────────────

  init() {
    Renderer.init(document.getElementById('main-canvas'));
    // Default unit is mm. Persist user's choice across reloads via localStorage
    // (best-effort; falls back to mm if unavailable).
    this._currentUnit = 'mm';
    try {
      const saved = localStorage.getItem('nestforge_unit');
      if (saved && ['mm', 'cm', 'dm', 'm', 'in', 'ft'].includes(saved)) {
        this._currentUnit = saved;
        const sel = document.getElementById('s-unit');
        if (sel) sel.value = saved;
      }
    } catch (_) {}
    // If user had a non-mm unit saved, convert default mm input values shown
    // in the HTML to that unit so display matches selection.
    if (this._currentUnit !== 'mm') {
      const u = this._unitToMM();
      const wEl = document.getElementById('s-width');
      const hEl = document.getElementById('s-height');
      const mEl = document.getElementById('s-margin');
      const gEl = document.getElementById('s-gap');
      if (wEl) wEl.value = this._formatNum((parseFloat(wEl.value) || 1200) / u);
      if (hEl) hEl.value = this._formatNum((parseFloat(hEl.value) || 600) / u);
      if (mEl) mEl.value = this._formatNum((parseFloat(mEl.value) || 5) / u);
      if (gEl) gEl.value = this._formatNum((parseFloat(gEl.value) || 2) / u);
      // Update unit labels
      const lbl = this._currentUnit;
      document.querySelectorAll('.unit-label').forEach(el => el.textContent = lbl);
      document.querySelectorAll('.unit-area-label').forEach(el => el.textContent = lbl + '²');
    }
    this._refreshAreaDisplay();
    this.setupDragDrop();
    this.setupRotationToggles();
    this.setupGrainDir();
    this.setupCosting();
    this._renderWSTabs();
    document.getElementById('s-width').addEventListener('input', () => {
      const t = this._sheetType;
      if (t && t !== 'rectangle' && t !== 'custom') this._onLeatherDimChange('w');
      this.onSettingsChange();
    });
    document.getElementById('s-height').addEventListener('input', () => {
      const t = this._sheetType;
      if (t && t !== 'rectangle' && t !== 'custom') this._onLeatherDimChange('h');
      this.onSettingsChange();
    });
    document.getElementById('s-margin').addEventListener('input', () => this.onSettingsChange());
    // Flow mode toggle
    document.getElementById('flow-enable').addEventListener('change', e => {
      document.getElementById('flow-options').style.display = e.target.checked ? 'block' : 'none';
      document.getElementById('btn-flow').classList.toggle('flow-on', e.target.checked);
    });
    document.getElementById('flow-dir').addEventListener('change', () => this._updateFlowPills());
    // Measure tool: Esc cancels the point in progress, then clears, then exits.
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || typeof Measure === 'undefined' || !Measure.active) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (Measure.onEscape()) e.preventDefault();
    });
    // Auto-size modal: update estimate when dimension/lock changes
    document.getElementById('as-lock-dim').addEventListener('change', () => this._updateAutoSizeLabels());
    document.getElementById('as-dim-val').addEventListener('input', () => this._updateAutoSizeEstimate());
    try { this.setupMobile(); } catch(e) { console.warn('Mobile setup failed (non-fatal):', e); }
    setTimeout(() => Renderer.fitView(), 100);
    this.renderSheetTabs([]);
  },

  /* ── MOBILE UX ─────────────────────────────────────────────── */
  toggleLeftPanel(force) {
    const p = document.getElementById('left-panel');
    const open = force === undefined ? !p.classList.contains('open') : force;
    if (open) this.closeAllPanels();
    p.classList.toggle('open', open);
    document.getElementById('mobile-backdrop').classList.toggle('visible', open);
  },
  toggleRightPanel(force) {
    const p = document.getElementById('right-panel');
    const open = force === undefined ? !p.classList.contains('open') : force;
    if (open) this.closeAllPanels();
    p.classList.toggle('open', open);
    document.getElementById('mobile-backdrop').classList.toggle('visible', open);
  },
  closeAllPanels() {
    document.getElementById('left-panel').classList.remove('open');
    document.getElementById('right-panel').classList.remove('open');
    document.getElementById('mobile-backdrop').classList.remove('visible');
    document.getElementById('mobile-menu-dropdown').classList.remove('open');
  },
  toggleMobileMenu() {
    const m = document.getElementById('mobile-menu-dropdown');
    m.classList.toggle('open');
  },

  setupMobile() {
    // Dismiss dropdown when tapping outside
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('mobile-menu-dropdown');
      const btn = document.getElementById('mobile-menu-btn');
      if (!dropdown.classList.contains('open')) return;
      if (dropdown.contains(e.target) || btn.contains(e.target)) return;
      dropdown.classList.remove('open');
    });
    // Mirror btn-nest state to mobile nav run button
    const origUpdateUI = this.updateUI ? this.updateUI.bind(this) : null;
    // Touch pan/pinch-zoom on canvas
    this._setupCanvasTouch();
    // Mirror partsCount to mobile badge
    const parts = document.getElementById('mn-parts');
    const obs = new MutationObserver(() => {
      const n = parseInt(document.getElementById('parts-count').textContent, 10) || 0;
      parts.setAttribute('data-badge', String(n));
    });
    obs.observe(document.getElementById('parts-count'), { childList: true, characterData: true, subtree: true });
  },

  _setupCanvasTouch() {
    const canvas = document.getElementById('main-canvas');
    let touchMode = 'none';     // 'pan' | 'pinch' | 'none'
    let lastX = 0, lastY = 0;
    let touchStartX = 0, touchStartY = 0, touchTotal = 0;
    let pinchStartDist = 0, pinchStartZoom = 1, pinchCx = 0, pinchCy = 0;

    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const midpoint = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchMode = 'pan';
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        touchStartX = lastX; touchStartY = lastY; touchTotal = 0;
      } else if (e.touches.length === 2) {
        touchMode = 'pinch';
        pinchStartDist = dist(e.touches[0], e.touches[1]);
        pinchStartZoom = Renderer.zoom;
        const m = midpoint(e.touches[0], e.touches[1]);
        const rect = canvas.getBoundingClientRect();
        pinchCx = m.x - rect.left;
        pinchCy = m.y - rect.top;
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (touchMode === 'pan' && e.touches.length === 1) {
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;
        touchTotal += Math.abs(dx) + Math.abs(dy);
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        // Don't pan when in defect edit mode (reserve tap for add/delete)
        if (!(App && App._defectEditMode)) {
          Renderer.offsetX += dx;
          Renderer.offsetY += dy;
          Renderer.draw();
        }
      } else if (touchMode === 'pinch' && e.touches.length === 2) {
        const newDist = dist(e.touches[0], e.touches[1]);
        if (pinchStartDist > 10) {
          const scale = newDist / pinchStartDist;
          const newZoom = Math.max(0.02, Math.min(80, pinchStartZoom * scale));
          const factor = newZoom / Renderer.zoom;
          Renderer.offsetX = pinchCx - factor * (pinchCx - Renderer.offsetX);
          Renderer.offsetY = pinchCy - factor * (pinchCy - Renderer.offsetY);
          Renderer.zoom = newZoom;
          Renderer.draw();
          const zv = document.getElementById('zoom-val');
          if (zv) zv.textContent = Math.round(Renderer.zoom * 100) + '%';
        }
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      // If this was a tap (minimal drag) and defect edit mode is on,
      // convert to sheet-space mm and add/remove defect.
      if (touchMode === 'pan' && touchTotal < 10 && App && App._defectEditMode) {
        const rect = canvas.getBoundingClientRect();
        const mx = touchStartX - rect.left;
        const my = touchStartY - rect.top;
        const sheetX = (mx - Renderer.offsetX) / Renderer.zoom;
        const sheetY = (my - Renderer.offsetY) / Renderer.zoom;
        App._onDefectClick(sheetX, sheetY);
      }
      if (e.touches.length === 0) {
        touchMode = 'none';
      } else if (e.touches.length === 1) {
        touchMode = 'pan';
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
      }
    });

    canvas.addEventListener('touchcancel', () => { touchMode = 'none'; });
  },

  onSettingsChange() {
    // Renderer needs mm. UI may be in cm/inch/etc — convert.
    const u = this._unitToMM();
    Renderer.sheetW = ((parseFloat(document.getElementById('s-width').value) || 1200)) * u;
    Renderer.sheetH = ((parseFloat(document.getElementById('s-height').value) || 600)) * u;
    // Refresh area display when dimensions change
    this._refreshAreaDisplay();
    // If non-rectangular sheet, re-generate outline at new dimensions
    if (this._sheetType && this._sheetType !== 'rectangle' && this._sheetType !== 'custom') {
      this._regenerateSheetOutline();
    }
    Renderer.fitView();
    if (this.nestResult) this.nestResult = null;
    this.updateUI();
  },

  /* ══════════════════════════════════════════════════════════════════
     LEATHER SHEET HANDLERS
     Manages sheet shape selection, defect generation, and custom import.
     ═════════════════════════════════════════════════════════════════ */

  _onSheetTypeChange() {
    const sel = document.getElementById('s-sheet-type').value;
    this._sheetType = sel;
    const isLeather = (sel !== 'rectangle' && sel !== 'custom');
    const isCustom = sel === 'custom';
    document.getElementById('leather-grade-row').style.display = isLeather ? '' : 'none';
    document.getElementById('leather-defect-row').style.display = (isLeather || isCustom) ? '' : 'none';
    document.getElementById('leather-custom-row').style.display = isCustom ? '' : 'none';
    const zonesRow = document.getElementById('leather-zones-row');
    if (zonesRow) zonesRow.style.display = isLeather ? '' : 'none';

    // Set sensible default dimensions for the chosen type. Templates store
    // mm; convert to current display unit for the input fields.
    const t = LeatherSheet.TYPES[sel];
    if (t && sel !== 'custom') {
      const u = this._unitToMM();
      document.getElementById('s-width').value  = this._formatNum(t.defaultW / u);
      document.getElementById('s-height').value = this._formatNum(t.defaultH / u);
      Renderer.sheetW = t.defaultW;
      Renderer.sheetH = t.defaultH;
      this._refreshAreaDisplay();
    }
    if (sel === 'rectangle') {
      this._sheetOutline = null;
      this._defects = [];
    } else if (sel !== 'custom') {
      this._regenerateSheetOutline();
      this._regenerateDefects();
    }
    this._updateDefectStats();
    Renderer.sheetOutline = this._sheetOutline;
    Renderer.defects = this._defects;

    // ── Leather usability nudge ─────────────────────────────
    // For leather hides: raise copies estimate based on hide area ÷ largest
    // part area, and auto-enable multiSheet=OFF (you only have ONE hide).
    // Also surface a visible hint suggesting "Fill Entire Sheet" for maximum
    // utilization, since that's the industry-standard workflow for leather.
    if (isLeather && this.parts && this.parts.length > 0) {
      // Estimate how many of the largest part would fit
      const hideArea = this._sheetOutline ? polyArea(this._sheetOutline) : (t.defaultW * t.defaultH);
      const largestPartArea = Math.max(...this.parts.map(p => polyArea(p.pts)));
      const estFit = Math.max(1, Math.floor(hideArea / largestPartArea * 0.7)); // 0.7 = realistic packing
      // Bump copies ONLY if current value is 1 (default) — don't override user choice
      const copiesInp = document.getElementById('s-copies');
      if (copiesInp && parseInt(copiesInp.value) <= 1) {
        copiesInp.value = Math.min(50, estFit);
      }
      // Show a leather-specific tip if not already visible
      let tip = document.getElementById('leather-copies-tip');
      if (!tip) {
        const copiesSection = copiesInp ? copiesInp.closest('.section') : null;
        if (copiesSection) {
          tip = document.createElement('div');
          tip.id = 'leather-copies-tip';
          tip.style.cssText = 'margin-top:8px;padding:8px 10px;background:rgba(210,166,120,0.12);border:1px solid rgba(210,166,120,0.4);border-radius:4px;font-size:11px;color:var(--text);line-height:1.5';
          tip.innerHTML = '🐄 <b>Leather mode:</b> click <b>Fill Entire Sheet</b> below for maximum pieces-per-hide. Or set Copies to how many you need.';
          copiesSection.appendChild(tip);
        }
      } else {
        tip.style.display = '';
      }
      // Multi-sheet default off (you have ONE hide, not unlimited sheets)
      const ms = document.getElementById('s-multi-sheet');
      if (ms && ms.checked) ms.checked = false;
    } else {
      // Back to rectangle — hide the tip
      const tip = document.getElementById('leather-copies-tip');
      if (tip) tip.style.display = 'none';
      // DO NOT re-enable multi-sheet — leave it as user has it. Default
      // is unchecked (single-sheet); user can explicitly enable if they
      // really want overflow to multiple sheets.
    }

    Renderer.fitView();
    Renderer.draw();
    this.nestResult = null;
    this.updateUI();
  },

  _onLeatherGradeChange() {
    this._leatherGrade = document.getElementById('s-leather-grade').value;
    this._regenerateDefects();
  },

  /* ══════════════════════════════════════════════════════════════════
     UNIT SYSTEM
     ─────────────────────────────────────────────────────────────────
     Internal storage and engine math always use MILLIMETERS. The UI
     can DISPLAY values in any unit (mm/cm/m/in/ft) — getSettings()
     converts UI values to mm before passing to the engine.

     Aspect ratio when user edits area: the area input scales W and H
     proportionally (width/height ratio preserved).

     Conversion factors are mm-per-unit:
       1 cm  = 10 mm
       1 m   = 1000 mm
       1 in  = 25.4 mm
       1 ft  = 304.8 mm
     ═════════════════════════════════════════════════════════════════ */

  _unitToMM() {
    // Multiplier to convert ONE unit of the current display to mm
    const u = this._currentUnit || 'mm';
    if (u === 'cm') return 10;
    if (u === 'dm') return 100;
    if (u === 'm')  return 1000;
    if (u === 'in') return 25.4;
    if (u === 'ft') return 304.8;
    return 1;  // mm
  },

  _mmToUnit(valMM) {
    const factor = this._unitToMM();
    return valMM / factor;
  },

  _unitArea(valMM) {
    // Area conversion: linear factor squared.
    const f = this._unitToMM();
    return valMM / (f * f);
  },

  _formatNum(v, decimals) {
    // Strip trailing zeros for clean display; keep up to `decimals` precision.
    if (decimals == null) {
      // Auto: 0 if integer-ish, else 2 decimals
      decimals = (Math.abs(v - Math.round(v)) < 0.001) ? 0 : 2;
    }
    return parseFloat(v.toFixed(decimals)).toString();
  },

  _onUnitChange() {
    // User picked a new unit. We need to:
    //   1. Convert all currently-displayed values from OLD unit to NEW unit
    //   2. Update the unit labels next to each input
    //   3. Update the area display
    const newUnit = document.getElementById('s-unit').value;
    const oldUnit = this._currentUnit || 'mm';
    if (newUnit === oldUnit) return;

    // Read current values (in OLD unit) and convert to mm first
    const oldFactor = (() => {
      if (oldUnit === 'cm') return 10;
      if (oldUnit === 'dm') return 100;
      if (oldUnit === 'm')  return 1000;
      if (oldUnit === 'in') return 25.4;
      if (oldUnit === 'ft') return 304.8;
      return 1;
    })();
    const wInputMM = (parseFloat(document.getElementById('s-width').value)  || 1200) * oldFactor;
    const hInputMM = (parseFloat(document.getElementById('s-height').value) || 600)  * oldFactor;
    const mInputMM = (parseFloat(document.getElementById('s-margin').value) || 5)    * oldFactor;
    const gInputMM = (parseFloat(document.getElementById('s-gap').value)    || 2)    * oldFactor;

    // Switch to new unit and write converted display values
    this._currentUnit = newUnit;
    try { localStorage.setItem('nestforge_unit', newUnit); } catch (_) {}
    const newFactor = this._unitToMM();
    document.getElementById('s-width').value  = this._formatNum(wInputMM / newFactor);
    document.getElementById('s-height').value = this._formatNum(hInputMM / newFactor);
    document.getElementById('s-margin').value = this._formatNum(mInputMM / newFactor);
    document.getElementById('s-gap').value    = this._formatNum(gInputMM / newFactor);

    // Update step attributes for sensible increments at this unit
    const stepFor = (mm) => {
      if (newUnit === 'mm') return mm;
      if (newUnit === 'cm') return 0.1;
      if (newUnit === 'dm') return 0.01;
      if (newUnit === 'm')  return 0.01;
      if (newUnit === 'in') return 0.1;
      if (newUnit === 'ft') return 0.05;
      return 1;
    };
    document.getElementById('s-width').step  = stepFor(1);
    document.getElementById('s-height').step = stepFor(1);
    document.getElementById('s-margin').step = stepFor(1);
    document.getElementById('s-gap').step    = stepFor(0.5);

    // Update all unit labels in the DOM
    const unitLabel = newUnit === 'in' ? 'in' : (newUnit === 'ft' ? 'ft' : newUnit);
    document.querySelectorAll('.unit-label').forEach(el => el.textContent = unitLabel);
    document.querySelectorAll('.unit-area-label').forEach(el => el.textContent = unitLabel + '²');

    // Recompute area display
    this._refreshAreaDisplay();
  },

  _refreshAreaDisplay() {
    // Read current width × height (in current unit), display as area in that unit²
    const w = parseFloat(document.getElementById('s-width').value)  || 0;
    const h = parseFloat(document.getElementById('s-height').value) || 0;
    const area = w * h;
    const areaInput = document.getElementById('s-area');
    if (areaInput && document.activeElement !== areaInput) {
      // Don't clobber user's input while they're typing
      areaInput.value = this._formatNum(area, 0);
    }
  },

  _onDimensionInput() {
    // User edited width or height — refresh area display
    this._refreshAreaDisplay();
  },

  _onAreaInput() {
    // User typed a new area. Scale width and height proportionally to keep
    // current aspect ratio, so total area = entered value.
    const newArea = parseFloat(document.getElementById('s-area').value) || 0;
    if (newArea <= 0) return;
    const wEl = document.getElementById('s-width');
    const hEl = document.getElementById('s-height');
    const w = parseFloat(wEl.value) || 1200;
    const h = parseFloat(hEl.value) || 600;
    if (w <= 0 || h <= 0) return;
    const oldArea = w * h;
    if (oldArea <= 0) return;
    // scale = sqrt(newArea / oldArea) — applied to BOTH dimensions preserves ratio
    const scale = Math.sqrt(newArea / oldArea);
    wEl.value = this._formatNum(w * scale);
    hEl.value = this._formatNum(h * scale);
    // Don't call _refreshAreaDisplay() — would reformat user's input mid-typing
  },

  _regenerateSheetOutline() {
    // Inputs are in current display unit; LeatherSheet expects mm
    const u = this._unitToMM();
    const W = (parseFloat(document.getElementById('s-width').value) || 1200) * u;
    const H = (parseFloat(document.getElementById('s-height').value) || 600) * u;
    const shape = LeatherSheet.generateShape(this._sheetType, W, H);
    this._sheetOutline = shape ? shape.pts : null;
    this._sheetZones = (shape && shape.zoneCurves) ? shape.zoneCurves : null;
    this._sheetLabels = (shape && shape.zoneLabels) ? shape.zoneLabels : null;
    Renderer.sheetOutline = this._sheetOutline;
    Renderer.sheetZones = this._sheetZones;
    Renderer.sheetLabels = this._sheetLabels;
  },

  /* Toggle showing the anatomical zone boundaries + labels on the hide.
     Only full-hide has zones in this first release. */
  _toggleShowZones() {
    this._showZones = !this._showZones;
    Renderer.showZones = this._showZones;
    // Update button text to reflect state
    const btn = document.getElementById('btn-show-zones');
    if (btn) {
      btn.textContent = this._showZones ? '🗺 Hide Zones' : '🗺 Show Zones';
      btn.classList.toggle('primary', this._showZones);
    }
    Renderer.draw();
  },

  /* Keep hide aspect ratio when user changes width or height.
     Every leather type (full-hide, side, shoulder, belly, bend) has a
     fixed natural aspect ratio based on its shape after clipping.
     When the user changes one dimension, scale the other to preserve
     the shape proportions. */
  _onLeatherDimChange(which) {
    if (this._sheetType === 'rectangle' || this._sheetType === 'custom') return;
    // Get the natural aspect (H/W) for this cut type by asking LeatherSheet
    // for the shape at a reference size and reading back the actual bbox.
    const refShape = LeatherSheet.generateShape(this._sheetType, 1000, 1000);
    if (!refShape || !refShape.bbox) return;
    const aspect = refShape.bbox.h / refShape.bbox.w;
    if (!isFinite(aspect) || aspect <= 0) return;
    const wInput = document.getElementById('s-width');
    const hInput = document.getElementById('s-height');
    if (!wInput || !hInput) return;
    if (which === 'w') {
      const W = parseFloat(wInput.value) || 1000;
      hInput.value = this._formatNum(W * aspect);
    } else if (which === 'h') {
      const H = parseFloat(hInput.value) || 1000;
      wInput.value = this._formatNum(H / aspect);
    }
    this._regenerateSheetOutline();
    this._regenerateDefects();
  },

  _regenerateDefects() {
    if (this._sheetType === 'rectangle') { this._defects = []; Renderer.defects = []; Renderer.draw(); return; }
    // Inputs are in current display unit; LeatherSheet expects mm
    const u = this._unitToMM();
    const W = (parseFloat(document.getElementById('s-width').value) || 1200) * u;
    const H = (parseFloat(document.getElementById('s-height').value) || 600) * u;
    // New random seed each regen (so user gets a different set)
    this._defectSeed = Math.floor(Math.random() * 99999);
    this._defects = LeatherSheet.generateDefects(this._sheetType, W, H, this._leatherGrade, this._defectSeed);
    Renderer.defects = this._defects;
    this._updateDefectStats();
    // Invalidate prior nest result — those placements were computed against
    // OLD defect positions. Showing them now would display parts overlapping
    // new defect locations (stale visual state).
    if (this.nestResult) {
      this.nestResult = null;
      Renderer.nestResult = null;
      this.updateUI();
    }
    Renderer.draw();
  },

  _updateDefectStats() {
    const el = document.getElementById('defect-stats');
    if (!el) return;
    if (!this._defects.length) { el.textContent = '—'; return; }
    // W, H must be mm to match defArea (defects are in mm)
    const u = this._unitToMM();
    const W = (parseFloat(document.getElementById('s-width').value) || 1200) * u;
    const H = (parseFloat(document.getElementById('s-height').value) || 600) * u;
    const defArea = this._defects.reduce((s, d) => s + Math.PI * d.r * d.r, 0);
    const pct = (defArea / (W * H) * 100).toFixed(1);
    el.textContent = `${this._defects.length} defects • ${pct}% of sheet area • Grade ${this._leatherGrade}`;
  },

  _toggleDefectEditMode() {
    this._defectEditMode = !this._defectEditMode;
    document.getElementById('defect-edit-hint').style.display = this._defectEditMode ? '' : 'none';
    const btn = document.getElementById('btn-defect-edit');
    if (this._defectEditMode) {
      btn.textContent = '✓ Done';
      btn.classList.add('primary');
    } else {
      btn.textContent = '✎ Edit Defects';
      btn.classList.remove('primary');
    }
  },

  /* Called by Renderer when user clicks canvas in defect edit mode.
     x, y are in sheet-space mm coordinates. */
  _onDefectClick(x, y) {
    if (!this._defectEditMode) return;
    // Helper to invalidate stale nest result
    const invalidate = () => {
      if (this.nestResult) {
        this.nestResult = null;
        Renderer.nestResult = null;
        this.updateUI();
      }
    };
    // First: check if clicked on an existing defect → delete it
    for (let i = this._defects.length - 1; i >= 0; i--) {
      const d = this._defects[i];
      const dx = x - d.x, dy = y - d.y;
      if (dx*dx + dy*dy < d.r * d.r) {
        this._defects.splice(i, 1);
        Renderer.defects = this._defects;
        this._updateDefectStats();
        invalidate();
        Renderer.draw();
        return;
      }
    }
    // Otherwise: add a new defect at the click location with irregular shape
    const W = parseFloat(document.getElementById('s-width').value) || 1200;
    const avgR = Math.max(8, W * 0.015); // ~1.5% of sheet width
    // Build an irregular shape polygon (same algorithm as auto-gen)
    const shape = [];
    const numPts = 14;
    const seed = Date.now() % 10000;
    const seed1 = seed * 0.013, seed2 = seed * 0.027;
    const elong = 0.8 + ((seed * 0.031) % 1) * 0.5;
    const elongAngle = ((seed * 0.017) % 1) * Math.PI;
    for (let p = 0; p < numPts; p++) {
      const ang = (p / numPts) * Math.PI * 2;
      const lowFreq = Math.sin(ang * 2 + seed1) * 0.15 + Math.sin(ang * 3 + seed1 * 1.7) * 0.08;
      const highFreq = Math.sin(ang * 7 + seed2) * 0.06 + Math.sin(ang * 11 + seed2 * 0.3) * 0.04;
      const radiusFactor = 1.0 + lowFreq + highFreq;
      const da = ang - elongAngle;
      const stretchFactor = Math.sqrt(
        Math.pow(Math.cos(da) * elong, 2) + Math.pow(Math.sin(da), 2)
      );
      const rr = avgR * radiusFactor * stretchFactor;
      shape.push([x + rr * Math.cos(ang), y + rr * Math.sin(ang)]);
    }
    this._defects.push({
      x, y, r: avgR,
      type: 'mark',
      shape,
      id: 'def_manual_' + Date.now(),
    });
    Renderer.defects = this._defects;
    this._updateDefectStats();
    invalidate();
    Renderer.draw();
  },

  /* ─── PLACEMENT CLICK & REPLACEMENT TOOLBAR ──────────────────────────
     User clicks a placed part on the canvas → toolbar appears below the
     hide showing buttons for each component type. User clicks a button to
     replace the selected part with that component (engine refits in the
     freed area), or Delete to remove without replacement, or Close to
     dismiss the toolbar. */
  _onPlacementClick(sheetX, sheetY) {
    if (!this.nestResult || !this.nestResult.placements) return;
    // Find which placement the click landed inside (point-in-polygon)
    const placements = this.nestResult.placements;
    let hit = null;
    for (let i = placements.length - 1; i >= 0; i--) {  // top-most first
      const pl = placements[i];
      const wp = PU.worldPolyOf(pl);
      if (!wp || wp.length < 3) continue;
      // Ray-cast point in polygon
      let inside = false;
      for (let ii=0, jj=wp.length-1; ii<wp.length; jj=ii++) {
        const yi = wp[ii][1], yj = wp[jj][1];
        if ((yi > sheetY) !== (yj > sheetY)) {
          const xi = wp[ii][0], xj = wp[jj][0];
          if (sheetX < (xj-xi)*(sheetY-yi)/(yj-yi+1e-12)+xi) inside = !inside;
        }
      }
      if (inside) { hit = { idx: i, placement: pl }; break; }
    }
    if (!hit) {
      // Clicked empty area → close toolbar + deselect
      this.replaceCancelSelection();
      return;
    }
    // ── Edit-mode state machine (CorelDraw-style two-click rotate) ──
    // First click on a placement → select it, mode='move'
    // Second click on SAME placement → toggle move ↔ rotate
    // Click on different placement → select new one, mode='move'
    if (this._selectedPlacementIdx === hit.idx) {
      // Same placement clicked again → toggle mode
      this._placementEditMode = (this._placementEditMode === 'move') ? 'rotate' : 'move';
    } else {
      // New placement selected
      this._selectedPlacementIdx = hit.idx;
      this._placementEditMode = 'move';
    }
    this._showReplaceToolbar(hit.placement);
    Renderer.selectedPlacementIdx = hit.idx;
    Renderer.draw();
  },

  _showReplaceToolbar(placement) {
    const tb = document.getElementById('replace-toolbar');
    const btns = document.getElementById('replace-tb-buttons');
    const label = document.getElementById('replace-tb-label');
    if (!tb || !btns) return;
    // Build one button per distinct component in the parts list
    btns.innerHTML = '';
    const seen = new Set();
    for (const p of (this.parts || [])) {
      const key = this._componentKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      const btn = document.createElement('button');
      btn.textContent = key;
      btn.title = 'Replace with ' + key;
      btn.style.cssText = 'background:#2a3340;border:1px solid #3a4452;color:#cde;padding:5px 12px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      // Highlight the same-component button differently
      const placementKey = placement.partName ? placement.partName.replace(/_\d+$/, '') : '';
      if (key === placementKey) {
        btn.style.background = '#3a3a2a';
        btn.style.borderColor = '#666644';
        btn.title = 'Re-place with same component (' + key + ')';
      }
      btn.onclick = () => this._performReplacement(key);
      btns.appendChild(btn);
    }
    label.textContent = 'Selected: ' + (placement.partName || '?') + ' — replace with:';
    tb.style.display = 'block';
  },

  replaceCancelSelection() {
    this._selectedPlacementIdx = -1;
    this._placementEditMode = 'none';
    Renderer.selectedPlacementIdx = -1;
    const tb = document.getElementById('replace-toolbar');
    if (tb) tb.style.display = 'none';
    Renderer.draw();
  },

  replaceDeleteSelected() {
    if (this._selectedPlacementIdx == null || this._selectedPlacementIdx < 0) return;
    if (!this.nestResult || !this.nestResult.placements) return;
    this.nestResult.placements.splice(this._selectedPlacementIdx, 1);
    Renderer.nestResult = this.nestResult;
    this.replaceCancelSelection();
  },

  /* ══════════════════════════════════════════════════════════════════
     FLIP SELECTED PLACEMENT (canvas-level individual flip)
     ─────────────────────────────────────────────────────────────────
     Flips ONE selected piece on the canvas without affecting other
     copies. Different from sidebar's flipPart() which flips the source
     component (affects every placement of that part).

     Two axes:
       'h' → horizontal flip (x → -x, around piece centroid)
       'v' → vertical flip (y → -y, around piece centroid)

     The pts array (already-positioned coords on the sheet) gets the
     flip applied around the piece's centroid so the piece STAYS in
     place (doesn't jump to a new location). Inner cut lines flip too
     so they stay aligned.

     If the flipped piece overlaps another or goes outside hide outline,
     we revert. Same validation pattern as drag/rotate.
     ═════════════════════════════════════════════════════════════════ */
  flipSelectedPlacement(axis) {
    if (this._selectedPlacementIdx == null || this._selectedPlacementIdx < 0) return;
    if (!this.nestResult || !this.nestResult.placements) return;
    const pl = this.nestResult.placements[this._selectedPlacementIdx];
    if (!pl || !pl.pts || pl.pts.length < 3) return;

    // Compute centroid (average of vertices) — flip around this so piece
    // stays anchored in same spot on the sheet
    let cx = 0, cy = 0;
    for (const [x, y] of pl.pts) { cx += x; cy += y; }
    cx /= pl.pts.length;
    cy /= pl.pts.length;

    // Flip around centroid: subtract centroid, negate, add back
    const flipPt = (p) => (axis === 'h')
      ? [2 * cx - p[0], p[1]]
      : [p[0], 2 * cy - p[1]];

    pl.pts = pl.pts.map(flipPt);
    if (Array.isArray(pl.innerLines)) {
      pl.innerLines = pl.innerLines.map(line => ({
        ...line,
        pts: (line.pts || []).map(flipPt),
      }));
    }

    // Track mirror state on the placement (for export accuracy and
    // future toggling). XOR-style: flipping H twice cancels.
    const cur = pl.mirror;
    let newMir;
    if (axis === 'h') {
      newMir = (cur === 'x' || cur === true) ? false : 'x';
      // If was 'y', now both → could collapse to rotation, but for clarity
      // store as composite. Engine doesn't read mirror from placement once
      // pts are baked, so this field is informational.
      if (cur === 'y') newMir = 'xy';
      if (cur === 'xy') newMir = 'y';
    } else {  // 'v'
      newMir = (cur === 'y') ? false : 'y';
      if (cur === 'x' || cur === true) newMir = 'xy';
      if (cur === 'xy') newMir = 'x';
    }
    pl.mirror = newMir;

    Renderer.nestResult = this.nestResult;
    Renderer.draw();
  },

  /* ══════════════════════════════════════════════════════════════════
     DRAG + ROTATE (CorelDraw-style manual adjustment)
     ─────────────────────────────────────────────────────────────────
     After nesting, user can fine-tune any placement:
       • Click placement → select it (MOVE mode, green arrows indicator)
       • Click same placement again → toggle to ROTATE mode (red arc indicator)
       • Drag anywhere on canvas → translates (MOVE) or rotates around
         centroid (ROTATE)
       • Release → validates against other placements and hide outline.
         If the new position overlaps anything or goes outside, the
         placement snaps back to where it was before the drag started.

     Ported live feedback: redraws on every mousemove during drag. Validation
     is only done on mouseup for performance (intersection tests per move
     would stutter).
     ═════════════════════════════════════════════════════════════════ */
  _beginPlacementDrag(sheetX, sheetY, isCopy) {
    if (this._selectedPlacementIdx == null || this._selectedPlacementIdx < 0) return null;
    if (!this.nestResult || !this.nestResult.placements) return null;
    const pl = this.nestResult.placements[this._selectedPlacementIdx];
    if (!pl) return null;
    const bb = polyBBox(pl.pts);
    const centroidX = pl.x + bb.w / 2;
    const centroidY = pl.y + bb.h / 2;
    return {
      mode: this._placementEditMode,
      isCopy: !!isCopy,
      startMouseX: sheetX,
      startMouseY: sheetY,
      startPlX: pl.x,
      startPlY: pl.y,
      startRotation: pl.rotation || 0,
      origPts: pl.pts.map(p => [p[0], p[1]]),  // deep copy of pts at start
      origWorldPoly: PU.worldPolyOf(pl).map(p => [p[0], p[1]]),
      origInnerLines: (pl.innerLines || []).map(il => ({
        pts: il.pts.map(p => [p[0], p[1]]),
        color: il.color, layer: il.layer, closed: il.closed,
      })),
      centroidX, centroidY,
      startAngle: Math.atan2(sheetY - centroidY, sheetX - centroidX),
      partId: pl.partId,
      mirror: pl.mirror,
    };
  },

  _updatePlacementDrag(sheetX, sheetY, dragState) {
    if (!dragState || this._selectedPlacementIdx < 0) return;
    const pl = this.nestResult.placements[this._selectedPlacementIdx];
    if (!pl) return;
    if (dragState.mode === 'move') {
      // Translate by mouse delta
      const dx = sheetX - dragState.startMouseX;
      const dy = sheetY - dragState.startMouseY;
      pl.x = dragState.startPlX + dx;
      pl.y = dragState.startPlY + dy;
      // Keep pts unchanged, rebuild worldPoly
      pl.pts = dragState.origPts.map(p => [p[0], p[1]]);
      pl.innerLines = dragState.origInnerLines.map(il => ({
        pts: il.pts.map(p => [p[0], p[1]]),
        color: il.color, layer: il.layer, closed: il.closed,
      }));
      pl.worldPoly = this._usablePolyOf(pl);
    } else if (dragState.mode === 'rotate') {
      // Rotate around centroid by mouse-angle delta
      const curAngle = Math.atan2(sheetY - dragState.centroidY, sheetX - dragState.centroidX);
      const deltaRad = curAngle - dragState.startAngle;
      const deltaDeg = deltaRad * 180 / Math.PI;
      const newRot = (dragState.startRotation + deltaDeg + 360) % 360;
      pl.rotation = newRot;
      // Reconstruct pts from the part definition + new rotation (and original mirror)
      const partDef = this.parts.find(p => p.id === dragState.partId);
      if (partDef) {
        let rPts = partDef.pts;
        if (dragState.mirror && dragState.mirror !== 'none') rPts = mirrorPts(rPts, dragState.mirror);
        rPts = rotatePts(rPts, newRot);
        pl.pts = rPts;
        pl.innerLines = (partDef.innerLines || []).map(il => {
          let lp = il.pts;
          if (dragState.mirror && dragState.mirror !== 'none') lp = mirrorPts(lp, dragState.mirror);
          return { pts: rotatePts(lp, newRot), color: il.color, layer: il.layer, closed: il.closed };
        });
      }
      // Reposition so bbox center stays at the original centroid (rotation pivot).
      // world_bbox_center_x = pl.x + bb.w/2  (drawPlacement compensates for bb.x via tx)
      // → pl.x = centroidX - bb.w/2   (NO `- bb.x` — that was a bug that shifted the
      //   part off-center whenever the rotated pts had a non-zero bbox origin, which
      //   happens for every rotation ≠ 0° of a normalized part)
      const bb = polyBBox(pl.pts);
      pl.x = dragState.centroidX - bb.w / 2;
      pl.y = dragState.centroidY - bb.h / 2;
      pl.worldPoly = this._usablePolyOf(pl);
    }
    Renderer.draw();
  },

  /* Margin in mm (the settings field is in the display unit). */
  _marginMM() {
    return (parseFloat(document.getElementById('s-margin').value) || 0) * (this._unitToMM ? this._unitToMM() : 1);
  },

  /* A placement's outline in the engines' usable-area frame (sheet frame
     minus the margin): what pl.worldPoly must hold so Improve, Phase 4
     and replacement see a hand-moved part where it really is. */
  _usablePolyOf(pl) {
    const m = this._marginMM();
    return PU.worldPolyOf(pl).map(p => [p[0] - m, p[1] - m]);
  },

  _endPlacementDrag(dragState) {
    if (!dragState || this._selectedPlacementIdx < 0) return;
    const pl = this.nestResult.placements[this._selectedPlacementIdx];
    if (!pl) return;
    // Validate: not overlapping other placements, inside hide outline
    const settings = this.getSettings();
    const gap = settings.gap || 2;
    let invalidReason = null;
    const plWP = PU.worldPolyOf(pl);   // sheet frame, as drawn
    const aBB = polyBBox(plWP);

    // Check hide outline (if any)
    if (this._sheetOutline && this._sheetOutline.length >= 3) {
      for (const v of plWP) {
        if (!PU.contains(this._sheetOutline, v)) {
          invalidReason = 'outside hide outline';
          break;
        }
      }
    } else {
      // Rectangle: must be inside (0, 0) to (sheetW, sheetH)
      if (aBB.x < -0.5 || aBB.y < -0.5 ||
          aBB.x + aBB.w > settings.sheetW + 0.5 ||
          aBB.y + aBB.h > settings.sheetH + 0.5) {
        invalidReason = 'outside sheet bounds';
      }
    }

    // Check overlap with other placements (with gap)
    if (!invalidReason) {
      for (let i = 0; i < this.nestResult.placements.length; i++) {
        if (i === this._selectedPlacementIdx) continue;
        const other = this.nestResult.placements[i];
        if (other.sheet !== pl.sheet) continue;  // different sheets can't overlap
        const oWP = PU.worldPolyOf(other);
        const bBB = polyBBox(oWP);
        // Bbox pre-filter with gap margin
        if (aBB.x > bBB.x + bBB.w + gap) continue;
        if (aBB.x + aBB.w < bBB.x - gap) continue;
        if (aBB.y > bBB.y + bBB.h + gap) continue;
        if (aBB.y + aBB.h < bBB.y - gap) continue;
        // Inflate other by gap and test intersection
        const otherInflated = PU.offsetSingle(oWP, gap, 'square') || oWP;
        const inter = PU.intersection([plWP], [otherInflated]);
        if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 0.5) {
          invalidReason = 'overlaps ' + (other.partName || 'another part');
          break;
        }
      }
    }

    // Check defect overlap
    if (!invalidReason && this._defects && this._defects.length) {
      for (const d of this._defects) {
        if (d.shape && d.shape.length >= 3) {
          const inter = PU.intersection([plWP], [d.shape]);
          if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 0.5) {
            invalidReason = 'overlaps defect';
            break;
          }
        } else {
          // Circle defect
          const r2 = (d.r + gap) * (d.r + gap);
          for (const v of plWP) {
            const dx = v[0] - d.x, dy = v[1] - d.y;
            if (dx*dx + dy*dy < r2) { invalidReason = 'overlaps defect'; break; }
          }
          if (invalidReason) break;
        }
      }
    }

    if (invalidReason) {
      if (dragState.isCopy) {
        // Right-click DUPLICATE drag: keep the copy where user dropped it
        // but flag as invalid (renders red). Reverting would overlay copy
        // on source; user wants to see/keep their attempted placement.
        pl._invalid = true;
        pl._invalidReason = invalidReason;
        const statusEl = document.getElementById('nest-status');
        if (statusEl) {
          const prev = statusEl.textContent;
          statusEl.textContent = '⚠ INVALID position — ' + invalidReason + ' (drag to fix or right-click to delete)';
          setTimeout(() => { if (statusEl.textContent.startsWith('⚠')) statusEl.textContent = prev; }, 4000);
        }
      } else {
        // Normal drag: KEEP the new (invalid) position, flag as invalid.
        // User wants the part to stay where they put it — they'll move it
        // again to fix or accept the warning. Highlight with red until valid.
        pl._invalid = true;
        pl._invalidReason = invalidReason;
        const statusEl = document.getElementById('nest-status');
        if (statusEl) {
          const prev = statusEl.textContent;
          statusEl.textContent = '⚠ INVALID position — ' + invalidReason + ' (drag again to fix)';
          setTimeout(() => { if (statusEl.textContent.startsWith('⚠')) statusEl.textContent = prev; }, 4000);
        }
      }
    } else {
      // Valid placement — clear any prior invalid flag
      pl._invalid = false;
      pl._invalidReason = null;
      // Commit: save to worksheet and update stats (placed count, utilization)
      if (dragState.isCopy) {
        const statusEl = document.getElementById('nest-status');
        if (statusEl) {
          const prev = statusEl.textContent;
          statusEl.textContent = '✓ Copied (+1 part)';
          setTimeout(() => { if (statusEl.textContent.startsWith('✓')) statusEl.textContent = prev; }, 2500);
        }
      }
      this._saveCurrentWS();
      try { this.updateStats(this.nestResult, this.getSettings()); } catch(_){}
    }
    Renderer.draw();
  },

  /* Duplicate a placement by index. Returns the new placement's index, or -1
     on failure. Used by right-click-drag: clone the part at the same spot,
     then drag the copy while the original stays put. */
  _duplicatePlacement(srcIdx) {
    if (!this.nestResult || !this.nestResult.placements) return -1;
    const orig = this.nestResult.placements[srcIdx];
    if (!orig) return -1;
    const copy = {
      ...orig,
      _uid: 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      _copiedFrom: orig._uid,
      pts: orig.pts.map(p => [p[0], p[1]]),
      worldPoly: this._usablePolyOf(orig),
      localPoly: orig.localPoly ? orig.localPoly.map(p => [p[0], p[1]]) : undefined,
      innerLines: (orig.innerLines || []).map(il => ({
        pts: il.pts.map(p => [p[0], p[1]]),
        color: il.color, layer: il.layer, closed: il.closed,
      })),
    };
    this.nestResult.placements.push(copy);
    this.nestResult.placed = this.nestResult.placements.length;
    return this.nestResult.placements.length - 1;
  },

  /* Replace the selected placement with a different component.
     Strategy: remove the old placement, then try to fit the new component
     in the freed area using the same engine (cavity-aware mode). If it
     fits, the replacement is applied. If not, the original part is kept
     and the user is informed. */
  async _performReplacement(newCompKey) {
    if (this._selectedPlacementIdx == null || this._selectedPlacementIdx < 0) return;
    if (!this.nestResult || !this.nestResult.placements) return;
    const idx = this._selectedPlacementIdx;
    const oldPlacement = this.nestResult.placements[idx];
    if (!oldPlacement) return;

    // Find a part definition with this component key to use as template
    const newPart = (this.parts || []).find(p => this._componentKey(p) === newCompKey);
    if (!newPart) {
      alert('Component "' + newCompKey + '" not found in parts list');
      return;
    }

    // Remove the old placement temporarily
    const remainingPlacements = this.nestResult.placements.slice();
    remainingPlacements.splice(idx, 1);

    // Try to place the new component using cavity-aware single placement
    try {
      const settings = this.getSettings();
      const partForFit = this._applyComponentRules(newPart, settings.rotations, settings.mirrorMode);
      // Build variants for the new part
      const E = window.__useRasterEngine ? null : PolyNestEngine;
      if (!E) {
        alert('Replacement requires Polygon engine. Switch engine and re-run nest.');
        return;
      }
      const variants = E.buildVariants(
        partForFit.pts,
        partForFit._rotations || settings.rotations,
        partForFit._mirrorMode || settings.mirrorMode
      );
      // Fake remaining placed list with worldPoly entries
      const placed = remainingPlacements.map(pl => ({
        worldPoly: this._usablePolyOf(pl),
        _variantKey: pl.variantKey || 'unknown',
        x: pl.nfpX != null ? pl.nfpX : pl.x,
        y: pl.nfpY != null ? pl.nfpY : pl.y,
      }));
      // Set up zone check for the new part if it has a rule
      E._zoneCenters = settings.sheetLabels && settings.sheetLabels.length
        ? E._getZoneCenters(settings.sheetLabels) : null;
      E._zoneCheck = null;
      if (E._zoneCenters && settings.componentRules) {
        const rule = settings.componentRules.get(newCompKey);
        if (rule && rule.allowedZones && rule.allowedZones.size) {
          const allowed = rule.allowedZones;
          const centers = E._zoneCenters;
          E._zoneCheck = (cx, cy) => {
            let nearest=null, nd2=Infinity;
            for (const c of centers) {
              const dx=cx-c[1], dy=cy-c[2], d2=dx*dx+dy*dy;
              if (d2 < nd2) { nd2 = d2; nearest = c[0]; }
            }
            return nearest && allowed.has(nearest);
          };
        }
      }
      E._currentCompKey = newCompKey;
      E._currentRule = settings.componentRules ? settings.componentRules.get(newCompKey) : null;
      E._lastRotByComp = new Map();
      E._lastCentroidByComp = new Map();
      const usW = settings.sheetW - 2 * settings.margin;
      const usH = settings.sheetH - 2 * settings.margin;
      const sheetOutline = (settings.sheetOutline || []).map(([x,y]) => [x - settings.margin, y - settings.margin]);
      const fitResult = await E.placeBest(
        variants, placed, usW, usH, settings.gap || 3,
        usW, usH, partForFit.id, new Map(),
        true, true,
        sheetOutline.length ? sheetOutline : null,
        settings.defects || null,
        new Map(), null
      );
      if (!fitResult) {
        alert('Component "' + newCompKey + '" doesn\'t fit in the freed area.\n\nThe original part is kept.');
        return;
      }
      // Build a placement record for the new fit
      const v = variants[fitResult.vi];
      const wp = v.pts.map(p => [p[0] + fitResult.x + settings.margin, p[1] + fitResult.y + settings.margin]);
      const newPlacement = {
        partId: newPart.id,
        partName: newPart.name,
        color: newPart.color,
        pts: v.pts,
        worldPoly: wp,
        localPoly: v.pts,
        variantKey: v.key,
        x: settings.margin + fitResult.x,
        y: settings.margin + fitResult.y,
        nfpX: fitResult.x, nfpY: fitResult.y,
        rotation: v.rotation, mirror: v.mirror, sheet: oldPlacement.sheet || 0,
        innerLines: [],
      };
      // Replace
      this.nestResult.placements = remainingPlacements.concat([newPlacement]);
      Renderer.nestResult = this.nestResult;
      this.replaceCancelSelection();
    } catch (e) {
      alert('Replacement failed: ' + e.message);
      console.error(e);
    }
  },

  _importCustomSheet(fmt) {
    const input = document.createElement('input');
    input.type = 'file';
    if (fmt === 'dxf') input.accept = '.dxf';
    else if (fmt === 'svg') input.accept = '.svg,image/svg+xml';
    else if (fmt === 'image') input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        if (fmt === 'dxf') await this._importCustomDXF(file);
        else if (fmt === 'svg') await this._importCustomSVG(file);
        else if (fmt === 'image') await this._importCustomImage(file);
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    };
    input.click();
  },

  async _importCustomDXF(file) {
    const text = await file.text();
    const shapes = DXFParser.parse(text);
    const classified = DXFImport._classifyShapes(shapes);
    if (!classified.boundaries.length) {
      alert('No closed boundary found in DXF.');
      return;
    }
    // Use the largest boundary as the sheet outline
    const outline = classified.boundaries.reduce((a, b) => polyArea(a.pts) > polyArea(b.pts) ? a : b);
    // Normalize to origin
    const bb = polyBBox(outline.pts);
    const normalized = outline.pts.map(([x, y]) => [x - bb.x, y - bb.y]);
    this._sheetOutline = normalized;
    this._sheetType = 'custom';
    document.getElementById('s-width').value = Math.ceil(bb.w);
    document.getElementById('s-height').value = Math.ceil(bb.h);
    Renderer.sheetW = bb.w;
    Renderer.sheetH = bb.h;
    Renderer.sheetOutline = normalized;
    this._defects = [];
    Renderer.defects = [];
    this._updateDefectStats();
    Renderer.fitView();
    Renderer.draw();
    alert(`Imported custom DXF: ${bb.w.toFixed(0)}×${bb.h.toFixed(0)}mm`);
  },

  async _importCustomSVG(file) {
    const text = await file.text();
    // Simple SVG parser — extract path/polygon/rect/ellipse outlines
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const outlines = this._extractSVGOutlines(doc);
    if (!outlines.length) {
      alert('No usable outline found in SVG. Try exporting as DXF instead.');
      return;
    }
    const largest = outlines.reduce((a, b) => polyArea(a) > polyArea(b) ? a : b);
    const bb = polyBBox(largest);
    const normalized = largest.map(([x, y]) => [x - bb.x, y - bb.y]);
    this._sheetOutline = normalized;
    this._sheetType = 'custom';
    document.getElementById('s-width').value = Math.ceil(bb.w);
    document.getElementById('s-height').value = Math.ceil(bb.h);
    Renderer.sheetW = bb.w;
    Renderer.sheetH = bb.h;
    Renderer.sheetOutline = normalized;
    this._defects = [];
    Renderer.defects = [];
    this._updateDefectStats();
    Renderer.fitView();
    Renderer.draw();
    alert(`Imported custom SVG: ${bb.w.toFixed(0)}×${bb.h.toFixed(0)}mm`);
  },

  _extractSVGOutlines(doc) {
    const outlines = [];
    // Handle <polygon> and <polyline> directly
    for (const el of doc.querySelectorAll('polygon, polyline')) {
      const ptsAttr = el.getAttribute('points') || '';
      const coords = ptsAttr.trim().split(/[\s,]+/).map(parseFloat);
      const pts = [];
      for (let i = 0; i+1 < coords.length; i += 2) pts.push([coords[i], coords[i+1]]);
      if (pts.length >= 3) outlines.push(pts);
    }
    // Handle <rect>
    for (const el of doc.querySelectorAll('rect')) {
      const x = parseFloat(el.getAttribute('x')) || 0;
      const y = parseFloat(el.getAttribute('y')) || 0;
      const w = parseFloat(el.getAttribute('width'));
      const h = parseFloat(el.getAttribute('height'));
      if (w && h) outlines.push([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);
    }
    // Handle <path> (very simple — only M/L/z/close support, no Bezier)
    // For proper SVG path support we'd need a full parser; this covers
    // simple outlines exported from Illustrator/Inkscape as polygon-paths.
    for (const el of doc.querySelectorAll('path')) {
      const d = el.getAttribute('d') || '';
      const cmds = d.match(/[MLlCcQqZz][^MLlCcQqZz]*/g) || [];
      let pts = [];
      let px = 0, py = 0;
      for (const cmd of cmds) {
        const c = cmd[0];
        const nums = cmd.slice(1).trim().split(/[\s,]+/).filter(s=>s.length).map(parseFloat);
        if (c === 'M') { px = nums[0]; py = nums[1]; pts.push([px, py]); for (let i=2;i+1<nums.length;i+=2) { px=nums[i]; py=nums[i+1]; pts.push([px,py]); } }
        else if (c === 'L') { for (let i=0;i+1<nums.length;i+=2) { px=nums[i]; py=nums[i+1]; pts.push([px,py]); } }
        else if (c === 'l') { for (let i=0;i+1<nums.length;i+=2) { px+=nums[i]; py+=nums[i+1]; pts.push([px,py]); } }
        else if (c === 'Z' || c === 'z') { if (pts.length >= 3) { outlines.push(pts); } pts = []; }
        else if (c === 'C' || c === 'c') {
          // Cubic bezier — flatten to line segments. We only take the endpoint
          // for simplicity (produces polygon with fewer vertices).
          for (let i=0;i+5<nums.length;i+=6) {
            const ex = c === 'C' ? nums[i+4] : px + nums[i+4];
            const ey = c === 'C' ? nums[i+5] : py + nums[i+5];
            // Flatten to 6 samples along the curve
            const x1 = c === 'C' ? nums[i] : px + nums[i];
            const y1 = c === 'C' ? nums[i+1] : py + nums[i+1];
            const x2 = c === 'C' ? nums[i+2] : px + nums[i+2];
            const y2 = c === 'C' ? nums[i+3] : py + nums[i+3];
            for (let s = 1; s <= 6; s++) {
              const t = s/6;
              const mt = 1-t;
              const bx = mt*mt*mt*px + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*ex;
              const by = mt*mt*mt*py + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*ey;
              pts.push([bx, by]);
            }
            px = ex; py = ey;
          }
        }
      }
      if (pts.length >= 3) outlines.push(pts);
    }
    return outlines;
  },

  async _importCustomImage(file) {
    // Image path: decode → detect outline (largest dark/opaque region) →
    // extract contour → detect defects (dark spots inside outline)
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((r, j) => { img.onload = r; img.onerror = j; });
    // Downsize for processing speed
    const maxDim = 800;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(img.width * scale);
    canvas.height = Math.ceil(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Binary mask: "inside hide" = not-white pixels (assume white background)
    const W = canvas.width, H = canvas.height;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = imgData.data[i*4], g = imgData.data[i*4+1], b = imgData.data[i*4+2];
      const brightness = (r + g + b) / 3;
      mask[i] = brightness < 230 ? 1 : 0;  // dark = inside
    }
    // Extract outline via marching squares (simplified)
    const outline = this._traceOutline(mask, W, H);
    if (outline.length < 8) {
      alert('Could not detect hide outline in image. Try an image with clear contrast against a white background.');
      return;
    }
    // Real mm dimensions? User needs to specify — use a sensible default
    const realW = parseFloat(prompt('Actual width of the hide in mm:', '2200')) || 2200;
    const realH = realW * (H / W);
    // Scale outline pixel → mm
    const px2mm = realW / W;
    const mmOutline = outline.map(([x, y]) => [x * px2mm, y * px2mm]);
    // Defect detection: find very-dark regions inside the hide (scars, holes)
    const defectMask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (mask[i]) {
        const r = imgData.data[i*4], g = imgData.data[i*4+1], b = imgData.data[i*4+2];
        const brightness = (r + g + b) / 3;
        if (brightness < 90) defectMask[i] = 1;  // very dark = defect
      }
    }
    // Find connected blobs of defect pixels
    const defects = this._findDefectBlobs(defectMask, W, H, px2mm);

    // Normalize outline to origin
    const bb = polyBBox(mmOutline);
    const normalized = mmOutline.map(([x, y]) => [x - bb.x, y - bb.y]);
    const shiftedDefects = defects.map(d => ({ ...d, x: d.x - bb.x, y: d.y - bb.y }));

    this._sheetOutline = normalized;
    this._sheetType = 'custom';
    this._defects = shiftedDefects;
    document.getElementById('s-width').value = Math.ceil(bb.w);
    document.getElementById('s-height').value = Math.ceil(bb.h);
    Renderer.sheetW = bb.w;
    Renderer.sheetH = bb.h;
    Renderer.sheetOutline = normalized;
    Renderer.defects = shiftedDefects;
    this._updateDefectStats();
    Renderer.fitView();
    Renderer.draw();
    alert(`Imported image: ${bb.w.toFixed(0)}×${bb.h.toFixed(0)}mm\nDetected ${defects.length} defects. Edit manually if needed.`);
  },

  /* Simple outline tracer — find all-perimeter pixels of the largest
     connected blob in a binary mask, return as ordered polygon. */
  _traceOutline(mask, W, H) {
    // Find largest blob via flood fill
    const visited = new Uint8Array(W * H);
    let bestBlob = null;
    for (let i = 0; i < W * H; i++) {
      if (mask[i] && !visited[i]) {
        const stack = [i]; const blob = [];
        while (stack.length) {
          const p = stack.pop();
          if (visited[p] || !mask[p]) continue;
          visited[p] = 1; blob.push(p);
          const x = p % W, y = (p / W) | 0;
          if (x > 0) stack.push(p - 1);
          if (x < W-1) stack.push(p + 1);
          if (y > 0) stack.push(p - W);
          if (y < H-1) stack.push(p + W);
        }
        if (!bestBlob || blob.length > bestBlob.length) bestBlob = blob;
      }
    }
    if (!bestBlob || bestBlob.length < 100) return [];
    // Find boundary pixels of this blob
    const isBoundary = (p) => {
      if (!mask[p]) return false;
      const x = p % W, y = (p / W) | 0;
      if (x === 0 || y === 0 || x === W-1 || y === H-1) return true;
      return !mask[p-1] || !mask[p+1] || !mask[p-W] || !mask[p+W];
    };
    const boundary = bestBlob.filter(isBoundary);
    // Sort boundary pixels into an ordered polygon by finding nearest-neighbor chain
    const pts = boundary.map(p => [p % W, (p / W) | 0]);
    if (pts.length < 8) return [];
    // Sample every Nth point to reduce vertex count
    const step = Math.max(1, Math.floor(pts.length / 80));
    // Nearest-neighbor walk starting from the topmost-leftmost point
    let startIdx = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][1] < pts[startIdx][1] || (pts[i][1] === pts[startIdx][1] && pts[i][0] < pts[startIdx][0])) {
        startIdx = i;
      }
    }
    const ordered = [];
    const used = new Uint8Array(pts.length);
    let cur = startIdx;
    while (cur !== -1) {
      ordered.push(pts[cur]);
      used[cur] = 1;
      let best = -1; let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) {
        if (used[i]) continue;
        const dx = pts[i][0] - pts[cur][0], dy = pts[i][1] - pts[cur][1];
        const d = dx*dx + dy*dy;
        if (d < bestDist && d < 400) { bestDist = d; best = i; }
      }
      cur = best;
    }
    // Decimate
    return ordered.filter((_, i) => i % step === 0);
  },

  /* Find connected dark-blob regions in a mask, return as defects. */
  _findDefectBlobs(mask, W, H, px2mm) {
    const visited = new Uint8Array(W * H);
    const defects = [];
    for (let i = 0; i < W * H; i++) {
      if (mask[i] && !visited[i]) {
        const stack = [i]; const blob = [];
        while (stack.length) {
          const p = stack.pop();
          if (visited[p] || !mask[p]) continue;
          visited[p] = 1; blob.push(p);
          const x = p % W, y = (p / W) | 0;
          if (x > 0) stack.push(p - 1);
          if (x < W-1) stack.push(p + 1);
          if (y > 0) stack.push(p - W);
          if (y < H-1) stack.push(p + W);
        }
        if (blob.length < 25) continue;  // too small (noise)
        // Centroid + equivalent radius
        let sx = 0, sy = 0;
        for (const p of blob) { sx += p % W; sy += (p / W) | 0; }
        const cx = sx / blob.length, cy = sy / blob.length;
        const r = Math.sqrt(blob.length / Math.PI);
        defects.push({
          x: cx * px2mm, y: cy * px2mm, r: r * px2mm,
          type: 'mark', id: 'def_img_' + i,
        });
      }
    }
    return defects;
  },

  /* ══════════════════════════════════════════════════════════════════
     DXF IMPORT — delegators
     Implementation lives in the DXFImport module (before App).
     ═════════════════════════════════════════════════════════════════ */
  get _importQueue() { return DXFImport._importQueue; }, set _importQueue(v) { DXFImport._importQueue = v; },
  get _pendingFiles() { return DXFImport._pendingFiles; }, set _pendingFiles(v) { DXFImport._pendingFiles = v; },
  setupDragDrop()                 { return DXFImport.setupDragDrop.call(this); },
  _walkEntry(entry, files)        { return DXFImport._walkEntry.call(this, entry, files); },
  async _extractZip(zipFile)      { return DXFImport._extractZip(zipFile); },
  async _ingestDropped(files)     { return DXFImport._ingestDropped.call(this, files); },
  openFolder()                    { return DXFImport.openFolder(); },
  openZip()                       { return DXFImport.openZip(); },
  openFiles()                     { return DXFImport.openFiles(); },
  async loadFiles(files)          { return DXFImport.loadFiles.call(this, files); },
  _showSheetChoiceModal(c, m)     { return DXFImport._showSheetChoiceModal.call(this, c, m); },
  _cancelSheetChoice()            { return DXFImport._cancelSheetChoice.call(this); },
  _chooseSheet(choice)            { return DXFImport._chooseSheet.call(this, choice); },
  async _processSeparateSheetImports() { return DXFImport._processSeparateSheetImports.call(this); },
  _processNextImport()            { return DXFImport._processNextImport.call(this); },
  _classifyShapes(shapes)         { return DXFImport._classifyShapes(shapes); },
  _showImportModal(shapes, fn)    { return DXFImport._showImportModal.call(this, shapes, fn); },
  _updateImportPreview()          { return DXFImport._updateImportPreview.call(this); },
  confirmImport()                 { return DXFImport.confirmImport.call(this); },
  cancelImport()                  { return DXFImport.cancelImport.call(this); },
  extractClosedPolygons(shapes)   { return DXFImport.extractClosedPolygons.call(this, shapes); },
  _snapOpenToLoops(polylines, tol)         { return DXFImport._snapOpenToLoops(polylines, tol); },

  setupRotationToggles() {
    document.querySelectorAll('#rot-group .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });
  },

  setupGrainDir() {
    document.getElementById('grain-dir').addEventListener('change', e => {
      const val = e.target.value;
      const btns = document.querySelectorAll('#rot-group .toggle-btn');
      if (val === 'horizontal') {
        btns.forEach(b => { b.classList.remove('active'); if(b.dataset.rot==='0'||b.dataset.rot==='180') b.classList.add('active'); });
      } else if (val === 'vertical') {
        btns.forEach(b => { b.classList.remove('active'); if(b.dataset.rot==='90'||b.dataset.rot==='270') b.classList.add('active'); });
      }
    });
  },


  updatePartsUI() {
    const list = document.getElementById('parts-list');
    document.getElementById('parts-count').textContent = this.parts.length;
    list.innerHTML = '';
    for (const part of this.parts) {
      const displayName = this.getDisplayName(part.name);
      const isCustom = (this._partDisplayNames && this._partDisplayNames.get(part.name));
      const el = document.createElement('div');
      el.className = 'part-item' + (part.id === this.selectedPart ? ' selected' : '');
      const flipH = (part._flipH === true);
      const flipV = (part._flipV === true);
      el.innerHTML = `
        <div class="part-color" style="background:${part.color}"></div>
        <div style="flex:1;min-width:0">
          <div class="part-name" style="display:flex;align-items:center;gap:4px">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${part.name}${isCustom ? '  (original: ' + part.name + ')' : ''}">${displayName}</span>
            <button class="part-rename-btn" title="Rename component" onclick="event.stopPropagation();App.renamePart('${part.name.replace(/'/g, "\\'")}')" style="background:none;border:none;color:var(--text3);cursor:pointer;padding:0 2px;font-size:11px;flex-shrink:0">✎</button>
            <button class="part-flip-btn" title="Flip horizontal (left ↔ right mirror)" onclick="event.stopPropagation();App.flipPart('${part.id}','h')" style="background:${flipH ? 'var(--accent)' : 'none'};border:none;color:${flipH ? '#000' : 'var(--text3)'};cursor:pointer;padding:1px 4px;font-size:11px;border-radius:3px;flex-shrink:0;font-weight:${flipH ? '700' : '400'}">⇋</button>
            <button class="part-flip-btn" title="Flip vertical (top ↔ bottom mirror)" onclick="event.stopPropagation();App.flipPart('${part.id}','v')" style="background:${flipV ? 'var(--accent)' : 'none'};border:none;color:${flipV ? '#000' : 'var(--text3)'};cursor:pointer;padding:1px 4px;font-size:11px;border-radius:3px;flex-shrink:0;font-weight:${flipV ? '700' : '400'}">⇅</button>
          </div>
          <div class="part-meta">${part.bbox.w.toFixed(1)}×${part.bbox.h.toFixed(1)}mm · ${part.area.toFixed(0)}mm²${flipH ? ' · ⇋' : ''}${flipV ? ' · ⇅' : ''}</div>
        </div>
        <div class="part-qty-wrap">
          <button class="qty-btn" onclick="App.changeQty('${part.id}',-1)">−</button>
          <div class="qty-val">${part.qty}</div>
          <button class="qty-btn" onclick="App.changeQty('${part.id}',1)">+</button>
        </div>
        <button class="part-del" onclick="App.removePart('${part.id}')">✕</button>`;
      el.querySelector('.part-name span').addEventListener('click', () => { this.selectedPart = part.id; this.updatePartsUI(); });
      list.appendChild(el);
    }
  },

  /* ══════════════════════════════════════════════════════════════════
     COMPONENT RENAME
     ─────────────────────────────────────────────────────────────────
     Original part.name is preserved (engine uses it as identity key).
     User-provided display name is stored in App._partDisplayNames map
     keyed by original name. Persists in localStorage so renames survive
     page reload. Use App.getDisplayName(originalName) anywhere a name
     is shown to the user.

     Multiple parts with the same original name (e.g. 5 quarter pieces)
     share the same display name — rename once, all renders update.
     ═════════════════════════════════════════════════════════════════ */

  _partDisplayNames: null,  // Map<originalName, customName>

  _initDisplayNames() {
    if (this._partDisplayNames) return;
    this._partDisplayNames = new Map();
    try {
      const saved = localStorage.getItem('nestforge_display_names');
      if (saved) {
        const obj = JSON.parse(saved);
        for (const [k, v] of Object.entries(obj)) this._partDisplayNames.set(k, v);
      }
    } catch (_) {}
  },

  _saveDisplayNames() {
    if (!this._partDisplayNames) return;
    try {
      const obj = {};
      for (const [k, v] of this._partDisplayNames) obj[k] = v;
      localStorage.setItem('nestforge_display_names', JSON.stringify(obj));
    } catch (_) {}
  },

  getDisplayName(originalName) {
    if (!originalName) return '';
    this._initDisplayNames();
    return this._partDisplayNames.get(originalName) || originalName;
  },

  renamePart(originalName) {
    this._initDisplayNames();
    const current = this._partDisplayNames.get(originalName) || originalName;
    const next = prompt(
      `Rename component:\n\nOriginal: ${originalName}\n\nEnter new display name (leave empty to reset):`,
      current
    );
    if (next === null) return;  // user cancelled
    const trimmed = next.trim();
    if (!trimmed || trimmed === originalName) {
      // Empty or same as original → reset to original
      this._partDisplayNames.delete(originalName);
    } else {
      this._partDisplayNames.set(originalName, trimmed);
    }
    this._saveDisplayNames();
    // Refresh all UI — parts list, costing, leather norm, renderer labels
    this.updatePartsUI();
    Renderer.draw();
    if (this._updateCosting) this._updateCosting();
    // If LeatherNorm dialog is open, refresh its panel too
    if (typeof LeatherNorm !== 'undefined' && LeatherNorm._isOpen && LeatherNorm._isOpen()) {
      LeatherNorm._refreshList && LeatherNorm._refreshList();
      LeatherNorm._renderActive && LeatherNorm._renderActive();
    }
  },

  /* ══════════════════════════════════════════════════════════════════
     COMPONENT FLIP (manual mirror toggle)
     ─────────────────────────────────────────────────────────────────
     User clicks ⇋ or ⇅ next to a component to flip its polygon. The
     flipped polygon REPLACES the original — engine, renderer, costing,
     norm calculator all see the flipped shape from now on.

     Two axes:
       'h' → horizontal flip = X-axis reflection (x → -x)
              (left ↔ right swap, like left-shoe ↔ right-shoe)
       'v' → vertical flip   = Y-axis reflection (y → -y)
              (top ↔ bottom swap, like heel ↔ toe)

     Toggling the same axis again un-flips. Both axes can be active
     simultaneously (which equals 180° rotation).

     The flip is applied to:
       - part.pts     (main polygon)
       - part.innerLines[].pts  (inner cut lines, e.g. holes/slots)
     bbox is recomputed to match. nestResult is invalidated since the
     part shape changed.

     The flipH/flipV flags are stored on part for UI display (highlights
     the active axis button) and persist in project save files.
     ═════════════════════════════════════════════════════════════════ */

  flipPart(partId, axis) {
    const part = this.parts.find(p => p.id === partId);
    if (!part) return;

    // The actual flip operation on a list of [x,y] points
    const flipPts = (pts, axis) => {
      if (axis === 'h') return pts.map(p => [-p[0], p[1]]);
      if (axis === 'v') return pts.map(p => [p[0], -p[1]]);
      return pts;
    };
    // Re-normalize to positive coords (engine/renderer expect this)
    const normalize = (pts) => {
      let minX = Infinity, minY = Infinity;
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
      return { pts: pts.map(p => [p[0] - minX, p[1] - minY]), minX, minY };
    };

    // Apply flip to outer polygon
    const flipped = flipPts(part.pts, axis);
    const { pts: normPts, minX, minY } = normalize(flipped);
    part.pts = normPts;

    // Apply same flip + same offset to every inner cut line so they
    // stay aligned with the outer polygon
    if (Array.isArray(part.innerLines)) {
      for (const line of part.innerLines) {
        if (line && Array.isArray(line.pts)) {
          const lf = flipPts(line.pts, axis);
          line.pts = lf.map(p => [p[0] - minX, p[1] - minY]);
        }
      }
    }

    // Recompute bbox from new pts
    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    for (const [x, y] of part.pts) {
      if (x < bbMinX) bbMinX = x;
      if (y < bbMinY) bbMinY = y;
      if (x > bbMaxX) bbMaxX = x;
      if (y > bbMaxY) bbMaxY = y;
    }
    part.bbox = {
      x: bbMinX, y: bbMinY,
      w: bbMaxX - bbMinX, h: bbMaxY - bbMinY,
      // Some places use minX/maxX naming convention
      minX: bbMinX, minY: bbMinY, maxX: bbMaxX, maxY: bbMaxY,
    };

    // Toggle flip flag for UI highlight + persistence
    if (axis === 'h') part._flipH = !part._flipH;
    else if (axis === 'v') part._flipV = !part._flipV;

    // Invalidate any cached nest — geometry changed
    this.nestResult = null;
    Renderer.nestResult = null;

    // Refresh all displays
    this.updatePartsUI();
    Renderer.draw();
    this._saveCurrentWS && this._saveCurrentWS();
    if (typeof LeatherNorm !== 'undefined' && LeatherNorm._isOpen && LeatherNorm._isOpen()) {
      LeatherNorm._refreshList && LeatherNorm._refreshList();
      LeatherNorm._renderActive && LeatherNorm._renderActive();
    }
  },

  changeQty(id, delta) {
    const part = this.parts.find(p => p.id === id);
    if (!part) return;
    part.qty = Math.max(1, part.qty + delta);
    this.nestResult = null;
    this.updatePartsUI();
    this.updateUI();
  },

  removePart(id) {
    this.parts = this.parts.filter(p => p.id !== id);
    this.nestResult = null;
    this._resetRulesMode && this._resetRulesMode();
    Renderer.parts = this.parts;
    Renderer.nestResult = null;
    this.updatePartsUI();
    this.updateUI();
    Renderer.draw();
    document.getElementById('empty-canvas').style.display = this.parts.length ? 'none' : 'flex';
  },

  getSettings() {
    const activeRots = [];
    document.querySelectorAll('#rot-group .toggle-btn.active').forEach(b => activeRots.push(parseInt(b.dataset.rot)));
    if (!activeRots.length) activeRots.push(0);
    // Margin in CURRENT unit, converted to mm
    const _uMargin = this._unitToMM();
    const margin = (parseFloat(document.getElementById('s-margin').value) || 5) * _uMargin;

    // ── Leather sheet: translate outline/defects by -margin ──
    // Engines work in "usable area" coordinates (sheet origin is at (margin, margin)
    // in world space). So we subtract margin from outline/defect coordinates
    // so they align with the usable area.
    let sheetOutline = null;
    let defects = null;
    if (this._sheetOutline) {
      // Shrink the hide outline inward by `margin` (offset negative)
      const shrunk = PU.offsetSingle(this._sheetOutline, -margin, 'square') || this._sheetOutline;
      // Then translate so (margin,margin) of world = (0,0) of usable area
      sheetOutline = shrunk.map(([x, y]) => [x - margin, y - margin]);
    }
    if (this._defects && this._defects.length) {
      // Defects: shift from world coords to usable-area coords. Also shift
      // the shape polygon (irregular outline) if present.
      defects = this._defects.map(d => ({
        ...d,
        x: d.x - margin,
        y: d.y - margin,
        shape: d.shape ? d.shape.map(([sx, sy]) => [sx - margin, sy - margin]) : undefined,
      }));
    }

    // ── Leather zone labels: translate by -margin too ──
    let sheetLabels = null;
    if (this._sheetLabels && this._sheetLabels.length) {
      sheetLabels = this._sheetLabels.map(l => ({
        ...l,
        x: l.x - margin,
        y: l.y - margin,
      }));
    }
    // ── Leather zone BOUNDARY CURVES: translate by -margin too ──
    // These are the actual drawn boundary lines between zones (e.g. the
    // curve separating BUTT from BELLY). Used by the engine to classify
    // a sample point as inside-zone-X only when no boundary curve lies
    // between the point and the zone center — fixes Voronoi misclassification.
    let sheetZoneCurves = null;
    if (this._sheetZones && this._sheetZones.length) {
      sheetZoneCurves = this._sheetZones.map(curve =>
        curve.map(([x, y]) => [x - margin, y - margin]));
    }

    // Convert UI dimensions (in current display unit) to mm for the engine.
    // Engine always works in millimeters internally; UI may show cm/m/inch/feet.
    const _u = this._unitToMM();
    return {
      sheetW:    (parseFloat(document.getElementById('s-width').value)  || 1200) * _u,
      sheetH:    (parseFloat(document.getElementById('s-height').value) || 600)  * _u,
      margin:    margin,  // already converted above where margin is computed
      gap:       (parseFloat(document.getElementById('s-gap').value) || 2) * _u,
      rotations: activeRots,
      sortBy:    document.getElementById('sort-by').value,
      resolution: parseFloat(document.getElementById('resolution').value) || 1,
      mirrorMode: document.getElementById('mirror-mode').value,
      copies:    parseInt(document.getElementById('s-copies').value) || 1,
      fillSheet: !!this._fillSheetMode,
      multiSheet: (() => {
        const cb = document.getElementById('s-multi-sheet');
        return cb ? cb.checked : true;
      })(),
      cuttingFlow: document.getElementById('flow-enable').checked,
      flowDir:     document.getElementById('flow-dir').value,
      sheetOutline,  // null = rectangular; otherwise polygon in usable-area coords
      defects,       // null = no defects; otherwise [{x,y,r,...}] in usable-area coords
      sheetLabels,   // zone labels for zone-constrained placement, or null
      sheetZoneCurves,  // zone boundary curves for accurate classification
      componentRules: this._componentRules,  // Map<componentKey, rule> with allowedZones
      autoLength: (function() {
        const el = document.getElementById('s-auto-length');
        return el ? !!el.checked : true;
      })(),
      // Which way the sheet grows when parts overflow: 'length' (height,
      // width fixed), 'width' (height fixed) or 'both' (proportionally).
      growDir: (function() {
        const el = document.getElementById('s-grow-dir');
        return el && ['length', 'width', 'both'].includes(el.value) ? el.value : 'length';
      })(),
    };
  },

  _onGrowToggle() {
    const on = document.getElementById('s-auto-length').checked;
    const row = document.getElementById('grow-dir-row');
    if (row) row.style.opacity = on ? '' : '0.45';
    const sel = document.getElementById('s-grow-dir');
    if (sel) sel.disabled = !on;
  },

  async runNesting() {
    if (!this.parts.length) return;

    // ── Per-component rules popup ────────────────────────────────────
    // If ≥2 distinct component types are loaded AND user hasn't already set
    // (or explicitly skipped) per-component rules this session, show the
    // popup so they can fine-tune rotations/mirror/grain per component.
    if (this._shouldAskComponentRules()) {
      this._openRulesModal();
      return; // Rules modal will call _runNestingProceed() when user confirms
    }

    return this._runNestingProceed();
  },

  /* Returns true if the popup should be shown for this Run click. */
  _shouldAskComponentRules() {
    // Skip if user already chose (including "Use Default" which stores _rulesMode='default')
    if (this._rulesMode) return false;
    // Count distinct LOGICAL components (after stripping _N size suffix).
    // Multiple sizes of the same component count as one.
    const keys = new Set();
    for (const p of this.parts) keys.add(this._componentKey(p));
    return keys.size >= 2;
  },

  /* ══════════════════════════════════════════════════════════════════
     PER-COMPONENT RULES MODAL
     Session-level state:
       _rulesMode: null | 'default' | 'custom'
       _componentRules: Map<componentKey, {rotations, mirror, grainDir, fixedAngle, useGlobal}>
     Component key = p.name (fallback: p.id). Parts sharing a name share rules.
     ═════════════════════════════════════════════════════════════════ */

  /* Returns a stable grouping key for a part. Parts imported from a DXF
     with multiple boundaries get auto-suffixed names like "vamp_1", "vamp_2"
     — these are the SAME logical component (just different sizes from a
     grade-set DXF), so we strip the trailing "_N" suffix to make them share
     a single rules row. A leading/trailing digit sequence after an
     underscore is treated as a size marker, not part of the component name. */
  _componentKey(p) {
    const raw = (p.name || p.id || '');
    // Strip trailing _<digits> (e.g. "vamp_3" → "vamp", "tng_zig_12" → "tng_zig")
    return raw.replace(/_\d+$/, '');
  },

  /* Open the modal: build one row per distinct component, pre-populate
     from _componentRules if the user already set things earlier. */
  _openRulesModal() {
    // Collect distinct components (first occurrence wins for preview/points)
    const seen = new Map();
    for (const p of this.parts) {
      const k = this._componentKey(p);
      if (!seen.has(k)) seen.set(k, p);
    }
    const body = document.getElementById('rm-body');
    body.innerHTML = '';
    for (const [key, p] of seen) {
      body.appendChild(this._buildRulesRow(key, p));
    }
    document.getElementById('rm-hdr-sub').textContent =
      `${seen.size} distinct component${seen.size>1?'s':''} — each can follow default rules or have custom rules`;
    this._updateRulesSummary();
    document.getElementById('rules-modal').classList.add('active');
  },

  _buildRulesRow(key, part) {
    const existing = this._componentRules && this._componentRules.get(key);
    const useCustom = !!(existing && !existing.useGlobal);

    const row = document.createElement('div');
    row.className = 'rm-comp';
    row.dataset.key = key;

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'rm-comp-thumb';
    const canvas = document.createElement('canvas');
    canvas.width = 144; canvas.height = 144;  // retina-ish
    thumb.appendChild(canvas);
    row.appendChild(thumb);

    // Draw part into canvas
    this._drawPartThumb(canvas, part);

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'rm-comp-body';

    const bb = polyBBox(part.pts);
    const count = this.parts.filter(p => this._componentKey(p) === key).length;
    bodyEl.innerHTML = `
      <div class="rm-comp-hdr">
        <div class="rm-comp-name"></div>
        <div class="rm-comp-meta"></div>
      </div>
      <div class="rm-comp-mode">
        <button class="rm-mode-btn" data-mode="default">Default rules</button>
        <button class="rm-mode-btn" data-mode="custom">Custom rules</button>
      </div>
      <div class="rm-comp-custom">
        <div class="rm-row">
          <div class="rm-row-lbl">Rotations</div>
          <button class="rm-toggle" data-rot="0">0°</button>
          <button class="rm-toggle" data-rot="90">90°</button>
          <button class="rm-toggle" data-rot="180">180°</button>
          <button class="rm-toggle" data-rot="270">270°</button>
        </div>
        <div class="rm-row">
          <div class="rm-row-lbl" title="Optional = engine tries with/without mirror, picks best. Compulsory = every part MUST be mirrored, original orientation never used.">Mirror</div>
          <select class="rm-select" data-field="mirror">
            <optgroup label="No Mirror">
              <option value="none">None</option>
            </optgroup>
            <optgroup label="Optional (try both)">
              <option value="x">Flip X (optional)</option>
              <option value="y">Flip Y (optional)</option>
              <option value="both">Both (optional)</option>
            </optgroup>
            <optgroup label="Compulsory (must mirror)">
              <option value="x-must">Flip X (must)</option>
              <option value="y-must">Flip Y (must)</option>
              <option value="both-must">Both (must)</option>
            </optgroup>
          </select>
        </div>
        <div class="rm-row">
          <div class="rm-row-lbl">Grain</div>
          <select class="rm-select" data-field="grain">
            <option value="auto">Auto (follow global)</option>
            <option value="0">Horizontal (0°)</option>
            <option value="90">Vertical (90°)</option>
            <option value="free">No grain constraint</option>
          </select>
        </div>
        <div class="rm-row">
          <div class="rm-row-lbl">Fixed</div>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);cursor:pointer">
            <input type="checkbox" data-field="useFixed" style="accent-color:var(--accent);width:13px;height:13px">
            <span>Lock to exact angle</span>
          </label>
          <input type="number" class="rm-num" data-field="fixedAngle" value="0" step="5" min="0" max="359" placeholder="°">
          <span style="font-size:10px;color:var(--text3)">°</span>
        </div>
        <div class="rm-row">
          <div class="rm-row-lbl" title="Let the nester tilt this component by ±N° for better interlocking">Tolerance</div>
          <input type="range" data-field="tolerance" min="0" max="45" step="5" value="0" style="flex:1;max-width:180px;accent-color:var(--accent)">
          <span class="rm-num" data-field="tolDisplay" style="cursor:default;text-align:center;min-width:42px">0°</span>
          <span style="font-size:10px;color:var(--text3);flex:1;min-width:0">± wiggle room for interlocking</span>
        </div>
      </div>
      <!-- ALWAYS-VISIBLE section (independent of default/custom mode) -->
      <div class="rm-always" style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)">
        <div class="rm-row" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px">
          <div class="rm-row-lbl" title="Allow the nester to try arbitrary rotation angles (not just 0/90/180/270). Slower but can find tighter nests.">Free Rotation</div>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);cursor:pointer">
            <input type="checkbox" data-field="freeRot" style="accent-color:var(--accent);width:13px;height:13px">
            <span>Try every angle</span>
          </label>
          <select class="rm-select" data-field="freeRotStep" style="max-width:140px">
            <option value="45">Step: 45° (8 angles)</option>
            <option value="30" selected>Step: 30° (12 angles)</option>
            <option value="20">Step: 20° (18 angles)</option>
            <option value="15">Step: 15° (24 angles)</option>
            <option value="10">Step: 10° (36 angles)</option>
            <option value="5">Step: 5° (72 angles, slow)</option>
          </select>
          <span style="font-size:10px;color:var(--text3);flex:1;min-width:0">Smaller step = tighter nests, slower</span>
        </div>
        <div class="rm-row rm-zones-row" style="display:${(this._sheetType && this._sheetType !== 'rectangle' && this._sheetType !== 'custom') ? 'flex' : 'none'};flex-wrap:wrap;align-items:center;gap:4px">
          <div class="rm-row-lbl" title="Restrict this component to specific anatomical zones of the hide">Allowed Zones</div>
          <button class="rm-toggle rm-zone-btn" data-zone="butt"        style="background:rgba(45,143,45,0.15);border-color:#2d8f2d">BUTT</button>
          <button class="rm-toggle rm-zone-btn" data-zone="shoulder"    style="background:rgba(140,179,59,0.15);border-color:#8cb33b">SHOULDER</button>
          <button class="rm-toggle rm-zone-btn" data-zone="neck"        style="background:rgba(212,168,23,0.15);border-color:#d4a817">NECK</button>
          <button class="rm-toggle rm-zone-btn" data-zone="belly"       style="background:rgba(212,120,23,0.15);border-color:#d47817">BELLY</button>
          <button class="rm-toggle rm-zone-btn" data-zone="fore_flank"  style="background:rgba(199,58,58,0.15);border-color:#c73a3a">FORE FLANK</button>
          <button class="rm-toggle rm-zone-btn" data-zone="hind_flank"  style="background:rgba(199,58,58,0.15);border-color:#c73a3a">HIND FLANK</button>
          <span style="font-size:10px;color:var(--text3);flex-basis:100%;margin-top:2px">Leave all OFF to allow any zone (no restriction)</span>
        </div>
        <div class="rm-row" style="display:flex;align-items:center;gap:6px;margin-top:4px">
          <div class="rm-row-lbl" title="How many of THIS component per complete set (e.g., 1 vamp + 2 quarters per shoe)">Per Set</div>
          <input type="number" class="rm-num" data-field="setCount" value="0" step="1" min="0" max="100" style="width:60px" placeholder="0">
          <span style="font-size:10px;color:var(--text3);flex:1;min-width:0">0 = not in a set • e.g., 1 vamp + 2 quarters = one pair of shoes</span>
        </div>
      </div>
    `;
    bodyEl.querySelector('.rm-comp-name').textContent = part.name || key;
    bodyEl.querySelector('.rm-comp-meta').textContent =
      `${count}× • ${bb.w.toFixed(0)}×${bb.h.toFixed(0)}mm`;
    row.appendChild(bodyEl);

    // Wire up mode buttons
    const modeBtns = bodyEl.querySelectorAll('.rm-mode-btn');
    const custom = bodyEl.querySelector('.rm-comp-custom');
    const setMode = (m) => {
      modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
      custom.classList.toggle('visible', m === 'custom');
      this._updateRulesSummary();
    };
    modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // Wire up rotation toggles
    bodyEl.querySelectorAll('.rm-toggle[data-rot]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        this._updateRulesSummary();
      });
    });
    // Wire up zone toggles (click to include/exclude zone for this component)
    bodyEl.querySelectorAll('.rm-zone-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        this._updateRulesSummary();
      });
    });
    bodyEl.querySelectorAll('.rm-select, input[data-field]').forEach(el => {
      el.addEventListener('change', () => this._updateRulesSummary());
    });

    // Tolerance slider: live-update its display label as user drags
    const tolSlider = bodyEl.querySelector('[data-field="tolerance"]');
    const tolDisp = bodyEl.querySelector('[data-field="tolDisplay"]');
    if (tolSlider && tolDisp) {
      const updateTol = () => { tolDisp.textContent = '±' + tolSlider.value + '°'; };
      tolSlider.addEventListener('input', updateTol);
      updateTol();
    }

    // Initial state: from _componentRules, else default
    if (useCustom) {
      setMode('custom');
      for (const r of (existing.rotations || [])) {
        const btn = bodyEl.querySelector(`.rm-toggle[data-rot="${r}"]`);
        if (btn) btn.classList.add('active');
      }
      bodyEl.querySelector('[data-field="mirror"]').value = existing.mirror || 'none';
      bodyEl.querySelector('[data-field="grain"]').value = existing.grainDir != null ? String(existing.grainDir) : 'auto';
      bodyEl.querySelector('[data-field="useFixed"]').checked = existing.fixedAngle != null;
      bodyEl.querySelector('[data-field="fixedAngle"]').value = existing.fixedAngle != null ? existing.fixedAngle : 0;
      if (tolSlider) {
        tolSlider.value = existing.tolerance || 0;
        tolDisp.textContent = '±' + tolSlider.value + '°';
      }
      // Restore Free Rotation state (new feature — checkbox + step)
      const freeRotEl = bodyEl.querySelector('[data-field="freeRot"]');
      const freeRotStepEl = bodyEl.querySelector('[data-field="freeRotStep"]');
      if (freeRotEl) freeRotEl.checked = !!existing.freeRot;
      if (freeRotStepEl && existing.freeRotStep) freeRotStepEl.value = String(existing.freeRotStep);
    } else {
      setMode('default');
      // Default: pre-check 0° and 180° (most common)
      bodyEl.querySelector('.rm-toggle[data-rot="0"]').classList.add('active');
      bodyEl.querySelector('.rm-toggle[data-rot="180"]').classList.add('active');
    }
    // Restore zones + setCount regardless of custom/default mode
    // (these are always-on fields)
    if (existing && existing.allowedZones && existing.allowedZones.size) {
      for (const z of existing.allowedZones) {
        const btn = bodyEl.querySelector(`.rm-zone-btn[data-zone="${z}"]`);
        if (btn) btn.classList.add('active');
      }
    }
    if (existing && existing.setCount) {
      const si = bodyEl.querySelector('[data-field="setCount"]');
      if (si) si.value = existing.setCount;
    }
    return row;
  },

  /* Draw a normalized preview of the part centered & scaled to canvas. */
  _drawPartThumb(canvas, part) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#13151c';
    ctx.fillRect(0, 0, W, H);
    const bb = polyBBox(part.pts);
    if (!bb || bb.w <= 0 || bb.h <= 0) return;
    const pad = 10;
    const scale = Math.min((W - 2*pad) / bb.w, (H - 2*pad) / bb.h);
    const offX = (W - bb.w * scale) / 2 - bb.x * scale;
    const offY = (H - bb.h * scale) / 2 - bb.y * scale;
    ctx.beginPath();
    for (let i = 0; i < part.pts.length; i++) {
      const [x, y] = part.pts[i];
      const sx = x * scale + offX;
      const sy = y * scale + offY;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.fillStyle = (part.color || '#3b82f6') + '55';
    ctx.fill();
    ctx.strokeStyle = part.color || '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  },

  _updateRulesSummary() {
    const rows = document.querySelectorAll('#rm-body .rm-comp');
    let cust = 0;
    for (const r of rows) {
      const m = r.querySelector('.rm-mode-btn.active');
      if (m && m.dataset.mode === 'custom') cust++;
    }
    const el = document.getElementById('rm-summary');
    if (cust === 0) el.innerHTML = `<b>All</b> using default global rules`;
    else el.innerHTML = `<b>${cust}</b> custom, <b>${rows.length - cust}</b> default`;
  },

  _closeRulesModal() {
    document.getElementById('rules-modal').classList.remove('active');
  },

  /* "Use Default & Run" — skip per-component rotation/mirror overrides, but
     still capture zone constraints and set-quantity configs (those are
     independent of default/custom mode). */
  _runRulesModalDefault() {
    const rules = new Map();
    const rows = document.querySelectorAll('#rm-body .rm-comp');
    let anyExtras = false;
    for (const row of rows) {
      const key = row.dataset.key;
      const allowedZones = new Set();
      row.querySelectorAll('.rm-zone-btn.active').forEach(b => allowedZones.add(b.dataset.zone));
      const setCountInput = row.querySelector('[data-field="setCount"]');
      const setCount = setCountInput ? (parseInt(setCountInput.value, 10) || 0) : 0;
      // Free Rotation also captured in default mode (it's an always-visible
      // field that works regardless of default/custom rotation setup).
      const freeRotEl = row.querySelector('[data-field="freeRot"]');
      const freeRotStepEl = row.querySelector('[data-field="freeRotStep"]');
      const freeRot = !!(freeRotEl && freeRotEl.checked);
      const freeRotStep = (freeRotStepEl && parseInt(freeRotStepEl.value, 10)) || 30;
      if (allowedZones.size || setCount > 0 || freeRot) {
        anyExtras = true;
        rules.set(key, {
          useGlobal: true,
          allowedZones: allowedZones.size ? allowedZones : null,
          setCount,
          freeRot,
          freeRotStep,
        });
      } else {
        rules.set(key, { useGlobal: true });
      }
    }
    this._rulesMode = anyExtras ? 'custom' : 'default';
    this._componentRules = anyExtras ? rules : null;
    this._closeRulesModal();
    // Route back to whichever button triggered the modal
    if (this._postRulesAction === 'advanced') {
      this._postRulesAction = null;
      this.runAdvancedNesting();
    } else {
      this._runNestingProceed();
    }
  },

  /* "Run with These Rules" — read each component's settings and save. */
  _runRulesModalCustom() {
    const rules = new Map();
    const rows = document.querySelectorAll('#rm-body .rm-comp');
    let anyCustom = false;
    for (const row of rows) {
      const key = row.dataset.key;
      const mode = row.querySelector('.rm-mode-btn.active')?.dataset.mode || 'default';
      // Always-on fields (zones + setCount + freeRot) — captured regardless of mode
      const allowedZones = new Set();
      row.querySelectorAll('.rm-zone-btn.active').forEach(b => allowedZones.add(b.dataset.zone));
      const setCountInput = row.querySelector('[data-field="setCount"]');
      const setCount = setCountInput ? (parseInt(setCountInput.value, 10) || 0) : 0;
      // Free Rotation: when enabled, engine tries angles every freeRotStep
      // degrees (e.g. 30° step → 12 angles 0/30/60/.../330). Available for
      // BOTH default and custom modes — works on top of whatever rotation
      // settings are otherwise active.
      const freeRotEl = row.querySelector('[data-field="freeRot"]');
      const freeRotStepEl = row.querySelector('[data-field="freeRotStep"]');
      const freeRot = !!(freeRotEl && freeRotEl.checked);
      const freeRotStep = (freeRotStepEl && parseInt(freeRotStepEl.value, 10)) || 30;

      if (mode !== 'custom') {
        rules.set(key, {
          useGlobal: true,
          allowedZones: allowedZones.size ? allowedZones : null,
          setCount,
          freeRot,
          freeRotStep,
        });
        continue;
      }
      anyCustom = true;
      const rots = [];
      row.querySelectorAll('.rm-toggle[data-rot].active').forEach(b => rots.push(parseInt(b.dataset.rot, 10)));
      const mirror = row.querySelector('[data-field="mirror"]').value;
      const grainStr = row.querySelector('[data-field="grain"]').value;
      const useFixed = row.querySelector('[data-field="useFixed"]').checked;
      const fixedAngle = parseFloat(row.querySelector('[data-field="fixedAngle"]').value) || 0;
      const tolerance = parseFloat(row.querySelector('[data-field="tolerance"]').value) || 0;
      rules.set(key, {
        useGlobal: false,
        rotations: rots.length ? rots : [0],
        mirror,
        grainDir: (grainStr === 'auto' || grainStr === 'free') ? null : parseInt(grainStr, 10),
        grainFree: grainStr === 'free',
        fixedAngle: useFixed ? (fixedAngle % 360) : null,
        tolerance,
        freeRot,
        freeRotStep,
        allowedZones: allowedZones.size ? allowedZones : null,
        setCount,
      });
    }
    this._rulesMode = (anyCustom || [...rules.values()].some(r => r.allowedZones || r.setCount)) ? 'custom' : 'default';
    this._componentRules = rules;
    this._closeRulesModal();
    if (this._postRulesAction === 'advanced') {
      this._postRulesAction = null;
      this.runAdvancedNesting();
    } else {
      this._runNestingProceed();
    }
  },

  /* Reset per-component rules when part list changes (so next Run re-prompts). */
  _resetRulesMode() {
    this._rulesMode = null;
    this._componentRules = null;
  },

  /* Compute an alignment angle (degrees) that rotates the part so its
     natural orientation aligns with the sheet axes. After alignment,
     rotation=0° = lying flat horizontal, rotation=90° = standing vertical.

     Uses three complementary methods and picks the most visually intuitive:
     1) Min-area bounding rectangle (0.05° precision)
     2) PCA — long axis of mass distribution
     3) Vertical-symmetry search — for bilateral parts like vamps/tongues,
        find the angle where the shape best matches its mirror reflection.
        This captures what a human means by "upright" even when the mass
        distribution is asymmetric (e.g. tongue cutout pulls PCA off-axis).

     Strategy: for parts with strong bilateral symmetry (score > 0.8),
     use the symmetry angle — it matches human intuition. Otherwise fall
     back to PCA (elongated) or min-area-rect (compact). */
  _computeAlignmentAngle(pts) {
    if (!pts || pts.length < 3) return 0;

    // Centroid
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    cx /= pts.length; cy /= pts.length;

    // ── Method 1: Min-area bounding rectangle (2-pass) ──
    const scanArea = (startDeg, endDeg, step) => {
      let minArea = Infinity, bestAngle = 0, bestW = 0, bestH = 0;
      for (let deg = startDeg; deg < endDeg; deg += step) {
        const rad = deg * Math.PI / 180;
        const c = Math.cos(rad), s = Math.sin(rad);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of pts) {
          const rx = x * c + y * s;
          const ry = -x * s + y * c;
          if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
          if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
        }
        const w = maxX - minX, h = maxY - minY;
        const area = w * h;
        if (area < minArea) { minArea = area; bestAngle = deg; bestW = w; bestH = h; }
      }
      return { angle: bestAngle, w: bestW, h: bestH };
    };
    const coarse = scanArea(0, 90, 0.5);
    const fine = scanArea(coarse.angle - 0.5, coarse.angle + 0.5, 0.05);
    let rectAngle = -fine.angle;
    if (fine.h > fine.w) rectAngle -= 90;

    // ── Method 2: PCA ──
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) {
      const dx = x - cx, dy = y - cy;
      sxx += dx*dx; syy += dy*dy; sxy += dx*dy;
    }
    sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
    const trace = sxx + syy;
    const det = sxx*syy - sxy*sxy;
    const disc = Math.max(0, trace*trace/4 - det);
    const lam1 = trace/2 + Math.sqrt(disc);
    const lam2 = trace/2 - Math.sqrt(disc);
    let pcaAngle;
    if (Math.abs(sxy) < 1e-9) {
      pcaAngle = sxx >= syy ? 0 : 90;
    } else {
      pcaAngle = Math.atan2(lam1 - sxx, sxy) * 180 / Math.PI;
    }
    while (pcaAngle >= 90)  pcaAngle -= 180;
    while (pcaAngle < -90)  pcaAngle += 180;
    let pcaAlign = -pcaAngle;
    const elong = lam2 > 1e-9 ? Math.sqrt(lam1 / lam2) : 99;

    // ── Method 3: Symmetry search ──
    // Rasterize the polygon into a coarse grid centered on the centroid,
    // then for each candidate angle, rotate and compute how well the left
    // half of the shape matches the right half (mirror symmetry score).
    // The angle with the highest symmetry is the "upright" axis for
    // bilateral parts like vamps, tongues, back loops.
    const GRID = 48;  // grid resolution (48×48 = 2304 cells)
    // Translate pts so centroid is origin
    const cpts = pts.map(([x, y]) => [x - cx, y - cy]);
    // Find max absolute extent for scaling
    let maxAbs = 0;
    for (const [x, y] of cpts) {
      if (Math.abs(x) > maxAbs) maxAbs = Math.abs(x);
      if (Math.abs(y) > maxAbs) maxAbs = Math.abs(y);
    }
    if (maxAbs < 1e-6) return 0;
    const scale = (GRID / 2 - 1) / maxAbs;
    // Rasterize (point-in-polygon via even-odd crossings) at rotation=0 as baseline
    const rasterAt = (angDeg) => {
      const rad = angDeg * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      // Rotate points
      const rpts = cpts.map(([x, y]) => [
        (x * c - y * s) * scale + GRID / 2,
        (x * s + y * c) * scale + GRID / 2,
      ]);
      // Axis-aligned bbox for early-out
      let mn = Infinity, mx = -Infinity;
      for (const p of rpts) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; }
      const grid = new Uint8Array(GRID * GRID);
      // For each row, cast a horizontal ray and mark cells inside polygon
      const y0 = Math.max(0, Math.floor(mn));
      const y1 = Math.min(GRID - 1, Math.ceil(mx));
      for (let y = y0; y <= y1; y++) {
        const yc = y + 0.5;
        // Collect x-intercepts with polygon edges at this y
        const xs = [];
        for (let i = 0; i < rpts.length; i++) {
          const [ax, ay] = rpts[i];
          const [bx, by] = rpts[(i + 1) % rpts.length];
          if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
            const t = (yc - ay) / (by - ay);
            xs.push(ax + t * (bx - ax));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
          const xb = Math.min(GRID - 1, Math.floor(xs[k + 1] - 0.5));
          for (let x = xa; x <= xb; x++) grid[y * GRID + x] = 1;
        }
      }
      return grid;
    };
    // For a rotated shape, compute its LEFT-RIGHT mirror symmetry.
    // Score = |A ∩ mirror(A)| / |A ∪ mirror(A)|  (Jaccard on grids)
    const symmetryScoreAt = (angDeg) => {
      const g = rasterAt(angDeg);
      let both = 0, either = 0;
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID / 2; x++) {
          const a = g[y * GRID + x];
          const b = g[y * GRID + (GRID - 1 - x)];
          if (a || b) either++;
          if (a && b) both++;
        }
      }
      return either > 0 ? both / either : 0;
    };
    // Scan 0-180° for best vertical-mirror symmetry
    let bestSymScore = 0, bestSymAngle = 0;
    const scanSym = (startDeg, endDeg, step) => {
      for (let deg = startDeg; deg < endDeg; deg += step) {
        const sc = symmetryScoreAt(deg);
        if (sc > bestSymScore) { bestSymScore = sc; bestSymAngle = deg; }
      }
    };
    scanSym(0, 180, 3);
    // Refine around the coarse best
    const ref1 = bestSymAngle;
    bestSymScore = 0;
    scanSym(ref1 - 3, ref1 + 3, 0.5);
    const ref2 = bestSymAngle;
    bestSymScore = 0;
    scanSym(ref2 - 0.5, ref2 + 0.5, 0.1);

    // The symmetry search finds the angle that puts the symmetry axis VERTICAL.
    // For a bilateral part like a vamp, the symmetry axis IS the long axis
    // (the vamp is mirror-symmetric across its vertical centerline when upright).
    // But we want "0° = lying flat horizontal, 90° = standing upright", so we
    // need the LONG axis horizontal after alignment. Add 90° to rotate the
    // symmetry-aligned shape by an extra quarter turn, putting long axis horizontal.
    let symAlign = bestSymAngle + 90;
    while (symAlign >= 90)  symAlign -= 180;
    while (symAlign < -90)  symAlign += 180;

    // Normalize rectAngle and pcaAlign to same range
    while (rectAngle >= 90)  rectAngle -= 180;
    while (rectAngle < -90)  rectAngle += 180;
    while (pcaAlign >= 90)  pcaAlign -= 180;
    while (pcaAlign < -90)  pcaAlign += 180;

    // ── Combine ──
    // Strong bilateral symmetry (score ≥ 0.85) → use symmetry angle.
    //   This is the human-intuitive answer for shoe parts.
    // Moderate symmetry (0.7-0.85) → weight symmetry heavily but blend with PCA.
    // Weak symmetry (<0.7) → fall back to elongation-based choice.
    let chosen;
    if (bestSymScore >= 0.85) {
      chosen = symAlign;
    } else if (bestSymScore >= 0.7) {
      // Blend symmetry with PCA. Find the rotation of symAlign that's
      // closest to pcaAlign (they may differ by 180° or need smaller adjustment).
      let adjustedSym = symAlign;
      let d = adjustedSym - pcaAlign;
      while (d > 90)  { adjustedSym -= 180; d -= 180; }
      while (d < -90) { adjustedSym += 180; d += 180; }
      chosen = 0.7 * adjustedSym + 0.3 * pcaAlign;
    } else if (elong > 1.3) {
      chosen = pcaAlign;
    } else {
      chosen = rectAngle;
    }
    while (chosen >= 90)  chosen -= 180;
    while (chosen < -90)  chosen += 180;
    return chosen;
  },

  /* Expand a list of base rotations by a tolerance. For each base angle,
     add [base - tolerance, base, base + tolerance] to the list (clipped to
     sensible steps). Tolerance of 0 returns the input unchanged. */
  _expandRotationsWithTolerance(rotations, toleranceDeg) {
    if (!toleranceDeg || toleranceDeg <= 0) return rotations;
    const step = Math.min(toleranceDeg, 5); // sub-step inside tolerance, capped at 5°
    const out = new Set();
    for (const base of rotations) {
      out.add(base);
      // Add ±tolerance at sub-steps (e.g. ±5°, ±10°, ±tolerance)
      for (let d = step; d <= toleranceDeg + 0.001; d += step) {
        out.add((base + d) % 360);
        out.add((base - d + 360) % 360);
      }
      // Always include the exact tolerance boundary
      out.add((base + toleranceDeg) % 360);
      out.add((base - toleranceDeg + 360) % 360);
    }
    // Return sorted
    return Array.from(out).sort((a, b) => a - b);
  },

  /* Apply stored rules to a partDef before passing to engine. Returns a new
     partDef with per-part overrides on rotations/mirror/fixedAngle injected.
     If no rules or useGlobal, returns the input unchanged.
     When custom rules are active: auto-align the part to the sheet axes
     first (so user's "0°" = lying flat horizontal, "90°" = standing
     vertical), then layer the user's chosen rotations on top.
     Tolerance expands each chosen rotation by ±tol in small steps. */
  _applyComponentRules(partDef, globalRotations, globalMirrorMode) {
    if (!this._componentRules) return partDef;
    const key = this._componentKey(partDef);
    const rule = this._componentRules.get(key);
    // ALWAYS stamp _componentKey — even with useGlobal, the engine may need
    // it to enforce zones or set-grouping (those are applied regardless of
    // default/custom rotation mode).
    if (!rule) {
      return { ...partDef, _componentKey: key };
    }
    if (rule.useGlobal) {
      // Default rotation/mirror, but freeRot may still apply (it's an
      // always-visible field independent of default/custom mode).
      const out = { ...partDef, _componentKey: key };
      if (rule.freeRot) {
        const step = Math.max(5, Math.min(90, rule.freeRotStep || 30));
        const rots = [];
        for (let a = 0; a < 360; a += step) rots.push(a);
        out._rotations = rots;
      }
      return out;
    }

    // Compute & cache alignment angle (DXF natural → sheet-aligned horizontal)
    if (rule._alignAngle === undefined) {
      rule._alignAngle = this._computeAlignmentAngle(partDef.pts);
    }
    const align = rule._alignAngle;

    const out = { ...partDef };
    out._componentKey = key;
    if (Math.abs(align) > 0.01) {
      out.pts = rotatePts(partDef.pts, align);
      if (partDef.innerLines && partDef.innerLines.length) {
        out.innerLines = partDef.innerLines.map(il => ({
          ...il,
          pts: rotatePts(il.pts, align),
        }));
      }
    }

    let baseRots;
    if (rule.fixedAngle != null) {
      baseRots = [rule.fixedAngle];
    } else if (rule.freeRot) {
      // Free Rotation: try every angle from 0 to 360 at the chosen step.
      // Engine will rasterize each into NFP cache, so 30° step = 12 angles
      // per part. Smaller step = more chances to find tight nests at the
      // cost of compute. Cap step at sensible range (5–90).
      const step = Math.max(5, Math.min(90, rule.freeRotStep || 30));
      baseRots = [];
      for (let a = 0; a < 360; a += step) baseRots.push(a);
    } else {
      baseRots = rule.rotations && rule.rotations.length ? rule.rotations : globalRotations;
    }
    const tol = (rule.tolerance != null) ? rule.tolerance : 0;
    out._rotations = this._expandRotationsWithTolerance(baseRots, tol);
    out._mirrorMode = rule.mirror || globalMirrorMode;
    return out;
  },

  /* ══════════════════════════════════════════════════════════════════
     EXPAND MUST-MIRROR PARTS INTO ALTERNATING PAIRS
     ─────────────────────────────────────────────────────────────────
     For each part whose rule says mirror=must, split its qty in HALF
     and create TWO virtual parts: half copies use original polygon,
     other half use the X-flipped polygon. This produces alternating
     left+right output during nesting (like cutting shoe pairs from a
     hide).

     Why this approach: the engine places copies one at a time. If we
     gave it a single part with qty=10 and "must mirror", every copy
     would be either all original or all flipped (engine picks one).
     By splitting into 2 partDefs, half the placements use each chirality.

     Example: vamp qty=10, mirror=must
       Input:  [{vamp, qty=10, mirror=must}]
       Output: [{vamp_original, qty=5}, {vamp_mirrored, qty=5}]

     For odd qty (e.g. 7) we round up the original count: 4 originals + 3 mirrored.

     Modes other than 'must' or 'x-must' / 'y-must' / 'both-must' pass
     through unchanged.
     ═════════════════════════════════════════════════════════════════ */
  _expandForMustMirror(partsForNest, globalMirrorMode) {
    if (!partsForNest || partsForNest.length === 0) return partsForNest;
    const flipPolyH = (pts) => {
      const flipped = pts.map(p => [-p[0], p[1]]);
      let minX = Infinity, minY = Infinity;
      for (const [x, y] of flipped) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
      return flipped.map(p => [p[0] - minX, p[1] - minY]);
    };
    const flipPolyV = (pts) => {
      const flipped = pts.map(p => [p[0], -p[1]]);
      let minX = Infinity, minY = Infinity;
      for (const [x, y] of flipped) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
      return flipped.map(p => [p[0] - minX, p[1] - minY]);
    };
    const isMust = (m) => m === 'x-must' || m === 'y-must' || m === 'both-must' || m === 'must';
    const flipAxisFor = (m) => {
      if (m === 'x-must' || m === 'must' || m === 'both-must') return 'h';
      if (m === 'y-must') return 'v';
      return 'h';
    };

    const out = [];
    for (const p of partsForNest) {
      // Use per-component _mirrorMode if set (from rules), else fall back
      // to the global mirror dropdown. This ensures single-component case
      // (no rules popup) ALSO triggers expansion when user picks must
      // mirror globally.
      const m = p._mirrorMode || globalMirrorMode;
      console.log(`[ExpandMust] part=${p.name} qty=${p.qty} _mirrorMode=${p._mirrorMode} global=${globalMirrorMode} → effective=${m} isMust=${isMust(m)}`);
      if (!isMust(m) || !p.qty || p.qty < 1) {
        // No must-mirror or qty<1 → pass through, but clear must mirror so
        // the engine doesn't double-flip. Engine sees as 'none'.
        if (isMust(m)) {
          out.push({ ...p, _mirrorMode: 'none' });
        } else {
          out.push(p);
        }
        continue;
      }
      // Split qty: half originals, half mirrored.
      //
      // For qty=1 special case: emit BOTH original AND mirrored with qty=1
      // each. This ensures fillSheet mode (which inflates each partDef N×)
      // gets both chiralities to alternate. Without this, qty=1 with
      // mirror=must produces only original copies on the sheet.
      //
      // For qty>=2: split normally (ceil(N/2) originals + floor(N/2) mirrored).
      const totalQty = p.qty;
      let originalQty, mirroredQty;
      if (totalQty === 1) {
        // Both variants present so fillSheet alternates them on inflation
        originalQty = 1;
        mirroredQty = 1;
      } else {
        originalQty = Math.ceil(totalQty / 2);
        mirroredQty = totalQty - originalQty;
      }
      const axis = flipAxisFor(m);
      const flipFn = (axis === 'v') ? flipPolyV : flipPolyH;

      // Original copies — disable engine-level mirror since chirality is fixed.
      // Tag with shared _componentKey so engine treats orig + mir as ONE
      // component for sorting/grouping purposes (else they'd be split into
      // two component groups and originals would all place before mirrors).
      // _mustPairTag marks this as part of a chirality pair for the engine
      // to interleave them within the component group.
      out.push({
        ...p,
        qty: originalQty,
        _mirrorMode: 'none',
        _componentKey: p.id,            // shared key with mir variant below
        _mustPairTag: 'orig',
      });
      // Mirrored copies — different polygon, same _componentKey so engine
      // groups them with originals. _mustPairTag='mir' marks chirality.
      if (mirroredQty > 0) {
        const flippedPts = flipFn(p.pts);
        const flippedInner = (p.innerLines || []).map(il => ({
          ...il,
          pts: flipFn(il.pts),
        }));
        out.push({
          ...p,
          id: p.id + '_mir',
          name: p.name,
          pts: flippedPts,
          innerLines: flippedInner,
          qty: mirroredQty,
          _mirrorMode: 'none',
          _isMirroredVariant: true,
          _componentKey: p.id,          // SAME key as original
          _mustPairTag: 'mir',
        });
      }
    }
    return out;
  },

  async _runNestingProceed() {
    // Clear any existing replacement-toolbar selection
    if (typeof this.replaceCancelSelection === 'function') {
      this.replaceCancelSelection();
    }

    if (this._sheetSetByNormCalc && this.parts && this.parts.length > 0) {
      const reset = confirm(
        'The current sheet was set by Norm Calculator (Apply to Canvas).\n\n' +
        'It may be too small for new nesting. Reset sheet to default size (1200x600 mm)?\n\n' +
        'Click OK to reset, Cancel to keep current sheet size.'
      );
      if (reset) {
        const wEl = document.getElementById('s-width');
        const hEl = document.getElementById('s-height');
        if (wEl) wEl.value = '1200';
        if (hEl) hEl.value = '600';
        if (typeof Renderer !== 'undefined') {
          Renderer.sheetW = 1200;
          Renderer.sheetH = 600;
          Renderer.normCalcDecoration = null;
          if (Renderer.fitView) Renderer.fitView();
          if (Renderer.draw) Renderer.draw();
        }
      }
      this._sheetSetByNormCalc = false;
    }
    if (typeof Renderer !== 'undefined' && Renderer.normCalcDecoration) {
      Renderer.normCalcDecoration = null;
    }

    // ── Engine selection: apply toggle before we start ──
    const engineSel = document.getElementById('engine-mode');
    if (engineSel) {
      window.__useRasterEngine = engineSel.value === 'raster';
    }

    // ── FORCE POLYGON when zone rules are configured ──
    // The raster engine's zone classification uses label-position Voronoi
    // without boundary-curve awareness, producing wrong zone decisions near
    // zone boundaries. Only the polygon engine has the full zone mask +
    // 60% body-in-zone rule. When the user sets zone rules, override engine
    // choice to polygon.
    let hasZoneRulesForEngine = false;
    if (this._componentRules) {
      for (const r of this._componentRules.values()) {
        if (r && r.allowedZones && r.allowedZones.size > 0) {
          hasZoneRulesForEngine = true; break;
        }
      }
    }
    if (hasZoneRulesForEngine && window.__useRasterEngine) {
      window.__useRasterEngine = false;
      if (engineSel) engineSel.value = 'polygon';
      console.log('[NestForge] Forced POLYGON engine because zone rules are set');
    }

    // ── DIAGNOSTIC: log what rules are in effect ──
    // This helps verify zone rules are being applied correctly.
    // Shows in browser console (F12 → Console tab) AND in status bar.
    const rulesSummary = [];
    if (this._componentRules && this._componentRules.size > 0) {
      for (const [key, rule] of this._componentRules) {
        if (rule && rule.allowedZones && rule.allowedZones.size) {
          rulesSummary.push(`${key}→[${Array.from(rule.allowedZones).join(',')}]`);
        }
      }
    }
    const engineName = window.__useRasterEngine ? 'RASTER' : 'POLYGON';
    const diagMsg = 'Engine=' + engineName + (rulesSummary.length
      ? ' | Rules: ' + rulesSummary.join(' | ')
      : ' | No zone rules set');
    console.log('[NestForge DIAGNOSTIC]', diagMsg);
    // Also show briefly in status bar so user sees it without devtools
    const subEl = document.getElementById('prog-sub');
    if (subEl) subEl.textContent = diagMsg.length > 120 ? diagMsg.slice(0, 120) + '…' : diagMsg;

    const settings = this.getSettings();
    // GA mode injects a per-candidate diversity seed. When _gaPendingSeed is
    // set by runAdvancedNesting, propagate it so this nest run produces a
    // distinct layout. Otherwise (regular Run Nesting), seed=0 = deterministic.
    if (this._gaPendingSeed) {
      settings._diversitySeed = this._gaPendingSeed;
    }

    // ── Auto-enable FILL SHEET for leather hide nests ──
    // Hides should be saturated with as many copies as fit (you have ONE
    // hide, not unlimited sheets). Auto-fill the queue so the engine tries
    // to pack the entire usable area.
    //
    // CRITICAL: When we auto-enable fillSheet, we ALSO force multiSheet=OFF
    // for this run. Without that override, the engine sees an inflated
    // queue (100s of part copies) → places ~49 per sheet → has hundreds of
    // unplaced parts → multiSheet=true → spills to sheets 2/3/4/5/6/7.
    // User reported "7 sheets created when I selected just 1 copy" — that's
    // why. The multi-sheet checkbox is meant for RECTANGULAR sheets where
    // you really do have unlimited material; for hides, one hide = one
    // sheet, and overflow means parts that couldn't fit (correctly UNPLACED).
    const isLeatherSheet = !!(settings.sheetOutline && settings.sheetOutline.length >= 3);
    const userClickedFillBtn = !!this._fillSheetMode;
    if (isLeatherSheet && !userClickedFillBtn) {
      // Auto-fill on hide (regular Run Nesting): saturate the hide but
      // confine to ONE sheet — extras stay unplaced rather than spilling.
      settings.fillSheet = true;
      settings.multiSheet = false;
    } else if (userClickedFillBtn) {
      // User clicked Fill Entire Sheet button — they explicitly want fill.
      // Honor their multi-sheet checkbox setting (might want to spill to
      // more rectangular sheets).
      settings.fillSheet = true;
    }
    this._fillSheetMode = false; // consume the flag (reset for next click)

    // ── PRE-CHECK: width feasibility ─────────────────────────────────────
    // For each part, find the NARROWEST orientation achievable through the
    // user's allowed rotations. If even that narrowest dimension exceeds
    // the usable sheet width, no amount of height growth can make it fit
    // — the nesting engine would silently drop the part otherwise.
    // Tell the user explicitly so they can widen the sheet or enable more
    // rotations.
    const usableW = settings.sheetW - 2 * settings.margin;
    const rotsToTry = settings.rotations.length ? settings.rotations : [0];
    const tooWide = [];
    for (const p of this.parts) {
      let narrowest = Infinity;
      for (const rot of rotsToTry) {
        const rb = polyBBox(rotatePts(p.pts, rot));
        if (rb.w < narrowest) narrowest = rb.w;
      }
      if (narrowest > usableW + 0.5) {
        tooWide.push({ name: p.name, w: narrowest });
      }
    }
    // How the sheet may grow on this run: not at all for Fill, more-sheets
    // and hides (a hide is real material), else the chosen direction, or
    // 'none' when growing is switched off (the sheet is then exactly as set).
    const _hideNow = !!(this._sheetOutline && this._sheetOutline.length >= 3);
    const growDir = (settings.autoLength && !settings.fillSheet && !settings.multiSheet && !_hideNow)
      ? (settings.growDir || 'length') : 'none';
    const mayGrowW = growDir === 'width' || growDir === 'both';
    const mayGrowH = growDir === 'length' || growDir === 'both';
    if (tooWide.length && mayGrowW) {
      // The width may grow: make room for the widest part instead of stopping.
      const minNeeded = Math.ceil(Math.max(...tooWide.map(t => t.w)) + 2 * settings.margin);
      settings.sheetW = minNeeded;
      document.getElementById('s-width').value = minNeeded;
      Renderer.sheetW = minNeeded;
    } else if (tooWide.length) {
      const detail = tooWide.map(t => `  • ${t.name} → needs ${t.w.toFixed(0)}mm`).join('\n');
      const minNeeded = Math.ceil(Math.max(...tooWide.map(t => t.w)) + 2*settings.margin);
      alert(
        `${tooWide.length} part(s) are wider than the sheet:\n\n${detail}\n\n` +
        `Usable width is ${usableW.toFixed(0)}mm  (sheet ${settings.sheetW}mm − 2× margin ${settings.margin}mm).\n\n` +
        `Increase sheet width to at least ${minNeeded}mm, let the sheet grow in width,\n` +
        `OR enable more rotation options (currently: ${rotsToTry.join('°, ')}°).`
      );
      return;
    }
    if (!mayGrowH && !settings.fillSheet && !settings.multiSheet && !_hideNow) {
      // The height may not grow either: a part taller than the sheet in
      // every allowed rotation cannot be placed; say so rather than drop it.
      const usableH = settings.sheetH - 2 * settings.margin;
      const tooTall = [];
      for (const p of this.parts) {
        let shortest = Infinity;
        for (const rot of rotsToTry) {
          const rb = polyBBox(rotatePts(p.pts, rot));
          if (rb.h < shortest) shortest = rb.h;
        }
        if (shortest > usableH + 0.5) tooTall.push({ name: p.name, h: shortest });
      }
      if (tooTall.length) {
        const detail = tooTall.map(t => `  • ${t.name} → needs ${t.h.toFixed(0)}mm`).join('\n');
        const minNeeded = Math.ceil(Math.max(...tooTall.map(t => t.h)) + 2 * settings.margin);
        alert(
          `${tooTall.length} part(s) are taller than the sheet:\n\n${detail}\n\n` +
          `Usable height is ${usableH.toFixed(0)}mm.\n\n` +
          `Increase sheet height to at least ${minNeeded}mm, let the sheet grow in length,\n` +
          `OR enable more rotation options (currently: ${rotsToTry.join('°, ')}°).`
        );
        return;
      }
    }

    Renderer.sheetW = settings.sheetW;
    Renderer.sheetH = settings.sheetH;

    this._cancelled = false;
    document.getElementById('progress-overlay').classList.add('active');
    document.getElementById('prog-bar').style.width = '0%';
    document.getElementById('prog-sub').textContent = 'Initialising…';
    document.getElementById('btn-nest').disabled = true;
    { const ba = document.getElementById('btn-advanced'); if (ba) ba.disabled = true; }
    document.getElementById('nest-status').textContent = 'Nesting…';

    // State for live-preview reset between internal engine orderings. The
    // engine tries 3 orderings × 2 cavity modes = up to 6 internal passes
    // per outer strategy. Without this, placements from all 6 accumulate
    // visually creating a confusing "scatter" look. We watch the progress
    // message for "Ordering N [+cavity]:" prefix changes and flag a reset.
    let _lastOrderingKey = null;
    let _needLiveReset = false;
    const onProgress = (pct, msg) => {
      document.getElementById('prog-bar').style.width = Math.min(99, Math.round(pct*100))+'%';
      document.getElementById('prog-sub').textContent = msg;
      if (msg) {
        const m = msg.match(/^Ordering (\d+)( \+cavity)?:/);
        if (m) {
          const key = m[0];
          if (key !== _lastOrderingKey) {
            _lastOrderingKey = key;
            _needLiveReset = true;  // consumed by next onPlacement call
          }
        }
      }
    };

    try {
      // ── Flow mode + zone rules are incompatible ──
      // The flowNest engine (both raster and polygon variants) packs parts
      // in strict row-by-row sequence for cutting optimization and does NOT
      // check zone constraints during placement. If the user has configured
      // zone-restricted components (e.g. vamp→BUTT+SHOULDER only), force
      // flow mode OFF so the zone-aware nest() path is used instead.
      let hasZoneRules = false;
      if (this._componentRules) {
        for (const r of this._componentRules.values()) {
          if (r && r.allowedZones && r.allowedZones.size > 0) { hasZoneRules = true; break; }
        }
      }
      if (settings.cuttingFlow && hasZoneRules) {
        settings.cuttingFlow = false;
        const flowEl = document.getElementById('flow-enable');
        if (flowEl) flowEl.checked = false;
        document.getElementById('prog-sub').textContent =
          'Note: Flow mode disabled — zone rules require standard nesting';
      }
      // ── ENGINE SELECTION ──────────────────────────────────────────
      // Cutting Flow ON: the lane layout IS the result. This used to run
      // the free-form NFP engine as well and keep whichever placed more,
      // so on a PC where the lane engine placed a few parts fewer the user
      // got a scattered layout with Cutting Flow switched on. The lanes
      // were asked for; they are what comes back. The NFP engine is only a
      // fallback when the lane engine places nothing at all (or fails).
      // Cutting Flow OFF: just the polygon NFP engine.
      let nestFn;
      if (settings.cuttingFlow) {
        nestFn = async function(partDefs, s, onProgress, isCancelled, onPlacement) {
          let flowRes = null;
          try {
            flowRes = await NestEngine.flowNest.call(
              NestEngine, partDefs, s,
              (p, m) => onProgress(p, 'Cutting Flow: ' + m),
              isCancelled, onPlacement);
          } catch (e) { console.warn('[CuttingFlow] flow engine error:', e); }
          if (isCancelled && isCancelled()) return flowRes;
          if (flowRes && flowRes.placed > 0) return flowRes;
          console.warn('[CuttingFlow] lane engine placed nothing - falling back to polygon NFP');
          const el = document.getElementById('prog-sub');
          if (el) el.textContent = 'Cutting Flow placed nothing - using standard nesting';
          return await NestEngine.nest.call(NestEngine, partDefs, s,
            (p, m) => onProgress(p, 'NFP: ' + m), isCancelled, onPlacement);
        };
      } else {
        nestFn = NestEngine.nest;
      }

      // ── AUTO-EXPAND MODE ──────────────────────────────────────────
      // When user has Auto-expand checked + copies set + clicked Run
      // Nesting (not Fill Sheet) + not multi-sheet + not hide:
      //   1. Set sheet height to effectively INFINITE (50,000mm)
      //   2. Force fillSheet=true so engine packs aggressively across
      //      full width (using same logic as Fill Entire Sheet)
      //   3. Limit queue to exactly user's copies count (engine stops
      //      packing after N placements)
      //   4. After nesting, sheet shrinks to bbox.maxY of placements
      //
      // Result: engine fills full width tightly (like Fill Sheet does),
      // packs as many rows as needed until copies count reached,
      // then sheet auto-trims to fit exactly what was placed.
      // Growing in WIDTH works the same way mirrored: an effectively infinite
      // width and the polygon engine packing height-first (_growAxis 'x'),
      // then the width is trimmed. The lane engine fills a row before it
      // starts the next, so with an infinite width it would make one endless
      // row; with Cutting Flow on, width and both-ways growth use the
      // step-by-step growth below instead.
      const _isHide = !!(this._sheetOutline && this._sheetOutline.length >= 3);
      let _autoExpandMode = false;
      let _autoExpandAxis = 'y';
      let _autoExpandTargetCopies = 0;
      const _autoExpandOK = growDir === 'length' || (growDir === 'width' && !settings.cuttingFlow);
      if (growDir !== 'none' && _autoExpandOK && settings.copies > 1) {
        _autoExpandMode = true;
        _autoExpandAxis = growDir === 'width' ? 'x' : 'y';
        _autoExpandTargetCopies = settings.copies;
        if (_autoExpandAxis === 'y') {
          // Effectively infinite height — engine treats it as unbounded
          settings.sheetH = 50000;
          document.getElementById('s-height').value = 50000;
          Renderer.sheetH = 50000;
        } else {
          settings.sheetW = 50000;
          document.getElementById('s-width').value = 50000;
          Renderer.sheetW = 50000;
          settings._growAxis = 'x';
        }
        // Force fillSheet mode so engine uses tight-packing logic
        settings.fillSheet = true;
        // But cap queue: instead of inflating to fill 50000mm height,
        // give engine EXACTLY copies parts. Engine packs them tightly
        // and stops when queue exhausted.
        settings._autoExpandQueueCap = _autoExpandTargetCopies;
        console.log('[NestForge] Auto-expand: ' + (_autoExpandAxis === 'y' ? 'width=' + settings.sheetW + 'mm, infinite height' : 'height=' + settings.sheetH + 'mm, infinite width') + ', target=' + _autoExpandTargetCopies + ' copies');
      }

      const origH = settings.sheetH;
      const origW = settings.sheetW;
      // One step of growth for the loops below: the area still needed,
      // applied to the growing dimension(s). Returns false when the sheet
      // may not grow or hit the safety cap.
      const growSheet = (ratio) => {
        if (growDir === 'none') return false;
        const CAP = 100000;
        const bump = (cur, f) => { const n = Math.ceil(cur * f); return n <= cur ? Math.ceil(cur * 1.5) : n; };
        let W = settings.sheetW, H = settings.sheetH;
        if (growDir === 'length') H = bump(H, ratio);
        else if (growDir === 'width') W = bump(W, ratio);
        else { const f = Math.sqrt(ratio); W = bump(W, f); H = bump(H, f); }
        if (W > CAP || H > CAP) return false;
        settings.sheetW = W; settings.sheetH = H;
        document.getElementById('s-width').value = W;
        document.getElementById('s-height').value = H;
        Renderer.sheetW = W; Renderer.sheetH = H;
        return true;
      };
      const grownTo = () => growDir === 'width' ? `${settings.sheetW}mm wide`
        : growDir === 'both' ? `${settings.sheetW}×${settings.sheetH}mm` : `${settings.sheetH}mm`;

      // ── Pre-check: ensure sheet is at least as tall as the tallest part ──
      // No inflation based on area — that caused oversized canvases. We rely
      // on auto-grow to find the right height, then shrink-to-fit at the end.
      if (!settings.fillSheet && mayGrowH) {
        const tallestPart = this.parts.reduce((m, p) => {
          const bb = polyBBox(p.pts);
          return Math.max(m, Math.min(bb.w, bb.h)); // min(w,h) because rotation could lay it sideways
        }, 0);
        const minH = Math.ceil(tallestPart) + 2 * settings.margin;
        if (minH > settings.sheetH) {
          settings.sheetH = minH;
          document.getElementById('s-height').value = minH;
          Renderer.sheetH = minH;
        }
      }

      // ── Auto-grow height loop ────────────────────────────────────
      // Width is FIXED to the user's value; height grows until everything
      // fits (or we hit the safety cap).
      // For HIDE/LEATHER sheets, auto-grow is disabled — hides are real
      // physical material with fixed dimensions; you can't "grow" a hide
      // so any overflow goes to the next sheet (multi-sheet mode).
      const isHideSheet = !!(this._sheetOutline && this._sheetOutline.length >= 3);
      let result = null;
      let attempts = 0;
      const MAX_ATTEMPTS = isHideSheet ? 1 : 8;

      // ── Multi-strategy mode for leather + set nests ─────────────────
      // When nesting on a hide AND sets are configured, try multiple
      // placement strategies and pick the result with most complete sets
      // (tie-break by material utilization). This catches cases where one
      // strategy packs poorly and wastes space.
      const hasSetMode = isHideSheet && (() => {
        if (!this._componentRules) return false;
        for (const r of this._componentRules.values()) if (r && r.setCount > 0) return true;
        return false;
      })();

      // Strategy definitions.
      //  • Hide + sets: zone-saturation queue is the right base; the alternates
      //    actually CHANGE the queue construction (different setMode `_queueStrategy`),
      //    so multi-strategy genuinely explores different layouts here.
      //  • Hide WITHOUT sets: the engine's `singleSheetBestPass` already tries
      //    3 internal orderings (area-desc, height-desc, width-desc) per call,
      //    so wrapping in 3 outer strategies just duplicates work. Single outer
      //    pass is sufficient.
      //  • Rectangle improve mode: same as hide+sets — multi-strategy really
      //    only helps when the queue varies between calls, which only setMode
      //    does. For non-set rectangles the manual Improve button is mostly
      //    a no-op; we keep it enabled but inform the user it may not find more.
      let strategies;
      if (hasSetMode) {
        // Hide + sets: vary the queue construction. _queueStrategy changes
        // which parts get prioritized in the interleaved set queue.
        //
        // BUT: with only 1 or 2 distinct component types where one CLEARLY
        // dominates (e.g. vamp area > quarter area AND vamp height > quarter
        // height AND vamp has zone restriction), all 3 strategies produce
        // IDENTICAL orderings — vamp always sorts first regardless of which
        // comparator runs. Running them is wasted compute that user sees as
        // "engine repeats same approach 3-5 times before publishing."
        //
        // Detect: if all 3 sort comparators produce the same ordering for
        // the actual rules in this run, collapse to 1 strategy.
        const distinctComps = (this._componentRules ? [...this._componentRules.keys()].length : 0);
        let collapseStrategies = false;
        if (distinctComps <= 2) {
          // With ≤2 components, check if dominance is total. Get the parts
          // representing each component (use first part of each as proxy).
          const compParts = [];
          for (const [k, _r] of (this._componentRules || new Map())) {
            const p = this.parts.find(p => this._componentKey(p) === k);
            if (p) compParts.push({ key: k, part: p, rule: _r });
          }
          if (compParts.length === 2) {
            const [a, b] = compParts;
            const aA = polyArea(a.part.pts), bA = polyArea(b.part.pts);
            const aBB = polyBBox(a.part.pts), bBB = polyBBox(b.part.pts);
            const aHasZone = a.rule && a.rule.allowedZones && a.rule.allowedZones.size > 0;
            const bHasZone = b.rule && b.rule.allowedZones && b.rule.allowedZones.size > 0;
            // All comparators agree on order if larger-area component is also
            // taller AND has zone (or neither has zone):
            const sameByArea = aA > bA;
            const sameByHeight = aBB.h > bBB.h;
            const sameByZone = aHasZone === bHasZone || (aHasZone && !bHasZone) || (sameByArea && aHasZone === bHasZone);
            if (sameByArea === sameByHeight && (aHasZone === bHasZone || (sameByArea && aHasZone) || (!sameByArea && bHasZone))) {
              collapseStrategies = true;
              console.log(`[NestForge] Only ${distinctComps} components with consistent dominance — using 1 strategy (3 would be identical)`);
            }
          }
        }
        if (collapseStrategies) {
          strategies = [{ name: 'zone-saturation', order: 'restricted-area' }];
        } else {
          strategies = [
            { name: 'zone-saturation', order: 'restricted-area' },
            { name: 'area-desc',       order: 'area-desc' },
            { name: 'height-desc',     order: 'height-desc' },
          ];
        }
      } else if (this._improveMode) {
        // Manual improve on rectangle / non-set hide — try sortBy variants
        // unless setMode is active (which ignores sortBy → identical results).
        const setModeWillRun = this._componentRules &&
          [...this._componentRules.values()].some(r => r && r.setCount > 0);
        if (setModeWillRun) {
          strategies = [{ name: 'default', order: null }];
          console.log('[Improve] setMode active → 1 strategy (sortBy variants would be identical)');
        } else {
          strategies = [
            { name: 'sort-area',   order: null, sortBy: 'area' },
            { name: 'sort-height', order: null, sortBy: 'height' },
            { name: 'sort-width',  order: null, sortBy: 'width' },
          ];
        }
      } else {
        strategies = [{ name: 'default', order: null }];
      }

      const evalResult = (r) => {
        // Score: prefer MORE complete sets, then higher utilization.
        if (!r || !r.placements) return { sets: -1, util: 0 };
        const placedByKey = new Map();
        for (const pl of r.placements) {
          const k = this._componentKey(pl);
          placedByKey.set(k, (placedByKey.get(k) || 0) + 1);
        }
        let minSets = Infinity;
        for (const [key, rule] of (this._componentRules || new Map())) {
          if (!rule || !(rule.setCount > 0)) continue;
          const placed = placedByKey.get(key) || 0;
          const sets = Math.floor(placed / rule.setCount);
          if (sets < minSets) minSets = sets;
        }
        if (minSets === Infinity) minSets = 0;
        // Utilization (rough): placed area / material area
        const partsArea = r.placements.reduce((s, p) => s + polyArea(p.pts), 0);
        const mat = settings.sheetW * settings.sheetH * Math.max(1, r.sheetCount || 1);
        const util = mat > 0 ? partsArea / mat : 0;
        return { sets: minSets, util };
      };

      let bestResult = null;
      let bestScore = { sets: -1, util: 0 };
      let nestDefCount = this.parts.length;   // part definitions handed to the engine (after must-mirror expansion)

      // ── Progressive rendering setup ──────────────────────────────
      // Before nesting starts, set up a live-updating result object that
      // the Renderer points to. As each part is placed by the engine, it
      // gets pushed to liveResult.placements and the canvas repaints.
      // This makes the nest FEEL instant even if compute takes 5 seconds,
      // because the user sees parts appearing one by one.
      //
      // We throttle redraws via requestAnimationFrame — otherwise calling
      // draw() 50x/sec would actually slow down the nest. rAF batches
      // all incoming placements into at most ~60 redraws/sec.
      const liveResult = {
        placements: [],
        placed: 0,
        unplaced: 0,
        sheetCount: 1,
        usableW: settings.sheetW - 2 * settings.margin,
        usableH: settings.sheetH - 2 * settings.margin,
        effRes: 1,
      };
      this.nestResult = liveResult;
      Renderer.nestResult = liveResult;
      Renderer.currentSheet = 0;
      Renderer.sheetW = settings.sheetW;
      Renderer.sheetH = settings.sheetH;

      let _drawScheduled = false;
      const scheduleDraw = () => {
        if (_drawScheduled) return;
        _drawScheduled = true;
        requestAnimationFrame(() => {
          _drawScheduled = false;
          try { Renderer.draw(); } catch(_){}
        });
      };

      const onPlacement = (evt) => {
        if (!evt || !evt.placement) return;
        // If a new internal ordering just started, wipe previous attempt's
        // placements so the live preview shows only THIS ordering's build-up.
        // Without this, the 6 internal passes overlay and look scattered.
        if (_needLiveReset) {
          liveResult.placements.length = 0;
          liveResult.placed = 0;
          _needLiveReset = false;
        }
        // Push live placement. Engine still maintains its own internal
        // placements array; this is a parallel copy for rendering.
        liveResult.placements.push(evt.placement);
        liveResult.placed = liveResult.placements.length;
        liveResult.sheetCount = Math.max(liveResult.sheetCount, (evt.sheetIdx || 0) + 1);
        scheduleDraw();
      };

      // Snapshot the user's original sortBy so we can restore between strategies
      const userSortBy = settings.sortBy;
      for (let si = 0; si < strategies.length; si++) {
        const strategy = strategies[si];
        if (this._cancelled) break;
        settings._queueStrategy = strategy.order;
        // Apply per-strategy sortBy override (only used by improve mode currently)
        settings.sortBy = strategy.sortBy || userSortBy;
        if (strategies.length > 1) {
          onProgress(si / strategies.length, `Strategy ${si+1}/${strategies.length}: ${strategy.name}…`);
          await sleep(0);
        }
        // Reset live placements between strategies — each strategy is a
        // fresh layout attempt. Show the new strategy's progress from scratch.
        liveResult.placements = [];
        liveResult.placed = 0;
        scheduleDraw();
        // Reset auto-grow attempts per strategy
        let thisResult = null;
        let thisAttempts = 0;
        // Reset sheet size for each strategy (avoid contamination)
        settings.sheetH = origH; settings.sheetW = origW;
        document.getElementById('s-height').value = origH;
        document.getElementById('s-width').value = origW;
        Renderer.sheetH = origH; Renderer.sheetW = origW;

        let lastFail = null;   // the last sheet size the parts did not fit on
        const nestOnce = async () => {
          const partsForNestRaw = this.parts.map(p =>
            this._applyComponentRules(p, settings.rotations, settings.mirrorMode)
          );
          const partsForNest = this._expandForMustMirror(partsForNestRaw, settings.mirrorMode);
          nestDefCount = partsForNest.length;
          return await nestFn.call(NestEngine,
            partsForNest, settings, onProgress, () => this._cancelled, onPlacement
          );
        };
        while (thisAttempts < MAX_ATTEMPTS) {
          thisResult = await nestOnce();
          if (this._cancelled) break;
          if (thisResult.unplaced === 0 || settings.fillSheet || settings.multiSheet || isHideSheet) break;

          // Auto-grow: reset live placements before next attempt
          liveResult.placements = [];
          liveResult.placed = 0;
          scheduleDraw();

          const placedArea = thisResult.placements.reduce((s, p) => s + polyArea(p.pts), 0);
          const totalArea  = this.parts.reduce((s, p) => s + polyArea(p.pts), 0) * settings.copies;
          let ratio = placedArea > 0 ? (totalArea / placedArea) * 1.15 : 2.5;
          lastFail = { W: settings.sheetW, H: settings.sheetH };
          if (!growSheet(ratio)) break;
          document.getElementById('prog-sub').textContent =
            `Auto-fit: growing to ${grownTo()}…`;
          await sleep(0);
          thisAttempts++;
        }
        // ── Tighten a grown sheet ─────────────────────────────────────
        // The growth step jumps by the area still needed plus 15%, so the
        // first size that fits is usually bigger than necessary, and a lane
        // layout spans whatever width it is given, so it cannot be trimmed
        // afterwards. Search between the last size that failed and the one
        // that fit, keeping the smallest sheet on which everything fits.
        if (!this._cancelled && lastFail && thisResult && thisResult.unplaced === 0 && growDir !== 'none') {
          const setSize = (W, H) => {
            settings.sheetW = W; settings.sheetH = H;
            document.getElementById('s-width').value = W;
            document.getElementById('s-height').value = H;
            Renderer.sheetW = W; Renderer.sheetH = H;
          };
          let lo = lastFail, hi = { W: settings.sheetW, H: settings.sheetH };
          let best = thisResult;
          for (let k = 0; k < 4; k++) {
            const span = growDir === 'width' ? (hi.W - lo.W) / hi.W : growDir === 'length' ? (hi.H - lo.H) / hi.H
              : Math.max((hi.W - lo.W) / hi.W, (hi.H - lo.H) / hi.H);
            if (span < 0.04) break;
            const mid = {
              W: mayGrowW ? Math.ceil((lo.W + hi.W) / 2) : hi.W,
              H: mayGrowH ? Math.ceil((lo.H + hi.H) / 2) : hi.H,
            };
            setSize(mid.W, mid.H);
            liveResult.placements = []; liveResult.placed = 0; scheduleDraw();
            document.getElementById('prog-sub').textContent = `Auto-fit: trying a smaller sheet, ${grownTo()}…`;
            const r = await nestOnce();
            if (this._cancelled) break;
            if (r.unplaced === 0) { hi = mid; best = r; } else lo = mid;
          }
          if (!this._cancelled) { setSize(hi.W, hi.H); thisResult = best; }
        }

        // Score and compare
        const score = evalResult(thisResult);
        const better = (score.sets > bestScore.sets) ||
                       (score.sets === bestScore.sets && score.util > bestScore.util + 0.01);
        if (bestResult === null || better) {
          bestResult = thisResult;
          bestScore = score;
        }

        // Early exit: if first strategy made real progress, skip the rest.
        // "Real progress" = placed at least some complete sets OR >40% util.
        // This dramatically speeds up typical cases where the first strategy
        // is already good. User gets answer in 1× time instead of 3× time.
        // EXCEPTION: improve mode skips the early-exit and forces ALL strategies
        // to be tried, since the user explicitly asked for the best possible
        // result (or it's an auto-improve hide nest where we always explore).
        if (!this._improveMode && si === 0 && strategies.length > 1 && thisResult && thisResult.placements) {
          if (bestScore.sets >= 1 || bestScore.util > 0.40) {
            break;  // first strategy is already usable — no need to try more
          }
        }
      }
      settings._queueStrategy = null; // clean up
      settings.sortBy = userSortBy;   // restore user's choice

      result = bestResult;
      attempts = MAX_ATTEMPTS; // skip the now-redundant outer auto-grow loop
      if (strategies.length > 1 && result) {
        document.getElementById('prog-sub').textContent =
          `Best of ${strategies.length} strategies: ${bestScore.sets} sets, ${(bestScore.util*100).toFixed(1)}% util`;
      }

      // ── Sync liveResult to the WINNING strategy's layout ─────────
      // The live canvas currently shows whichever strategy ran LAST. If
      // that's not the best one, replace the live placements with the
      // winner's placements so the user sees the correct final layout.
      if (result && result.placements && result !== liveResult) {
        liveResult.placements = result.placements.slice();
        liveResult.placed = result.placements.length;
        liveResult.unplaced = result.unplaced || 0;
        liveResult.sheetCount = result.sheetCount || 1;
        liveResult.usableW = result.usableW || liveResult.usableW;
        liveResult.usableH = result.usableH || liveResult.usableH;
        liveResult.effRes = result.effRes || 1;
        scheduleDraw();
      }

      // The auto-grow loop below is now a no-op when attempts===MAX_ATTEMPTS.
      // Kept intact to preserve behavior for non-set / non-leather nests.
      while (attempts < MAX_ATTEMPTS) {
        // Inject per-component rule overrides onto parts (if user set any).
        // Engines consult part._rotations / part._mirrorMode first, fall back
        // to global settings.rotations / settings.mirrorMode when absent.
        const partsForNestRaw = this.parts.map(p =>
          this._applyComponentRules(p, settings.rotations, settings.mirrorMode)
        );
        // Expand must-mirror parts into alternating original+flipped pairs
        const partsForNest = this._expandForMustMirror(partsForNestRaw, settings.mirrorMode);
        nestDefCount = partsForNest.length;
        // Reset live placements for each auto-grow attempt
        liveResult.placements = [];
        liveResult.placed = 0;
        scheduleDraw();
        result = await nestFn.call(NestEngine,
          partsForNest, settings, onProgress, () => this._cancelled, onPlacement
        );
        if (this._cancelled) break;

        // All fit OR fillSheet mode OR multi-sheet mode OR hide sheet → done
        if (result.unplaced === 0 || settings.fillSheet || settings.multiSheet || isHideSheet) break;

        // Compute new height: scale up by remaining-vs-placed ratio + 15% safety
        const placedArea = result.placements.reduce((s, p) => s + polyArea(p.pts), 0);
        const totalArea  = this.parts.reduce((s, p) => s + polyArea(p.pts), 0) * settings.copies;
        let ratio;
        if (placedArea > 0) {
          ratio = (totalArea / placedArea) * 1.15;
        } else {
          ratio = 2.5; // nothing fit → grow aggressively
        }
        if (!growSheet(ratio)) break;   // the sheet may not grow (or hit the cap): report what did not fit
        document.getElementById('prog-sub').textContent =
          `Auto-fit: growing to ${grownTo()}  (${result.unplaced} part(s) didn't fit, retrying…)`;
        await sleep(0);
        attempts++;
      }

      // ── Shrink-to-fit after success ──────────────────────────────────
      // If everything placed and there's empty space below the last part,
      // shrink the sheet down so there's no wasted canvas at the bottom.
      // Skip for fillSheet (user chose to use the whole sheet), for multi-sheet
      // (user has fixed dimensions and doesn't want auto-resize), and for
      // failed runs (we need the extra room to show the auto-size popup).
      // AUTO-EXPAND mode: after nesting completes (whether all placed or
      // not), shrink the 50000mm-tall sheet down to fit the actual
      // placements. Width stays at user's value.
      if (_autoExpandMode && result && result.placements && result.placements.length > 0) {
        let maxBottomY = 0, maxRightX = 0;
        for (const pl of result.placements) {
          const bb = polyBBox(pl.pts);
          const bottom = pl.y + bb.h, right = pl.x + bb.w;
          if (bottom > maxBottomY) maxBottomY = bottom;
          if (right > maxRightX) maxRightX = right;
        }
        if (_autoExpandAxis === 'y') {
          const tightH = Math.ceil(maxBottomY + settings.margin);
          if (tightH >= 2 * settings.margin + 10) {
            settings.sheetH = tightH;
            document.getElementById('s-height').value = tightH;
            Renderer.sheetH = tightH;
          }
        } else {
          const tightW = Math.ceil(maxRightX + settings.margin);
          if (tightW >= 2 * settings.margin + 10) {
            settings.sheetW = tightW;
            document.getElementById('s-width').value = tightW;
            Renderer.sheetW = tightW;
          }
          delete settings._growAxis;
        }
        // Restore fillSheet=false for status display consistency
        settings.fillSheet = false;
        // Cap result.placements to the requested copies OF EACH PART. This
        // used to cap at `copies` in total, which cut a 3-copies nest of 8
        // parts down to 3 parts.
        const autoExpandMax = _autoExpandTargetCopies * Math.max(1, nestDefCount);
        if (result.placements.length > autoExpandMax) {
          result.placements = result.placements.slice(0, autoExpandMax);
          result.placed = result.placements.length;
          result.unplaced = 0;
        }
      }
      // A sheet that may grow may also shrink, in the same direction(s); a
      // fixed sheet (growing off) stays exactly as set.
      if (!this._cancelled && result && result.unplaced === 0 && !settings.fillSheet
          && !settings.multiSheet && !isHideSheet && growDir !== 'none'
          && result.placements.length > 0 && !_autoExpandMode) {
        let maxBottomY = 0, maxRightX = 0;
        for (const pl of result.placements) {
          const bb = polyBBox(pl.pts);
          const bottom = pl.y + bb.h, right = pl.x + bb.w;
          if (bottom > maxBottomY) maxBottomY = bottom;
          if (right > maxRightX) maxRightX = right;
        }
        if (mayGrowH) {
          const tightH = Math.ceil(maxBottomY + settings.margin);
          // Only shrink if the savings are meaningful (> 5mm or > 2% of current H)
          const minSaving = Math.max(5, settings.sheetH * 0.02);
          if (tightH < settings.sheetH - minSaving && tightH >= 2 * settings.margin + 10) {
            settings.sheetH = tightH;
            document.getElementById('s-height').value = tightH;
            Renderer.sheetH = tightH;
          }
        }
        if (mayGrowW) {
          const tightW = Math.ceil(maxRightX + settings.margin);
          const minSavingW = Math.max(5, settings.sheetW * 0.02);
          if (tightW < settings.sheetW - minSavingW && tightW >= 2 * settings.margin + 10) {
            settings.sheetW = tightW;
            document.getElementById('s-width').value = tightW;
            Renderer.sheetW = tightW;
          }
        }
      }

      if (!this._cancelled && result) {
        this.nestResult = result;
        Renderer.nestResult = result;
        Renderer.currentSheet = 0;
        Renderer.sheetW = settings.sheetW;
        Renderer.sheetH = settings.sheetH;
        this.updateStats(result, settings);
        this.renderSheetTabs(result.sheets);
        document.getElementById('btn-export').disabled = false;
        const mbx = document.getElementById('m-btn-export'); if (mbx) mbx.disabled = false;
        // Enable manual "Improve" button — works for both hide and rectangle
        // now that it's incremental edge-fill (adds parts to current layout
        // without re-nesting). Only requires polygon engine.
        const imp = document.getElementById('btn-improve');
        if (imp) imp.disabled = (result.placed === 0) || window.__useRasterEngine;
        const flowTag = result.cuttingFlow ? ' ✂ FLOW' + (result.flowLabel ? ' (' + result.flowLabel + ')' : '') : '';
        const engineTag = window.__useRasterEngine ? ' [raster]' : ' [polygon-NFP]';
        const grewTag = ((settings.sheetH !== origH) ? `  •  Auto-fit H: ${origH}→${settings.sheetH}mm` : '')
                      + ((settings.sheetW !== origW) ? `  •  Auto-fit W: ${origW}→${settings.sheetW}mm` : '');
        const sheetTag = (result.sheetCount > 1)
          ? `  •  📑 ${result.sheetCount} sheets`
          : '';
        let setsTag = '';
        let unplacedTag = result.unplaced > 0
          ? (growDir === 'none'
              ? `  •  ⚠ ${result.unplaced} part(s) did not fit — the sheet is fixed (turn on Grow the sheet, or More sheets if parts overflow)`
              : `  •  ⚠ ${result.unplaced} part(s) did not fit`)
          : '';
        if (result.sets) {
          const S = result.sets;
          setsTag = S.complete >= S.requested
            ? `  •  🎯 ${S.complete} of ${S.requested} sets complete`
            : `  •  ⚠ only ${S.complete} of ${S.requested} sets fit`;
          unplacedTag = result.unplaced > 0
            ? `  •  ${result.unplaced} part(s) of the requested sets did not fit (larger sheet or more sheets)`
            : '';
        }
        document.getElementById('nest-status').textContent =
          `✓ ${result.placed} placed${setsTag}${sheetTag}${grewTag}${unplacedTag}${flowTag}${engineTag}`;
        Renderer.fitView();
        this._saveCurrentWS();
      }
    } catch(e) {
      console.error(e);
      document.getElementById('nest-status').textContent = 'Error: ' + e.message;
    }

    document.getElementById('progress-overlay').classList.remove('active');
    document.getElementById('btn-nest').disabled = false;
    { const ba = document.getElementById('btn-advanced'); if (ba) ba.disabled = !this.parts.length; }
  },

  cancelNesting() {
    this._cancelled = true;
    document.getElementById('nest-status').textContent = 'Cancelled';
  },

  updateStats(result, settings) {
    const totalRequested = settings.fillSheet ? result.placed : settings.copies * this.parts.length;

    // ── MATERIAL utilization (industry standard) ─────────────────────
    // For RECTANGULAR sheets: full sheets fully count. The LAST used
    // sheet counts up to the bottom edge of the last part (rest is
    // reusable remnant).
    // For LEATHER HIDE sheets: each used sheet counts the FULL hide area
    // (not bbox area), since the hide was already cut from the animal
    // and discarding unused leather is wastage.
    const partsArea = result.placements.reduce((s, p) => s + polyArea(p.pts), 0);
    const hasHideOutline = !!(this._sheetOutline && this._sheetOutline.length >= 3);
    const hideArea = hasHideOutline ? polyArea(this._sheetOutline) : 0;

    let materialArea = 0;
    const sheets = result.sheets || [];
    for (let i = 0; i < sheets.length; i++) {
      const sh = sheets[i];
      if (hasHideOutline) {
        // Each used hide = full hide area. No trimming (you can't "trim"
        // an unused portion of an organic hide — it's already cut).
        if (sh.placements.length > 0) materialArea += hideArea;
      } else {
        // Rectangular: trim last sheet to max-Y of placements
        let maxY = 0;
        for (const p of sh.placements) {
          const bb = polyBBox(p.pts);
          const bottom = p.y + bb.h;
          if (bottom > maxY) maxY = bottom;
        }
        maxY = Math.min(settings.sheetH, Math.ceil(maxY) + settings.margin);
        const isLast = (i === sheets.length - 1);
        const height = isLast ? maxY : settings.sheetH;
        materialArea += settings.sheetW * height;
      }
    }

    // Fallback if no sheets (shouldn't happen but safety):
    if (materialArea === 0) {
      materialArea = hasHideOutline
        ? hideArea * Math.max(1, result.sheetCount)
        : settings.sheetW * settings.sheetH * result.sheetCount;
    }

    const util = materialArea > 0 ? (partsArea / materialArea * 100) : 0;
    const allocArea = hasHideOutline
      ? hideArea * result.sheetCount
      : settings.sheetW * settings.sheetH * result.sheetCount;

    document.getElementById('st-parts').textContent = totalRequested;
    document.getElementById('st-sheets').textContent = result.sheetCount;
    document.getElementById('st-placed').textContent = result.placed;
    document.getElementById('st-unplaced').textContent = result.unplaced;
    document.getElementById('st-util').textContent = util.toFixed(1) + '%';
    document.getElementById('util-fill').style.width = util + '%';

    // Stats detail: show parts area, material area (trimmed), and — if the
    // last sheet has leftover — call out that it's saved as remnant.
    const lastUnused = allocArea - materialArea;
    const remnantTag = lastUnused > settings.sheetW * 20
      ? `\nRemnant (last sheet, reusable): ${(lastUnused/100).toFixed(0)}cm²`
      : '';
    // ── SET stats (if any component has setCount > 0) ─────────────────
    let setsTag = '';
    const setsBox = document.getElementById('st-sets-box');
    if (result.sets) {
      // Copies-as-sets: one of every part per set. Count per part name so
      // the user can see exactly which part is short.
      const S = result.sets;
      const perName = new Map((S.perPart || []).map(r => [r.name, r.placed]));
      const short = [], extras = [];
      for (const [name, n] of perName) {
        if (n < S.requested) short.push(`${S.requested - n}× ${name}`);
        else if (n > S.requested) extras.push(`${n - S.requested}× ${name}`);
      }
      setsTag = `\n🎯 Complete sets: ${S.complete} of ${S.requested}` +
                (short.length ? ` • Missing: ${short.join(', ')}` : '') +
                (extras.length ? ` • Extras: ${extras.join(', ')}` : '');
      if (setsBox) {
        setsBox.style.display = '';
        document.getElementById('st-sets-count').textContent = `${S.complete} / ${S.requested}`;
        const breakdown = [...perName].map(([name, n]) => `${name}: ${n} of ${S.requested}` +
          (n < S.requested ? '  ✗' : n > S.requested ? `  (+${n - S.requested} extra)` : '  ✓')).join('\n');
        let detail = `1 set = one of each of the ${S.partsPerSet} loaded parts\n${breakdown}`;
        if (short.length) detail += `\n\n${S.requested - S.complete} set(s) did not fit. Missing: ${short.join(', ')}.\nUse a larger sheet, more sheets, or fewer copies.`;
        else if (extras.length) detail += `\n\nAll ${S.requested} sets placed; the leftover space holds extras: ${extras.join(', ')}.`;
        else detail += `\n\nAll ${S.requested} sets placed, no extras.`;
        document.getElementById('st-sets-detail').textContent = detail;
      }
    } else if (this._componentRules) {
      const setCounts = new Map();
      for (const [key, rule] of this._componentRules) {
        if (rule && rule.setCount > 0) setCounts.set(key, rule.setCount);
      }
      if (setCounts.size > 0) {
        // Count placed per component key
        const placedByKey = new Map();
        for (const pl of result.placements) {
          const k = this._componentKey(pl);
          placedByKey.set(k, (placedByKey.get(k) || 0) + 1);
        }
        // Complete sets = min over all set-components of floor(placed / perSet)
        let completeSets = Infinity;
        const perKeyDetail = [];
        for (const [key, perSet] of setCounts) {
          const placed = placedByKey.get(key) || 0;
          const sets = Math.floor(placed / perSet);
          if (sets < completeSets) completeSets = sets;
          perKeyDetail.push({ key, placed, perSet, sets });
        }
        if (completeSets === Infinity) completeSets = 0;
        // Extras beyond the complete sets, per component
        const extras = [];
        for (const d of perKeyDetail) {
          const usedInSets = completeSets * d.perSet;
          const extra = d.placed - usedInSets;
          if (extra > 0) extras.push(`${extra}× ${d.key}`);
        }
        // Also non-set components (not in setCounts) count as pure extras
        for (const [k, placed] of placedByKey) {
          if (!setCounts.has(k) && placed > 0) extras.push(`${placed}× ${k}`);
        }
        setsTag = `\n🎯 Complete sets: ${completeSets}` +
                  (extras.length ? ` • Extras: ${extras.join(', ')}` : '');

        // ── Populate prominent Sets box ─────────────────────────────
        if (setsBox) {
          setsBox.style.display = '';
          document.getElementById('st-sets-count').textContent = completeSets;
          // Build a clear breakdown: recipe + placed counts + extras
          const recipe = perKeyDetail.map(d => `${d.perSet}× ${d.key}`).join(' + ');
          const breakdown = perKeyDetail.map(d =>
            `${d.key}: ${d.placed} placed (${d.sets} sets' worth)`
          ).join('\n');
          let detail = `Set recipe: 1 set = ${recipe}\n${breakdown}`;
          if (extras.length) {
            detail += `\n\nExtras beyond ${completeSets} complete sets:\n  ${extras.join(', ')}`;
          } else if (completeSets > 0) {
            detail += `\n\nNo leftover extras — all placed parts form complete sets.`;
          }
          document.getElementById('st-sets-detail').textContent = detail;
        }
      } else if (setsBox) {
        setsBox.style.display = 'none';
      }
    } else if (setsBox) {
      setsBox.style.display = 'none';
    }
    document.getElementById('st-detail').textContent =
      `Parts area: ${(partsArea/100).toFixed(0)}cm²  |  Material used: ${(materialArea/100).toFixed(0)}cm²\nWaste: ${((materialArea-partsArea)/100).toFixed(0)}cm²${remnantTag}${setsTag}`;

    // Refresh costing display with the latest result
    this._updateCosting();
  },

  /* ══════════════════════════════════════════════════════════════════
     COSTING (per-sheet) — delegators
     Implementation lives in the Costing module. These wrappers keep the
     existing HTML buttons and internal `this._setCostMode()`-style calls
     working without rewiring every caller.
     ═════════════════════════════════════════════════════════════════ */
  get _costMode() { return Costing._costMode; }, set _costMode(v) { Costing._costMode = v; },
  get _reportFmt() { return Costing._reportFmt; }, set _reportFmt(v) { Costing._reportFmt = v; },
  get _productImage() { return Costing._productImage; }, set _productImage(v) { Costing._productImage = v; },
  setupCosting()                  { return Costing.setupCosting(); },
  _setCostMode(m)                 { return Costing._setCostMode(m); },
  _setReportFmt(f)                { return Costing._setReportFmt(f); },
  _addSpec(k,v)                   { return Costing._addSpec(k,v); },
  _collectSpecs()                 { return Costing._collectSpecs(); },
  _clearSpecs()                   { return Costing._clearSpecs(); },
  _onProductImageChange(e)        { return Costing._onProductImageChange(e); },
  _removeProductImage()           { return Costing._removeProductImage(); },
  _renderProductImagePreview()    { return Costing._renderProductImagePreview(); },
  _mmSqToUnit(mm2, u)             { return Costing._mmSqToUnit(mm2, u); },
  _unitLabel(u)                   { return Costing._unitLabel(u); },
  _computeCosting()               { return Costing._computeCosting.call(this); },
  _updateCosting()                { return Costing._updateCosting.call(this); },
  _renderWorksheetLayoutToDataURL(ws,w,h) { return Costing._renderWorksheetLayoutToDataURL(ws,w,h); },
  _renderLayoutToDataURL(w,h)     { return Costing._renderLayoutToDataURL.call(this,w,h); },
  exportCostingReport()           { return Costing.exportCostingReport.call(this); },
  _reportMeta(c)                  { return Costing._reportMeta.call(this, c); },
  _exportReportExcel(c)           { return Costing._exportReportExcel.call(this, c); },
  _exportReportPDF(c)             { return Costing._exportReportPDF.call(this, c); },


  /* ══════════════════════════════════════════════════════════════════
     CONSOLIDATED MULTI-WORKSHEET COSTING REPORT — delegators
     Implementation in the ConsolidatedReport module (above the App).
     These preserve HTML onclick="App.xxx()" wiring unchanged.
     ═════════════════════════════════════════════════════════════════ */
  exportConsolidatedReport()      { return ConsolidatedReport.exportConsolidatedReport(); },
  _openConsolidatedDialog()       { return ConsolidatedReport._openConsolidatedDialog(); },
  _closeConsolidatedDialog()      { return ConsolidatedReport._closeConsolidatedDialog(); },
  _saveConsolidatedInputs()       { return ConsolidatedReport._saveConsolidatedInputs(); },
  _addConsolidatedSpec()          { return ConsolidatedReport._addConsolidatedSpec(); },
  _renderConsolidatedSpecRow(k,v) { return ConsolidatedReport._renderConsolidatedSpecRow(k,v); },
  _escAttr(s)                     { return ConsolidatedReport._escAttr(s); },
  _onConsolidatedImageChange(e)   { return ConsolidatedReport._onConsolidatedImageChange(e); },
  _removeConsolidatedImage()      { return ConsolidatedReport._removeConsolidatedImage(); },
  _renderConsolidatedImagePreview() { return ConsolidatedReport._renderConsolidatedImagePreview(); },
  _setConsolidatedFmt(f)          { return ConsolidatedReport._setConsolidatedFmt(f); },
  _collectAllWorksheetsCosting()  { return ConsolidatedReport._collectAllWorksheetsCosting(); },
  _renderConsolidatedWSPreview()  { return ConsolidatedReport._renderConsolidatedWSPreview(); },
  _downloadConsolidatedReport()   { return ConsolidatedReport._downloadConsolidatedReport(); },


  renderSheetTabs(sheets) {
    const wrap = document.getElementById('sheet-tabs');
    wrap.innerHTML = '';
    for (const sh of sheets) {
      const btn = document.createElement('div');
      btn.className = 'sheet-tab' + (sh.idx === Renderer.currentSheet ? ' active' : '');
      btn.textContent = `Sheet ${sh.idx + 1} (${sh.placements.length})`;
      btn.addEventListener('click', () => {
        Renderer.currentSheet = sh.idx;
        wrap.querySelectorAll('.sheet-tab').forEach((b,i) => b.classList.toggle('active', i === sh.idx));
        Renderer.draw();
      });
      wrap.appendChild(btn);
    }
  },

  updateUI() {
    const hasParts = this.parts.length > 0;
    document.getElementById('btn-nest').disabled = !hasParts;
    const btnAdv = document.getElementById('btn-advanced');
    if (btnAdv) btnAdv.disabled = !hasParts;
    // Mirror to mobile bottom nav
    const mnRun = document.getElementById('mn-run');
    if (mnRun) mnRun.disabled = !hasParts;
    if (!hasParts) {
      document.getElementById('btn-export').disabled = true;
      const mbx = document.getElementById('m-btn-export');
      if (mbx) mbx.disabled = true;
      const imp = document.getElementById('btn-improve');
      if (imp) imp.disabled = true;
      document.getElementById('st-parts').textContent = '—';
      document.getElementById('st-sheets').textContent = '—';
      document.getElementById('st-placed').textContent = '—';
      document.getElementById('st-unplaced').textContent = '—';
      document.getElementById('st-util').textContent = '—';
      document.getElementById('util-fill').style.width = '0%';
      document.getElementById('st-detail').textContent = '';
      const setsBox = document.getElementById('st-sets-box');
      if (setsBox) setsBox.style.display = 'none';
      this.renderSheetTabs([]);
      this._updateCosting(); // reset costing panel
    }
  },

  /* ── FILL ENTIRE SHEET ────────────────────────────────────────── */
  fillSheet() {
    this._fillSheetMode = true;
    this.runNesting();
  },
  /* ══════════════════════════════════════════════════════════════════
     AUTO-SIZE + FILL SHEET — delegators
     Implementation lives in the AutoSize module (before App).
     ═════════════════════════════════════════════════════════════════ */
  get _autoSizeData() { return AutoSize._autoSizeData; }, set _autoSizeData(v) { AutoSize._autoSizeData = v; },
  get _isAutoSizeRun() { return AutoSize._isAutoSizeRun; }, set _isAutoSizeRun(v) { AutoSize._isAutoSizeRun = v; },
  get _fillSheetMode() { return AutoSize._fillSheetMode; }, set _fillSheetMode(v) { AutoSize._fillSheetMode = v; },
  _showAutoSizeModal(p,t,s)       { return AutoSize._showAutoSizeModal.call(this, p, t, s); },
  _updateAutoSizeLabels()         { return AutoSize._updateAutoSizeLabels(); },
  _updateAutoSizeEstimate()       { return AutoSize._updateAutoSizeEstimate.call(this); },
  cancelAutoSize()                { return AutoSize.cancelAutoSize.call(this); },
  confirmAutoSize()               { return AutoSize.confirmAutoSize.call(this); },

  toggleFlowMode() {
    const cb = document.getElementById('flow-enable');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  },

  /* Measure tool on the canvas (src/render/measure.js). Measurements made
     while it is on stay drawn after it is switched off, until cleared. */
  toggleMeasure(force) {
    const on = (typeof force === 'boolean') ? force : !Measure.active;
    Measure.active = on;
    Measure.pending = null;
    Measure.hover = null;
    document.getElementById('btn-measure').classList.toggle('active', on);
    document.getElementById('btn-measure-clear').style.display = (on || Measure.items.length) ? '' : 'none';
    document.getElementById('main-canvas').classList.toggle('measuring', on);
    if (on) {
      // Measuring and part selection do not mix: drop any selection
      if (typeof this.replaceCancelSelection === 'function') this.replaceCancelSelection();
      document.getElementById('nest-status').textContent =
        '📏 Measure: click two points (snaps to corners and edges), or click inside two parts for the gap between them. Esc cancels / clears.';
    } else if (!Measure.items.length) {
      document.getElementById('nest-status').textContent = this.nestResult ? 'Ready' : document.getElementById('nest-status').textContent;
    }
    Renderer.draw();
  },

  _updateFlowPills() {
    const dir = document.getElementById('flow-dir').value;
    const [a, b] = dir === 'vertical' ? ['90°','270°'] : dir === 'auto' ? ['?','?'] : ['0°','180°'];
    document.getElementById('flow-pill-a').textContent = a;
    document.getElementById('flow-pill-b').textContent = b;
    document.getElementById('flow-pill-a2').textContent = a;
  },
  /* ══════════════════════════════════════════════════════════════════
     WORKSHEET MANAGER — delegators
     Implementation lives in the WorksheetManager module (before App).
     ═════════════════════════════════════════════════════════════════ */
  get _worksheets() { return WorksheetManager._worksheets; }, set _worksheets(v) { WorksheetManager._worksheets = v; },
  get _activeWS() { return WorksheetManager._activeWS; }, set _activeWS(v) { WorksheetManager._activeWS = v; },
  get _wsCounter() { return WorksheetManager._wsCounter; }, set _wsCounter(v) { WorksheetManager._wsCounter = v; },
  get _mergeSelected() { return WorksheetManager._mergeSelected; }, set _mergeSelected(v) { WorksheetManager._mergeSelected = v; },
  _saveCurrentWS()                { return WorksheetManager._saveCurrentWS.call(this); },
  _loadWS(idx)                    { return WorksheetManager._loadWS.call(this, idx); },
  switchWorksheet(idx)            { return WorksheetManager.switchWorksheet.call(this, idx); },
  addWorksheet()                  { return WorksheetManager.addWorksheet.call(this); },
  removeWorksheet(idx)            { return WorksheetManager.removeWorksheet.call(this, idx); },
  _renderWSTabs()                 { return WorksheetManager._renderWSTabs.call(this); },
  mergeSelectedSheets()           { return WorksheetManager.mergeSelectedSheets.call(this); },

  clearAll() {
    this.parts = [];
    this.nestResult = null;
    this._resetRulesMode && this._resetRulesMode();
    colorIdx = 0;
    Renderer.parts = [];
    Renderer.nestResult = null;
    this._saveCurrentWS();
    this.updatePartsUI();
    this.updateUI();
    Renderer.draw();
    document.getElementById('empty-canvas').style.display = 'flex';
    document.getElementById('nest-status').textContent = 'Ready';
  },

  /* ══════════════════════════════════════════════════════════════════
     PROJECT SAVE / OPEN
     ─────────────────────────────────────────────────────────────────
     Save: serialize all worksheets (with parts, settings, rules,
     costing fields, nest results) into a single .nfp JSON file the
     user can download. Open: load such a file back, replacing current
     state.

     File format: JSON with version marker for future-proofing.
     Extension: .nfp (NestForge Project). Browsers accept .json too.
     ═════════════════════════════════════════════════════════════════ */

  saveProject() {
    const payload = this._buildProjectPayload();
    this._downloadProject(payload);
  },

  /* The whole project as one JSON-friendly object: what Save Project
     writes and what undo/redo snapshots (src/ui/history.js). */
  _buildProjectPayload() {
    // Snapshot current worksheet to its slot before serializing
    try { this._saveCurrentWS(); } catch (_) {}

    // Build the project payload — everything needed to fully restore
    const payload = {
      __format: 'nestforge-project',
      __version: 1,
      __savedAt: new Date().toISOString(),
      __app: 'NestForge Pro',

      // Worksheets — each contains parts, nestResult, settings, costing
      // Note: parts/nestResult contain polygon coordinates (arrays of
      // [x,y]) which are JSON-friendly. No circular refs to worry about.
      activeWS: this._activeWS,
      wsCounter: this._wsCounter,
      worksheets: this._worksheets.map(ws => ({
        id: ws.id,
        name: ws.name,
        colorIdx: ws.colorIdx || 0,
        parts: (ws.parts || []).map(p => ({
          id: p.id, name: p.name, pts: p.pts, color: p.color, qty: p.qty,
          area: p.area, bbox: p.bbox, innerLines: p.innerLines || [],
          // Don't save derived/transient fields (e.g. _rotations, _mirrorMode)
          // — these get regenerated from rules on next nest.
        })),
        nestResult: ws.nestResult ? this._serializeNestResult(ws.nestResult) : null,
        settings: ws.settings || null,
        cost: ws.cost || null,
      })),

      // Per-component rules (Map → array of [key, rule] pairs)
      // Sets become arrays so they're JSON-serializable.
      componentRules: this._componentRules
        ? Array.from(this._componentRules.entries()).map(([key, rule]) => [
            key,
            rule ? {
              ...rule,
              allowedZones: rule.allowedZones ? Array.from(rule.allowedZones) : undefined,
            } : rule
          ])
        : null,

      // Sheet outline + defects + zones (for hide nests). Simple arrays so
      // they're directly serializable. Restored verbatim on load.
      sheetType: this._sheetType,
      sheetOutline: this._sheetOutline,
      defects: this._defects,
      sheetZones: this._sheetZones,
      sheetLabels: this._sheetLabels,
      leatherGrade: this._leatherGrade,
      defectSeed: this._defectSeed,

      // UI/global preferences
      currentUnit: this._currentUnit || 'mm',
      costMode: this._costMode,
      reportFmt: this._reportFmt,

      // User's custom component renames (Map → object for JSON)
      partDisplayNames: (() => {
        if (!this._partDisplayNames) return null;
        const obj = {};
        for (const [k, v] of this._partDisplayNames) obj[k] = v;
        return obj;
      })(),

      // Live DOM settings (same as getSettings would return)
      domSettings: (() => {
        try { return this.getSettings(); } catch (_) { return null; }
      })(),
    };
    return payload;
  },

  _downloadProject(payload) {
    // Serialize and trigger download
    const json = JSON.stringify(payload, null, 0);  // compact
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `nestforge-project-${ts}.nfp`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
    document.getElementById('nest-status').textContent =
      `✓ Project saved (${(json.length / 1024).toFixed(1)} KB)`;
  },

  _serializeNestResult(r) {
    // nestResult fields the rest of the app expects:
    //   placements (array), sheets (array of {idx, placements}),
    //   placed, unplaced, sheetCount, usableW, usableH, effRes,
    //   cuttingFlow (optional flag set by flowNest)
    // Drop heavy debug data (NFP cache, intermediate buffers).
    if (!r) return null;
    const placements = (r.placements || []).map(p => ({
      partId: p.partId, partName: p.partName, color: p.color,
      x: p.x, y: p.y, rotation: p.rotation, mirror: p.mirror, sheet: p.sheet,
      pts: p.pts,
      innerLines: p.innerLines || [],
    }));
    return {
      placements,
      placed: r.placed,
      unplaced: r.unplaced,
      sheetCount: r.sheetCount,
      usableW: r.usableW,
      usableH: r.usableH,
      effRes: r.effRes,
      cuttingFlow: r.cuttingFlow,
      // Rebuild lightweight sheets array from placements (group by sheet idx).
      // Don't store sheets separately — would duplicate placement data.
      // The deserializer reconstructs sheets array on load; see _loadProject.
    };
  },

  _rebuildSheetsFromPlacements(placements) {
    // Group placements by .sheet → produce [{idx, placements}, ...]
    if (!placements || !placements.length) return [{ idx: 0, placements: [] }];
    const bySheet = new Map();
    for (const p of placements) {
      const idx = p.sheet || 0;
      if (!bySheet.has(idx)) bySheet.set(idx, []);
      bySheet.get(idx).push(p);
    }
    const out = [];
    const sortedIdx = Array.from(bySheet.keys()).sort((a, b) => a - b);
    for (const idx of sortedIdx) {
      out.push({ idx, placements: bySheet.get(idx) });
    }
    return out;
  },

  openProjectFile() {
    document.getElementById('project-input').click();
  },

  async _onProjectFileChosen(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';  // allow re-selecting same file
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (payload.__format !== 'nestforge-project') {
        alert('Not a valid NestForge project file (missing format marker).');
        return;
      }
      console.log('[Project Load] Format:', payload.__format, 'Version:', payload.__version, 'Saved:', payload.__savedAt);
      console.log('[Project Load] Worksheets:', payload.worksheets?.length, '— Active:', payload.activeWS);
      console.log('[Project Load] Component rules:', payload.componentRules?.length || 0);
      console.log('[Project Load] Sheet type:', payload.sheetType, '— Has outline:', !!payload.sheetOutline);
      if (!confirm(`Open project saved on ${payload.__savedAt || 'unknown date'}?\n\nThis will REPLACE all current worksheets, parts, and settings.`)) {
        return;
      }
      this._loadProject(payload);
      const activeWs = this._worksheets[this._activeWS];
      console.log('[Project Load] Active worksheet:', activeWs?.name, '— parts:', activeWs?.parts?.length, '— placements:', activeWs?.nestResult?.placements?.length || 0);
      document.getElementById('nest-status').textContent =
        `✓ Project loaded — ${payload.worksheets.length} worksheet(s), ${this.parts.length} part(s)`;
    } catch (e) {
      console.error('[Project Load] Failed:', e);
      alert('Failed to load project: ' + (e.message || 'unknown error') + '\n\nCheck console (F12) for details.');
    }
  },

  _loadProject(payload) {
    // Restore worksheets — rebuild Sets from arrays where needed, and
    // reconstruct nestResult.sheets (grouped by placement.sheet).
    this._worksheets = (payload.worksheets || []).map(ws => {
      const nr = ws.nestResult ? { ...ws.nestResult } : null;
      if (nr) {
        // Rebuild sheets array from placements (was dropped during save
        // to avoid duplicating placement data in JSON)
        nr.sheets = this._rebuildSheetsFromPlacements(nr.placements);
      }
      return {
        id: ws.id,
        name: ws.name,
        colorIdx: ws.colorIdx || 0,
        parts: ws.parts || [],
        nestResult: nr,
        settings: ws.settings || null,
        cost: ws.cost || null,
      };
    });
    if (this._worksheets.length === 0) {
      this._worksheets = [{ id: 0, name: 'Sheet 1', parts: [], nestResult: null, colorIdx: 0 }];
    }
    this._wsCounter = payload.wsCounter || this._worksheets.length;
    this._activeWS = Math.min(payload.activeWS || 0, this._worksheets.length - 1);

    // Per-component rules (Set restoration)
    if (payload.componentRules && Array.isArray(payload.componentRules)) {
      this._componentRules = new Map(
        payload.componentRules.map(([key, rule]) => [
          key,
          rule ? {
            ...rule,
            allowedZones: rule.allowedZones ? new Set(rule.allowedZones) : undefined,
          } : rule
        ])
      );
    } else {
      this._componentRules = null;
    }

    // Sheet/hide state
    this._sheetType = payload.sheetType || 'rectangle';
    this._sheetOutline = payload.sheetOutline || null;
    this._defects = payload.defects || [];
    this._sheetZones = payload.sheetZones || null;
    this._sheetLabels = payload.sheetLabels || null;
    this._leatherGrade = payload.leatherGrade || 'A';
    this._defectSeed = payload.defectSeed || 12345;

    // UI preferences
    if (payload.currentUnit) {
      this._currentUnit = payload.currentUnit;
      const sel = document.getElementById('s-unit');
      if (sel) sel.value = payload.currentUnit;
      try { localStorage.setItem('nestforge_unit', payload.currentUnit); } catch (_) {}
    }
    if (payload.costMode) this._costMode = payload.costMode;
    if (payload.reportFmt) this._reportFmt = payload.reportFmt;

    // Restore user's custom component renames (object → Map)
    if (payload.partDisplayNames && typeof payload.partDisplayNames === 'object') {
      this._initDisplayNames();
      this._partDisplayNames.clear();
      for (const [k, v] of Object.entries(payload.partDisplayNames)) {
        this._partDisplayNames.set(k, v);
      }
      this._saveDisplayNames();
    }

    // Restore DOM settings (sheet dims, margin, gap, mirror, etc.)
    if (payload.domSettings) {
      const s = payload.domSettings;
      const u = this._unitToMM ? this._unitToMM() : 1;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      // Convert mm settings back to current display unit
      if (s.sheetW != null) setVal('s-width',  this._formatNum(s.sheetW / u));
      if (s.sheetH != null) setVal('s-height', this._formatNum(s.sheetH / u));
      if (s.margin != null) setVal('s-margin', this._formatNum(s.margin / u));
      if (s.gap != null)    setVal('s-gap',    this._formatNum(s.gap / u));
      setVal('mirror-mode', s.mirrorMode);
      setVal('s-copies', s.copies);
      setVal('s-grow-dir', s.growDir);
      const al = document.getElementById('s-auto-length');
      if (al && s.autoLength != null) { al.checked = !!s.autoLength; this._onGrowToggle && this._onGrowToggle(); }
      // Multi-sheet checkbox
      const ms = document.getElementById('s-multi-sheet');
      if (ms && s.multiSheet != null) ms.checked = !!s.multiSheet;
      // Sheet type dropdown
      setVal('sheet-type', this._sheetType);
    }

    // Sheet-type-specific setup (hide outline rendering, defect scaling)
    Renderer.sheetW = payload.domSettings ? payload.domSettings.sheetW : Renderer.sheetW;
    Renderer.sheetH = payload.domSettings ? payload.domSettings.sheetH : Renderer.sheetH;
    Renderer.sheetOutline = this._sheetOutline;
    Renderer.defects = this._defects || [];
    Renderer.sheetZones = this._sheetZones;
    Renderer.sheetLabels = this._sheetLabels;

    // Activate the saved worksheet
    this._loadWS(this._activeWS);
    this._renderWSTabs && this._renderWSTabs();
    this.updatePartsUI();
    this.updateUI();
    Renderer.fitView();
    Renderer.draw();
    if (this._refreshAreaDisplay) this._refreshAreaDisplay();
  },

  /* ══════════════════════════════════════════════════════════════════
     IMPROVE — try alternative strategies and keep the better result.
     Auto for hide nests (already handled inside _runNestingProceed via
     extended `strategies` array). Manual for rectangle nests via this
     button: re-runs with _improveMode=true which forces all 3 strategies
     and disables early-exit.

     Comparison rule (lower is BETTER for ranking):
       primary:  more PLACED parts wins
       tiebreak: tighter bbox area wins
     If new is no better, original is restored and status notes that.
     ═════════════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════
     IMPROVE — INCREMENTAL edge-fill, NOT a re-nest.
     ─────────────────────────────────────────────────────────────────
     Previous behavior: re-ran the entire nest with alternate strategies
     and swapped in whichever placed more. Problem: if user manually
     added/moved placements (via right-click-drag), that work was lost
     because the new nest started from scratch.

     New behavior: KEEP every current placement (engine-placed AND
     hand-placed). Run an incremental edge-fill pass that tries to
     squeeze more parts into remaining gaps — exactly what the user
     does manually with right-click-drag, but automated across the
     whole sheet with a 10mm dense grid and 15-second budget.

     Only polygon engine supports this for now. Works for both hide and
     rectangle nests.
     ═════════════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════
     ADVANCED NESTING — Genetic Algorithm exploration.
     ─────────────────────────────────────────────────────────────────
     Takes 2-4 minutes. Generates N independent candidate layouts using
     the existing engine with different random seeds (diversity), keeps
     the best, then refines via shake+fill. Standard "Run Nesting" stays
     unchanged — this is OPT-IN via the new "Run Advanced Nesting" button.

     Algorithm:
       1. Generation 0: spawn POP_SIZE (8) layouts, each with a unique
          _diversitySeed → engine produces measurably different layouts.
       2. Score each by (placedCount DESC, bbox ASC). Keep top ELITE (3).
       3. Generation 1+: for each elite, spawn 2 children with mutation
          (new seed + jittered queue ordering). Run engine on each.
       4. After GENS (3) generations, take the global best.
       5. Run final shake-and-fit + dense-fill polish on best result.
       6. Compare to user's CURRENT result; only swap if strictly better.

     Cancelable. Falls back gracefully on errors.
     Uses ALL existing engine code unchanged — pure orchestration layer.
     ═════════════════════════════════════════════════════════════════ */
  async runAdvancedNesting() {
    if (!this.parts.length) {
      alert('Add some parts first, then click Run Advanced Nesting.');
      return;
    }
    if (this._gaMode || this._improveMode) return;
    if (window.__useRasterEngine) {
      alert('Advanced Nesting requires polygon engine. Disable raster mode in settings.');
      return;
    }

    // ── Per-component rules popup ──
    // Same gate as regular runNesting — if multiple components and rules
    // not yet set this session, prompt user. Otherwise GA candidates would
    // run with NO zone rules / rotation restrictions, defeating the purpose.
    if (this._shouldAskComponentRules()) {
      // Tell modal to call THIS method back (not runNesting) when user confirms
      this._postRulesAction = 'advanced';
      this._openRulesModal();
      return;
    }
    this._postRulesAction = null;

    // Diagnostic — print active rules so user can verify GA is honoring them
    if (this._componentRules && this._componentRules.size > 0) {
      const ruleSummary = [];
      for (const [k, r] of this._componentRules) {
        const parts = [];
        if (r.allowedZones && r.allowedZones.size) parts.push(`zones=[${[...r.allowedZones].join(',')}]`);
        if (r.setCount) parts.push(`perSet=${r.setCount}`);
        if (parts.length) ruleSummary.push(`${k}→{${parts.join(', ')}}`);
      }
      console.log(`[Advanced GA] Rules in effect: ${ruleSummary.join(' | ') || '(no zone/set restrictions)'}`);
    } else {
      console.log('[Advanced GA] No component rules set (vamps/quarters can go anywhere)');
    }

    this._gaMode = true;
    this._cancelled = false;
    const statusEl = document.getElementById('nest-status');
    const progBar = document.getElementById('prog-bar');
    const progSub = document.getElementById('prog-sub');
    const progModal = document.getElementById('progress-modal');
    if (progModal) progModal.style.display = 'flex';

    // Snapshot current state — restore if user cancels or GA produces nothing
    const savedResult = this.nestResult ? {
      ...this.nestResult,
      placements: this.nestResult.placements ? this.nestResult.placements.slice() : []
    } : null;
    const savedScore = this._scoreNest(savedResult);

    // GA hyperparameters — tuned for ~3 minute total budget
    const POP_SIZE = 6;          // 6 candidates per generation
    const ELITE = 2;             // top-2 carry forward
    const GENS = 2;              // 2 mutation generations after gen-0
    const TOTAL_BUDGET_MS = 180000;  // 3 minutes hard cap
    const startT = performance.now();

    const candidates = [];  // {seed, result, score}

    try {
      // ── GENERATION 0: spawn POP_SIZE layouts with diverse seeds ──
      for (let i = 0; i < POP_SIZE; i++) {
        if (this._cancelled) break;
        if (performance.now() - startT > TOTAL_BUDGET_MS * 0.6) break;
        const seed = (Math.floor(Math.random() * 0x7fffffff) | 1) >>> 0;
        if (statusEl) statusEl.textContent = `Advanced (Gen 0, ${i+1}/${POP_SIZE}) seed=${seed.toString(16).slice(0,4)}…`;
        if (progSub) progSub.textContent = `Generation 0 candidate ${i+1} of ${POP_SIZE}`;
        if (progBar) progBar.style.width = ((i / (POP_SIZE * (1 + GENS))) * 100).toFixed(0) + '%';
        const r = await this._runNestingWithSeed(seed);
        if (r) {
          const s = this._scoreNest(r);
          candidates.push({ seed, result: r, score: s });
          console.log(`[Advanced GA] Gen 0 #${i+1}: placed=${s.placed}, bbox=${Math.round(s.bbox)}`);
        }
      }

      // ── GENERATIONS 1..GENS: mutate the elites ──
      for (let g = 1; g <= GENS; g++) {
        if (this._cancelled) break;
        if (performance.now() - startT > TOTAL_BUDGET_MS * 0.85) break;
        // Sort by fitness, take elite
        candidates.sort((a, b) => {
          if (a.score.placed !== b.score.placed) return b.score.placed - a.score.placed;
          return a.score.bbox - b.score.bbox;
        });
        const eliteList = candidates.slice(0, ELITE);
        let childIdx = 0;
        for (const elite of eliteList) {
          for (let m = 0; m < 2; m++) {  // 2 children per elite
            if (this._cancelled) break;
            if (performance.now() - startT > TOTAL_BUDGET_MS * 0.85) break;
            // Mutation = new seed derived from parent seed + small jitter
            const mutSeed = ((elite.seed * 1103515245 + 12345 + (m * 31)) ^ Date.now()) >>> 0;
            childIdx++;
            if (statusEl) statusEl.textContent = `Advanced (Gen ${g}, child ${childIdx}/${eliteList.length*2}) seed=${mutSeed.toString(16).slice(0,4)}…`;
            if (progSub) progSub.textContent = `Generation ${g} mutation ${childIdx} of ${eliteList.length*2}`;
            if (progBar) {
              const totalSteps = POP_SIZE * (1 + GENS);
              const done = POP_SIZE + (g - 1) * eliteList.length * 2 + childIdx;
              progBar.style.width = ((done / totalSteps) * 100).toFixed(0) + '%';
            }
            const r = await this._runNestingWithSeed(mutSeed);
            if (r) {
              const s = this._scoreNest(r);
              candidates.push({ seed: mutSeed, result: r, score: s });
              console.log(`[Advanced GA] Gen ${g} child ${childIdx}: placed=${s.placed}, bbox=${Math.round(s.bbox)}`);
            }
          }
        }
      }

      // ── PICK GLOBAL BEST ──
      if (candidates.length === 0) throw new Error('No candidates produced');
      candidates.sort((a, b) => {
        if (a.score.placed !== b.score.placed) return b.score.placed - a.score.placed;
        return a.score.bbox - b.score.bbox;
      });
      const best = candidates[0];
      console.log(`[Advanced GA] WINNER: placed=${best.score.placed}, bbox=${Math.round(best.score.bbox)} from ${candidates.length} candidates`);

      // Install the best result so polish can operate on it
      this.nestResult = best.result;
      Renderer.nestResult = best.result;
      Renderer.draw();

      // ── POLISH: shake + fill the winner if budget allows ──
      const remaining = TOTAL_BUDGET_MS - (performance.now() - startT);
      if (remaining > 5000 && !this._cancelled) {
        if (statusEl) statusEl.textContent = `Advanced — polishing winner (+0 so far)…`;
        if (progSub) progSub.textContent = 'Final polish: shake + fill';
        if (progBar) progBar.style.width = '95%';
        const settings = this.getSettings();
        settings._diversitySeed = best.seed;
        const partDefsRaw = this.parts.map(p =>
          this._applyComponentRules(p, settings.rotations, settings.mirrorMode)
        );
        const partDefs = this._expandForMustMirror(partDefsRaw, settings.mirrorMode);
        try {
          const fill1 = await PolyNestEngine.denseEdgeFill(
            this.nestResult.placements, partDefs, settings,
            () => this._cancelled, Math.min(8000, remaining * 0.3)
          );
          if (fill1.length > 0) {
            for (const p of fill1) {
              if (p.sheet == null) p.sheet = 0;
              this.nestResult.placements.push(p);
            }
          }
          const remaining2 = TOTAL_BUDGET_MS - (performance.now() - startT);
          if (remaining2 > 3000) {
            const shakeRes = await PolyNestEngine.shakeAndFit(
              this.nestResult.placements, partDefs, settings,
              () => this._cancelled, Math.min(15000, remaining2 - 1000)
            );
            if (shakeRes.totalAdded > 0) {
              this.nestResult.placements = shakeRes.layout;
            }
          }
          this.nestResult.placed = this.nestResult.placements.length;
        } catch (e) {
          console.error('[Advanced GA] polish failed:', e);
        }
      }

      // ── COMMIT vs original ──
      const newScore = this._scoreNest(this.nestResult);
      const better = (newScore.placed > savedScore.placed) ||
                     (newScore.placed === savedScore.placed && newScore.bbox + 1 < savedScore.bbox);
      if (savedResult && !better) {
        // GA didn't beat user's existing layout — restore
        this.nestResult = savedResult;
        Renderer.nestResult = savedResult;
        if (statusEl) statusEl.textContent = `Advanced: explored ${candidates.length} layouts, no improvement (kept your current)`;
      } else {
        const delta = savedResult ? newScore.placed - savedScore.placed : newScore.placed;
        this.updateStats(this.nestResult, this.getSettings());
        this._saveCurrentWS();
        if (statusEl) statusEl.textContent = `🧬 Advanced complete: best of ${candidates.length} layouts (${delta >= 0 ? '+' : ''}${delta} parts)`;
      }
      Renderer.draw();
    } catch (e) {
      console.error('[Advanced GA] failed:', e);
      if (statusEl) statusEl.textContent = '✗ Advanced Nesting failed — see console';
      // Restore original on hard failure
      if (savedResult) {
        this.nestResult = savedResult;
        Renderer.nestResult = savedResult;
        Renderer.draw();
      }
    } finally {
      if (progModal) progModal.style.display = 'none';
      this._gaMode = false;
    }
  },

  /* Internal helper for GA: run one full nest with a specific diversity seed.
     Wraps _runNestingProceed but captures the result instead of letting it
     write directly into nestResult — caller compares candidates explicitly. */
  async _runNestingWithSeed(seed) {
    const savedSeed = this._gaPendingSeed;
    this._gaPendingSeed = seed;
    const savedResult = this.nestResult;
    try {
      await this._runNestingProceed();
      const r = this.nestResult;
      // Restore (caller will install the chosen winner)
      this.nestResult = savedResult;
      return r;
    } finally {
      this._gaPendingSeed = savedSeed;
    }
  },

  async tryImprove() {
    if (!this.nestResult || !this.parts.length) {
      alert('Run nesting first, then click Improve to squeeze in more parts.');
      return;
    }
    if (this._improveMode) return; // already running
    this._improveMode = true;
    const statusEl = document.getElementById('nest-status');
    const baseStatus = statusEl ? statusEl.textContent : '';
    const TOTAL_BUDGET_MS = 45000;  // 45 seconds overall cap
    const startT = performance.now();

    let currentPlacements = this.nestResult.placements.slice();
    const initialCount = currentPlacements.length;
    const settings = this.getSettings();
    // Each Improve click gets a NEW random seed → engine explores different
    // micro-layouts via the placeBest jitter. Without this, repeated clicks
    // would produce identical results (deterministic cost function).
    settings._diversitySeed = (Math.floor(Math.random() * 0x7fffffff) | 1) >>> 0;
    const partDefsRaw = this.parts.map(p =>
      this._applyComponentRules(p, settings.rotations, settings.mirrorMode)
    );
    const partDefs = this._expandForMustMirror(partDefsRaw, settings.mirrorMode);

    // Live preview — push new placements as they happen, redraw via rAF
    let liveTimer = null;
    const scheduleDraw = () => {
      if (liveTimer) return;
      liveTimer = requestAnimationFrame(() => {
        liveTimer = null;
        Renderer.draw();
      });
    };
    const onLivePlacement = (evt) => {
      if (!evt || !evt.placement) return;
      const sheetIdx = (this.nestResult.placements[0] && this.nestResult.placements[0].sheet) || 0;
      evt.placement.sheet = sheetIdx;
      this.nestResult.placements.push(evt.placement);
      this.nestResult.placed = this.nestResult.placements.length;
      scheduleDraw();
    };
    // Shake commit: swap to new layout (rotated piece + new fills) at once
    const onShake = (evt) => {
      if (!evt || !evt.newLayout) return;
      const sheetIdx = (this.nestResult.placements[0] && this.nestResult.placements[0].sheet) || 0;
      for (const p of evt.newLayout) {
        if (p.sheet == null) p.sheet = sheetIdx;
      }
      this.nestResult.placements = evt.newLayout.slice();
      this.nestResult.placed = this.nestResult.placements.length;
      scheduleDraw();
    };

    try {
      // ── PASS 1: dense edge-fill (find easy empty spots) ──────────
      if (statusEl) statusEl.textContent = '⏳ Improving (1/3) — scanning for empty gaps…';
      await sleep(0);
      const pass1 = await PolyNestEngine.denseEdgeFill(
        currentPlacements, partDefs, settings,
        () => this._cancelled, 12000, onLivePlacement
      );
      if (pass1.length > 0) {
        currentPlacements = this.nestResult.placements.slice();
      }

      // ── PASS 2: shake-and-fit (rotate existing parts in place; check if it opens room) ──
      const remaining = TOTAL_BUDGET_MS - (performance.now() - startT);
      if (remaining > 3000 && !this._cancelled) {
        if (statusEl) statusEl.textContent = `⏳ Improving (2/3) — rotating pieces to open gaps (+${pass1.length} so far)…`;
        await sleep(0);
        const shakeRes = await PolyNestEngine.shakeAndFit(
          currentPlacements, partDefs, settings,
          () => this._cancelled,
          Math.min(20000, remaining - 3000),
          onLivePlacement, onShake
        );
        if (shakeRes.totalAdded > 0) {
          currentPlacements = this.nestResult.placements.slice();
        }
      }

      // ── PASS 3: final dense edge-fill (catch anything opened up by shake) ──
      const remaining2 = TOTAL_BUDGET_MS - (performance.now() - startT);
      if (remaining2 > 2000 && !this._cancelled) {
        const addedSoFar = currentPlacements.length - initialCount;
        if (statusEl) statusEl.textContent = `⏳ Improving (3/3) — final cleanup scan (+${addedSoFar} so far)…`;
        await sleep(0);
        const pass3 = await PolyNestEngine.denseEdgeFill(
          currentPlacements, partDefs, settings,
          () => this._cancelled, Math.min(10000, remaining2 - 1000), onLivePlacement
        );
        if (pass3.length > 0) {
          currentPlacements = this.nestResult.placements.slice();
        }
      }

      // Commit results — nestResult.placements already contains everything
      // (built up by the live callbacks). Just sync metadata.
      const totalAdded = this.nestResult.placements.length - initialCount;
      if (totalAdded > 0) {
        this.nestResult.placed = this.nestResult.placements.length;
        this.updateStats(this.nestResult, settings);
        this._saveCurrentWS();
        Renderer.draw();
        if (statusEl) statusEl.textContent = baseStatus + `  ✨ Improved (+${totalAdded} parts)`;
      } else {
        if (statusEl) statusEl.textContent = baseStatus + '  •  No room for more parts (layout is already tight)';
      }
    } catch (e) {
      console.error('[Improve] failed:', e);
      if (statusEl) statusEl.textContent = baseStatus + '  ✗ Improve failed — see console';
    }
    this._improveMode = false;
  },

  /* Score a nest result for improvement comparison.
     Returns { placed, bbox } — caller compares: more placed wins,
     then smaller bbox wins. */
  _scoreNest(result) {
    if (!result || !result.placements || !result.placements.length) {
      return { placed: 0, bbox: Infinity };
    }
    let maxX = 0, maxY = 0;
    for (const pl of result.placements) {
      const bb = polyBBox(pl.pts);
      const right = pl.x + bb.w, bottom = pl.y + bb.h;
      if (right  > maxX) maxX = right;
      if (bottom > maxY) maxY = bottom;
    }
    return { placed: result.placed || result.placements.length, bbox: maxX * maxY };
  },

  zoomIn()  { Renderer.zoom *= 1.2; Renderer.draw(); document.getElementById('zoom-val').textContent = Math.round(Renderer.zoom*100)+'%'; },
  zoomOut() { Renderer.zoom /= 1.2; Renderer.draw(); document.getElementById('zoom-val').textContent = Math.round(Renderer.zoom*100)+'%'; },
  fitView() { Renderer.fitView(); },
  toggleGrid() {
    Renderer.showGrid = !Renderer.showGrid;
    document.getElementById('btn-grid').classList.toggle('active', Renderer.showGrid);
    Renderer.draw();
  },
  /* ══════════════════════════════════════════════════════════════════
     EXPORT (SVG/DXF) — delegators
     Implementation lives in the ExportManager module (before App).
     ═════════════════════════════════════════════════════════════════ */
  get _exportFmt() { return ExportManager._exportFmt; }, set _exportFmt(v) { ExportManager._exportFmt = v; },
  openExportDialog()              { return ExportManager.openExportDialog.call(this); },
  _closeExportDialog()            { return ExportManager._closeExportDialog(); },
  _setExportFmt(f)                { return ExportManager._setExportFmt(f); },
  _getExportOpts()                { return ExportManager._getExportOpts(); },
  _buildStampText(o)              { return ExportManager._buildStampText.call(this, o); },
  _getStampAnchor(p,w,h,m,fs,lc)  { return ExportManager._getStampAnchor(p,w,h,m,fs,lc); },
  _doExport()                     { return ExportManager._doExport.call(this); },
  _exportSVG(o)                   { return ExportManager._exportSVG.call(this, o); },
  _exportDXF(o)                   { return ExportManager._exportDXF.call(this, o); },
  _exportPDF(o)                   { return ExportManager._exportPDF.call(this, o); },
};

// XML escape helper for SVG text
function _escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// ── INIT ──
window.addEventListener('DOMContentLoaded', () => {
  try {
    App.init();
  } catch (err) {
    // Show visible error instead of blank page
    const body = document.body;
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;inset:0;background:#090a0c;color:#dde1f0;padding:20px;font-family:sans-serif;overflow:auto;z-index:99999';
    div.innerHTML = '<h2 style="color:#f97316">NestForge Pro — startup error</h2>' +
                    '<p style="margin:10px 0">The app failed to initialize. Details:</p>' +
                    '<pre style="background:#111;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-word">' +
                    (err.message || String(err)) + '\n\n' + (err.stack || '') + '</pre>' +
                    '<p style="margin-top:20px;color:#888">Please share this screenshot so we can fix it.</p>';
    body.appendChild(div);
    console.error('Init failed:', err);
  }
});

