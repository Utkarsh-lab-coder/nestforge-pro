/*
 * NestForge Pro — LeatherNorm — leather consumption norm calculator (parallelogram method)
 *
 * Original location: lines 17256..18830 of nestforge-pro.html (1575 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const LeatherNorm = {
  canvas: null, ctx: null,
  offsetX: 0, offsetY: 0, zoom: 1,
  components: [],       // analyses (built from `groups`)
  activeIdx: 0,
  showLabels: true,
  allowMirror: true,
  rotations: new Set([0, 90, 180, 270]),

  // Layout preference for combined-set packing: 'auto' (tightest material),
  // 'sidebyside' (force horizontal arrangement), 'stacked' (force vertical).
  layoutPref: 'auto',

  // ── Pieces / gap / units ──────────────────────────────────────
  piecesCount: 2,        // default # of identical pieces per parallelogram
  gapMm: 2,              // minimum gap between pieces (mm)

  // ── Per-component rules (set via the rules popup) ────────────
  // partId → { pieces, rotations:Set, mirror:bool, allowance:0..1 }
  _compRules: {},

  // ── Groups: array of analysis-group definitions ──────────────
  // Each group is either:
  //   { type: 'single', partId: 'v0' }
  //     → analyzes 1 part type with N copies (N = compRules[partId].pieces)
  //   { type: 'combined', id: 'g_xxx', partIds: ['v0','q1'], name: 'Set 1' }
  //     → analyzes a custom mix; piece count per part comes from compRules
  // Groups[] is rebuilt on open(), users can ADD combined groups via
  // multi-select + right-click / drag-drop.
  _groups: [],

  // ── Selection state for multi-select in component cards ──────
  _selected: new Set(),  // set of indices into `components`

  // ── Unit + Wastage ────────────────────────────────────────────
  unit: 'cm2',           // 'cm2' | 'dm2' | 'sqft' | 'sqin'
  wastagePct: 10,        // % wastage allowance applied to gross norm

  // ── Quick grade allowance presets ─────────────────────────────
  GRADE_ALLOWANCES: { 'A': 5, 'B': 10, 'C': 15, 'D': 20, 'E': 25 },

  // Conversion to cm² (canonical)
  _UNIT_FACTORS: { 'cm2': 1, 'dm2': 0.01, 'sqft': 0.001076, 'sqin': 0.155 },
  _UNIT_LABELS: { 'cm2': 'cm²', 'dm2': 'dm²', 'sqft': 'sq.ft', 'sqin': 'sq.in' },

  /* Convert a value in mm² to the currently-selected display unit. */
  _formatArea(mm2, includeUnit = true) {
    const cm2 = mm2 / 100;
    const v = cm2 * this._UNIT_FACTORS[this.unit];
    const lbl = this._UNIT_LABELS[this.unit];
    return v.toFixed(2) + (includeUnit ? ' ' + lbl : '');
  },

  /* Format a LINEAR dimension (mm) for dimension lines on the parallelogram.
     Uses unit consistent with the area setting (cm² → cm, sq.ft → ft, etc.).
     Always shows mm for small values (<50mm) since that's what CAD users expect. */
  _formatDim(mm) {
    if (this.unit === 'cm2' || this.unit === 'dm2') {
      if (mm < 10) return mm.toFixed(1) + ' mm';
      return (mm / 10).toFixed(1) + ' cm';
    } else if (this.unit === 'sqft') {
      const feet = mm / 304.8;
      if (feet < 1) return (mm / 25.4).toFixed(2) + '″';
      return feet.toFixed(2) + ' ft';
    } else if (this.unit === 'sqin') {
      return (mm / 25.4).toFixed(2) + '″';
    }
    return mm.toFixed(1) + ' mm';
  },

  open() {
    const modal = document.getElementById('norm-modal');
    if (!modal) return;
    if (!App.parts || App.parts.length === 0) {
      alert('Please import at least one DXF component first.');
      return;
    }
    // Always show rules popup first (per user's choice)
    this._showPreOpenRulesPopup();
  },

  /* Mandatory popup shown EVERY time Norm Calculator is opened.
     Lets user set per-component rules (pieces/rotations/mirror/allowance)
     plus global params (gap, units, default wastage), then click Continue. */
  _showPreOpenRulesPopup() {
    // Initialize default rules for any new parts
    for (const p of App.parts) {
      if (!this._compRules[p.id]) {
        this._compRules[p.id] = {
          pieces: this.piecesCount,
          rotations: new Set(this.rotations),
          mirror: this.allowMirror,
          allowance: this.wastagePct / 100,
        };
      }
    }
    const popup = document.createElement('div');
    popup.id = 'nm-rules-popup';
    popup.style.cssText = 'position:fixed;inset:0;z-index:2010;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85)';

    let html = `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;width:92vw;max-width:820px;max-height:92vh;display:flex;flex-direction:column">
        <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:700;font-size:15px">📐 Configure Norm Calculation</span>
          <button onclick="document.getElementById('nm-rules-popup').remove()" style="background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;padding:4px 10px">✕</button>
        </div>
        <div style="padding:14px 20px;overflow-y:auto;flex:1">
          <!-- Global settings -->
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:12px;border:1px solid var(--border2);border-radius:6px;margin-bottom:14px;background:var(--card)">
            <div>
              <div style="font-size:9px;color:var(--text3);margin-bottom:3px;text-transform:uppercase;letter-spacing:1px">Gap (mm)</div>
              <input type="number" min="0" max="50" step="0.5" value="${this.gapMm}" id="nm-popup-gap"
                style="width:100%;background:var(--panel);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:3px;font-family:var(--font-mono);font-size:12px;outline:none">
            </div>
            <div>
              <div style="font-size:9px;color:var(--text3);margin-bottom:3px;text-transform:uppercase;letter-spacing:1px">Display Unit</div>
              <select id="nm-popup-unit" style="width:100%;background:var(--panel);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:3px;font-family:var(--font-mono);font-size:12px;outline:none">
                <option value="cm2"${this.unit==='cm2'?' selected':''}>cm²</option>
                <option value="dm2"${this.unit==='dm2'?' selected':''}>dm²</option>
                <option value="sqft"${this.unit==='sqft'?' selected':''}>sq.ft</option>
                <option value="sqin"${this.unit==='sqin'?' selected':''}>sq.in</option>
              </select>
            </div>
            <div>
              <div style="font-size:9px;color:var(--text3);margin-bottom:3px;text-transform:uppercase;letter-spacing:1px">Default Wastage %</div>
              <input type="number" min="0" max="100" step="0.5" value="${this.wastagePct}" id="nm-popup-wastage"
                style="width:100%;background:var(--panel);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:3px;font-family:var(--font-mono);font-size:12px;outline:none">
            </div>
            <div>
              <div style="font-size:9px;color:var(--text3);margin-bottom:3px;text-transform:uppercase;letter-spacing:1px" title="Tightest = best material use, may stack vertically. Side-by-side / Stacked = force one orientation.">Layout</div>
              <select id="nm-popup-layout" style="width:100%;background:var(--panel);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:3px;font-family:var(--font-mono);font-size:11px;outline:none" title="Tightest=best material use • Side-by-side=horizontal • Stacked=vertical">
                <option value="auto"${(this.layoutPref||'auto')==='auto'?' selected':''}>Tightest (auto)</option>
                <option value="sidebyside"${this.layoutPref==='sidebyside'?' selected':''}>Side-by-side</option>
                <option value="stacked"${this.layoutPref==='stacked'?' selected':''}>Stacked</option>
              </select>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:8px;line-height:1.5">
            <b>Quick allowance grade:</b>
            <button class="nm-toggle-btn" style="margin-left:6px" onclick="LeatherNorm._popupApplyAll('allowance', 0.05)">A: 5%</button>
            <button class="nm-toggle-btn" onclick="LeatherNorm._popupApplyAll('allowance', 0.10)">B: 10%</button>
            <button class="nm-toggle-btn" onclick="LeatherNorm._popupApplyAll('allowance', 0.15)">C: 15%</button>
            <button class="nm-toggle-btn" onclick="LeatherNorm._popupApplyAll('allowance', 0.20)">D: 20%</button>
            <button class="nm-toggle-btn" onclick="LeatherNorm._popupApplyAll('allowance', 0.25)">E: 25%</button>
          </div>
          <div style="font-size:10px;color:var(--text3);margin-bottom:10px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">Per-Component Rules (${App.parts.length} components)</div>
    `;

    for (const part of App.parts) {
      const r = this._compRules[part.id];
      const bb = polyBBox(part.pts);
      const svgThumb = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb.x-2} ${bb.y-2} ${bb.w+4} ${bb.h+4}" width="60" height="60" preserveAspectRatio="xMidYMid meet">
        <polygon points="${part.pts.map(p=>p[0]+','+p[1]).join(' ')}" fill="${part.color||'#88a'}33" stroke="${part.color||'#88a'}" stroke-width="${Math.max(bb.w,bb.h)/100}"/>
      </svg>`;
      const isActiveRot = (rot) => r.rotations.has(rot) ? 'active' : '';
      html += `
        <div style="display:flex;gap:14px;padding:10px;border:1px solid var(--border2);border-radius:6px;margin-bottom:8px;background:var(--card);align-items:flex-start" data-part-row="${part.id}">
          <div style="width:60px;height:60px;background:#fff;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center">${svgThumb}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:12px;color:var(--text);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${part.name||part.id}</div>
            <div style="display:grid;grid-template-columns:auto auto auto auto;gap:4px 10px;align-items:center;font-size:10px">
              <span style="color:var(--text3);text-transform:uppercase;letter-spacing:1px">Pieces</span>
              <input type="number" min="1" max="20" value="${r.pieces}" data-pop-pieces="${part.id}"
                style="width:60px;background:var(--panel);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:3px;font-family:var(--font-mono);font-size:11px;outline:none">
              <span style="color:var(--text3);text-transform:uppercase;letter-spacing:1px">Allowance %</span>
              <input type="number" min="0" max="100" step="0.5" value="${(r.allowance*100).toFixed(1)}" data-pop-allow="${part.id}"
                style="width:60px;background:var(--panel);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:3px;font-family:var(--font-mono);font-size:11px;outline:none">
            </div>
            <div style="display:flex;gap:8px;margin-top:6px;font-size:10px;align-items:center;flex-wrap:wrap">
              <span style="color:var(--text3);text-transform:uppercase;letter-spacing:1px">Rot:</span>
              <button class="nm-toggle-btn ${isActiveRot(0)}" data-pop-rot="${part.id}|0" onclick="LeatherNorm._popupClickRot(this)">0°</button>
              <button class="nm-toggle-btn ${isActiveRot(90)}" data-pop-rot="${part.id}|90" onclick="LeatherNorm._popupClickRot(this)">90°</button>
              <button class="nm-toggle-btn ${isActiveRot(180)}" data-pop-rot="${part.id}|180" onclick="LeatherNorm._popupClickRot(this)">180°</button>
              <button class="nm-toggle-btn ${isActiveRot(270)}" data-pop-rot="${part.id}|270" onclick="LeatherNorm._popupClickRot(this)">270°</button>
              <span style="color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-left:8px">Mirror:</span>
              <button class="nm-toggle-btn ${(r.mirror==='none' || r.mirror===false)?'active':''}" data-pop-mir="${part.id}|none" onclick="LeatherNorm._popupClickMir(this)" title="Never mirror — original orientation only">None</button>
              <button class="nm-toggle-btn ${(r.mirror==='optional' || r.mirror===true || r.mirror===undefined)?'active':''}" data-pop-mir="${part.id}|optional" onclick="LeatherNorm._popupClickMir(this)" title="Engine tries with and without mirror, picks better">Optional</button>
              <button class="nm-toggle-btn ${r.mirror==='must'?'active':''}" data-pop-mir="${part.id}|must" onclick="LeatherNorm._popupClickMir(this)" title="Must be mirrored — original orientation never used">Must</button>
            </div>
          </div>
        </div>
      `;
    }

    html += `
        </div>
        <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;align-items:center">
          <span style="font-size:10px;color:var(--text3);margin-right:auto">💡 Tip: Once open, Ctrl/Shift-click components and right-click for combine options</span>
          <button class="header-btn" onclick="LeatherNorm._compRules = {}; document.getElementById('nm-rules-popup').remove(); LeatherNorm._showPreOpenRulesPopup()">Reset All</button>
          <button class="header-btn primary" onclick="LeatherNorm._popupContinue()">▶ Continue to Calculator</button>
        </div>
      </div>
    `;
    popup.innerHTML = html;
    document.body.appendChild(popup);
  },

  /* Click handlers for the popup buttons (read attrs to avoid template issues) */
  _popupClickRot(btn) {
    const [partId, rotStr] = btn.dataset.popRot.split('|');
    const rot = parseInt(rotStr);
    const set = this._compRules[partId].rotations;
    if (set.has(rot)) {
      if (set.size > 1) { set.delete(rot); btn.classList.remove('active'); }
    } else {
      set.add(rot);
      btn.classList.add('active');
    }
  },

  _popupClickMir(btn) {
    const [partId, val] = btn.dataset.popMir.split('|');
    // val is 'none' | 'optional' | 'must' — store as string mirror mode.
    // The alternation logic in _rebuildComponents handles the actual flip:
    // when mirror='must', it builds a flipped variant locally and alternates
    // pieces between original and flipped. So we DON'T physically flip
    // part.pts here — that would double-flip and cancel the alternation.
    this._compRules[partId].mirror = val;
    // Update button siblings active state
    const popup = document.getElementById('nm-rules-popup');
    if (popup) {
      popup.querySelectorAll(`[data-pop-mir^="${partId}|"]`).forEach(b => {
        b.classList.toggle('active', b.dataset.popMir === btn.dataset.popMir);
      });
    }
    // Trigger rebuild so the new mirror state takes effect immediately
    if (this._compRules && Object.keys(this._compRules).length > 0) {
      this._rebuildComponents && this._rebuildComponents();
      this._refreshList && this._refreshList();
      this._renderActive && this._renderActive();
    }
  },

  /* Continue button — read all popup values into _compRules, then open calc. */
  _popupContinue() {
    const popup = document.getElementById('nm-rules-popup');
    if (!popup) return;
    // Global params
    const gap = parseFloat(popup.querySelector('#nm-popup-gap').value);
    if (!isNaN(gap)) this.gapMm = Math.max(0, Math.min(50, gap));
    const unit = popup.querySelector('#nm-popup-unit').value;
    if (this._UNIT_FACTORS[unit]) this.unit = unit;
    const wast = parseFloat(popup.querySelector('#nm-popup-wastage').value);
    if (!isNaN(wast)) this.wastagePct = Math.max(0, Math.min(100, wast));
    // Layout preference — affects scoring in _packGreedy. 'auto' uses the
    // tightest material packing (default — interlocks shapes if possible).
    // 'sidebyside' / 'stacked' force one orientation by heavily penalizing
    // the other in the scorer.
    const layoutEl = popup.querySelector('#nm-popup-layout');
    if (layoutEl) this.layoutPref = layoutEl.value || 'auto';
    // Per-component pieces + allowance from inputs
    popup.querySelectorAll('[data-pop-pieces]').forEach(inp => {
      const partId = inp.dataset.popPieces;
      const v = parseInt(inp.value);
      if (this._compRules[partId] && !isNaN(v)) {
        this._compRules[partId].pieces = Math.max(1, Math.min(20, v));
      }
    });
    popup.querySelectorAll('[data-pop-allow]').forEach(inp => {
      const partId = inp.dataset.popAllow;
      const v = parseFloat(inp.value);
      if (this._compRules[partId] && !isNaN(v)) {
        this._compRules[partId].allowance = Math.max(0, Math.min(1, v / 100));
      }
    });
    popup.remove();
    this._continueOpen();
  },

  _popupApplyAll(key, value) {
    if (!App.parts) return;
    for (const p of App.parts) {
      if (!this._compRules[p.id]) continue;
      this._compRules[p.id][key] = value;
    }
    document.getElementById('nm-rules-popup').remove();
    this._showPreOpenRulesPopup();
  },

  _continueOpen() {
    const modal = document.getElementById('norm-modal');
    if (!modal) return;
    modal.classList.add('active');
    if (!this.canvas) {
      this.canvas = document.getElementById('nm-canvas');
      this.ctx = this.canvas.getContext('2d');
      this._setupPan();
      this._setupRotToggles();
    }
    // Initialize default groups: one single-component group per loaded part
    // (preserves any user-added combined groups from previous opens)
    const existingPartIds = new Set();
    const newGroups = [];
    for (const g of this._groups) {
      if (g.type === 'combined') {
        // Keep combined groups only if all their part IDs still exist
        const allExist = g.partIds.every(pid => App.parts.find(p => p.id === pid));
        if (allExist) newGroups.push(g);
      } else if (g.type === 'single' && App.parts.find(p => p.id === g.partId)) {
        newGroups.push(g);
        existingPartIds.add(g.partId);
      }
    }
    // Add singles for any new parts
    for (const p of App.parts) {
      if (!existingPartIds.has(p.id)) {
        newGroups.push({ type: 'single', partId: p.id });
      }
    }
    this._groups = newGroups;
    this._selected.clear();
    this._rebuildComponents();
    this._renderSidebar();
    this._resizeCanvas();
    this.fitView();
    this.draw();
  },

  close() {
    const modal = document.getElementById('norm-modal');
    if (modal) modal.classList.remove('active');
  },

  setMirror(allow) {
    this.allowMirror = allow;
    document.getElementById('nm-mirror-yes').classList.toggle('active', allow);
    document.getElementById('nm-mirror-no').classList.toggle('active', !allow);
    this._rebuildComponents();
    this._renderSidebar();
    this.fitView();
    this.draw();
  },

  /* ══════════════════════════════════════════════════════════════════
     MANUAL ROTATE — spin all pieces in the active component view by
     the given angle (90 / 180 / 270 degrees, clockwise).

     The rotation is applied to each piece's already-positioned polygon,
     pivoting around the piece's own centroid so it stays approximately
     anchored to its current spot. This is a visual/manual override on
     top of whatever the auto-packer produced — useful when the user
     wants to fine-tune orientation for a specific layout preference.

     After rotation we recompute the parallelogram bounds and rerender.
     The change is local to the active component view; it doesn't
     re-run packing or affect rule definitions.
     ═════════════════════════════════════════════════════════════════ */
  manualRotateAll(degrees) {
    const c = this.components[this.activeIdx];
    if (!c || !c.pieces || c.pieces.length === 0) return;

    const rad = (degrees * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    // Rotate every piece around its own centroid
    for (const piece of c.pieces) {
      if (!piece.poly || piece.poly.length === 0) continue;
      // Centroid of this piece
      let cx = 0, cy = 0;
      for (const [x, y] of piece.poly) { cx += x; cy += y; }
      cx /= piece.poly.length;
      cy /= piece.poly.length;
      // Rotate each vertex around (cx, cy)
      piece.poly = piece.poly.map(([x, y]) => {
        const dx = x - cx, dy = y - cy;
        return [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA];
      });
      // Track cumulative rotation on the piece (informational)
      piece.rot = ((piece.rot || 0) + degrees) % 360;
    }

    // Recompute parallelogram bounds from rotated pieces, then normalize
    // all pieces back to positive coords (canvas expects this)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const piece of c.pieces) {
      for (const [x, y] of piece.poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    // Shift everything so bounding box starts at (0,0)
    for (const piece of c.pieces) {
      piece.poly = piece.poly.map(([x, y]) => [x - minX, y - minY]);
    }
    const newW = maxX - minX;
    const newH = maxY - minY;
    // Update parallelogram + para dimensions
    c.pgram = [[0, 0], [newW, 0], [newW, newH], [0, newH]];
    c.paraW = newW;
    c.paraH = newH;

    // Refresh sidebar stats (parallelogram size changed) and redraw canvas
    this._renderSidebar && this._renderSidebar();
    this.fitView && this.fitView();
    this.draw && this.draw();
  },

  /* ── New: unit + wastage handlers ─────────────────────────── */
  setUnit(u) {
    if (!this._UNIT_FACTORS[u]) return;
    this.unit = u;
    this._renderSidebar();
    this.draw();
  },

  setWastage(pct) {
    this.wastagePct = Math.max(0, Math.min(100, parseFloat(pct) || 0));
    // Apply globally to all components without per-comp override
    this._rebuildComponents();
    this._renderSidebar();
    this.draw();
  },

  applyGrade(grade) {
    const pct = this.GRADE_ALLOWANCES[grade];
    if (pct !== undefined) this.setWastage(pct);
  },


  setLabels(show) {
    this.showLabels = show;
    document.getElementById('nm-labels-on').classList.toggle('active', show);
    document.getElementById('nm-labels-off').classList.toggle('active', !show);
    this.draw();
  },

  _setupRotToggles() {
    document.querySelectorAll('#nm-rots .nm-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const rot = parseInt(btn.dataset.rot);
        if (this.rotations.has(rot)) {
          if (this.rotations.size > 1) {
            this.rotations.delete(rot);
            btn.classList.remove('active');
          }
        } else {
          this.rotations.add(rot);
          btn.classList.add('active');
        }
        this._rebuildComponents();
        this._renderSidebar();
        this.fitView();
        this.draw();
      });
    });
  },

  /* ══════════════════════════════════════════════════════════════════
     PER-PIECE EDIT MODE (rotate / flip / drag / delete)
     ─────────────────────────────────────────────────────────────────
     Mouse interaction modes inside Norm Calc canvas:
       • Click empty area     → start panning
       • Click a piece        → select it, show toolbar
       • Drag selected piece  → move it (recompute parallelogram on drop)
       • Click another piece  → switch selection
       • Click empty / Close  → deselect, hide toolbar
     ═════════════════════════════════════════════════════════════════ */

  // Convert canvas (screen) coords to world (mm) coords
  _canvasToWorld(cx, cy) {
    return { x: (cx - this.offsetX) / this.zoom, y: (cy - this.offsetY) / this.zoom };
  },

  // Hit-test: which piece is under (worldX, worldY)? Returns piece index or -1
  _hitPiece(wx, wy) {
    const c = this.components[this.activeIdx];
    if (!c || !c.pieces) return -1;
    // Reverse iterate so top-drawn pieces win for overlapping placements
    for (let i = c.pieces.length - 1; i >= 0; i--) {
      const p = c.pieces[i];
      if (this._pointInPoly(wx, wy, p.poly)) return i;
    }
    return -1;
  },

  _pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > y) !== (yj > y)) &&
                        (x < (xj - xi) * (y - yi) / (yj - yi || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  },

  _setupPan() {
    let panMode = false, dragMode = false, rotateMode = false;
    let lastX = 0, lastY = 0;
    let dragOffsetX = 0, dragOffsetY = 0;
    let rotateStartAngle = 0;     // initial angle from piece centroid → mouse
    let rotateInitialPoly = null; // snapshot of piece.poly at drag start
    let rotateInitialInner = null;
    this._selectedPieceIdx = -1;

    this.canvas.addEventListener('mousedown', e => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const w = this._canvasToWorld(cx, cy);

      // Hit-test rotate handle FIRST (only if a piece is currently selected)
      // Handle is a thin ring at radius _rotateHandle.r around the piece centroid.
      // Hit zone: ±25% of radius for forgiving grab area.
      if (this._selectedPieceIdx >= 0 && this._rotateHandle) {
        const rh = this._rotateHandle;
        const dx = w.x - rh.cx, dy = w.y - rh.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const tol = Math.max(rh.r * 0.25, 6);  // generous tolerance
        if (Math.abs(dist - rh.r) < tol) {
          // Begin rotate drag
          rotateMode = true;
          rotateStartAngle = Math.atan2(dy, dx);
          const piece = this.components[this.activeIdx].pieces[this._selectedPieceIdx];
          rotateInitialPoly = piece.poly.map(p => p.slice());
          rotateInitialInner = Array.isArray(piece.innerLines)
            ? piece.innerLines.map(line => ({ ...line, pts: (line.pts || []).map(p => p.slice()) }))
            : null;
          this.canvas.style.cursor = 'grabbing';
          return;
        }
      }

      const hit = this._hitPiece(w.x, w.y);
      console.log(`[NormCalc click] canvas(${cx.toFixed(0)},${cy.toFixed(0)}) → world(${w.x.toFixed(1)},${w.y.toFixed(1)}) → hit=${hit}, pieces=${this.components[this.activeIdx]?.pieces?.length || 0}`);
      if (hit >= 0) {
        // Select piece + start drag from current cursor
        this._selectedPieceIdx = hit;
        this._showPieceToolbar();
        // Compute drag offset from piece centroid so it moves smoothly
        const c = this.components[this.activeIdx];
        const piece = c.pieces[hit];
        let pcx = 0, pcy = 0;
        for (const [x, y] of piece.poly) { pcx += x; pcy += y; }
        pcx /= piece.poly.length;
        pcy /= piece.poly.length;
        dragOffsetX = w.x - pcx;
        dragOffsetY = w.y - pcy;
        dragMode = true;
        this.canvas.style.cursor = 'move';
        this.draw();
      } else {
        // Empty area → pan mode + deselect any current piece
        if (this._selectedPieceIdx !== -1) {
          this._selectedPieceIdx = -1;
          this._hidePieceToolbar();
          this.draw();
        }
        panMode = true;
        lastX = e.clientX;
        lastY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mouseup', () => {
      if (dragMode || rotateMode) {
        // Recompute parallelogram + areas after piece moved or rotated
        this._recomputeAfterEdit();
      }
      panMode = false;
      dragMode = false;
      rotateMode = false;
      rotateInitialPoly = null;
      rotateInitialInner = null;
      if (this.canvas) this.canvas.style.cursor = 'grab';
    });

    window.addEventListener('mousemove', e => {
      if (panMode) {
        this.offsetX += e.clientX - lastX;
        this.offsetY += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        this.draw();
      } else if (rotateMode && this._selectedPieceIdx >= 0 && rotateInitialPoly) {
        // Rotate drag: angle from centroid → mouse, delta from start angle
        const rect = this.canvas.getBoundingClientRect();
        const w = this._canvasToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const piece = this.components[this.activeIdx].pieces[this._selectedPieceIdx];
        // Use ORIGINAL poly's centroid as rotation pivot (stable reference)
        let pcx = 0, pcy = 0;
        for (const [x, y] of rotateInitialPoly) { pcx += x; pcy += y; }
        pcx /= rotateInitialPoly.length;
        pcy /= rotateInitialPoly.length;
        const ang = Math.atan2(w.y - pcy, w.x - pcx);
        const delta = ang - rotateStartAngle;
        const cs = Math.cos(delta), sn = Math.sin(delta);
        const rot = ([x, y]) => [
          pcx + (x - pcx) * cs - (y - pcy) * sn,
          pcy + (x - pcx) * sn + (y - pcy) * cs,
        ];
        // Always rotate from the SNAPSHOT (avoids cumulative rounding error)
        piece.poly = rotateInitialPoly.map(rot);
        if (rotateInitialInner) {
          piece.innerLines = rotateInitialInner.map(line => ({
            ...line,
            pts: (line.pts || []).map(rot),
          }));
        }
        // Track cumulative rotation (informational)
        piece._rotInProgress = (delta * 180 / Math.PI);
        this.draw();
      } else if (dragMode && this._selectedPieceIdx >= 0) {
        const rect = this.canvas.getBoundingClientRect();
        const w = this._canvasToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const c = this.components[this.activeIdx];
        const piece = c.pieces[this._selectedPieceIdx];
        // Compute current centroid + delta to new target centroid
        let pcx = 0, pcy = 0;
        for (const [x, y] of piece.poly) { pcx += x; pcy += y; }
        pcx /= piece.poly.length;
        pcy /= piece.poly.length;
        const newCx = w.x - dragOffsetX;
        const newCy = w.y - dragOffsetY;
        const dx = newCx - pcx;
        const dy = newCy - pcy;
        // Translate piece poly + inner lines (if any)
        piece.poly = piece.poly.map(p => [p[0] + dx, p[1] + dy]);
        if (Array.isArray(piece.innerLines)) {
          piece.innerLines = piece.innerLines.map(line => ({
            ...line,
            pts: (line.pts || []).map(p => [p[0] + dx, p[1] + dy]),
          }));
        }
        this.draw();
      } else {
        // Idle hover — change cursor based on what's under mouse:
        //   over rotate handle → 'grab' (wants to rotate)
        //   over a piece       → 'pointer' (clickable)
        //   empty area         → 'grab' (panning)
        const rect = this.canvas.getBoundingClientRect();
        const cxr = e.clientX - rect.left;
        const cyr = e.clientY - rect.top;
        if (cxr >= 0 && cyr >= 0 && cxr <= rect.width && cyr <= rect.height) {
          const w = this._canvasToWorld(cxr, cyr);
          // Check rotate handle first (only when a piece is selected)
          if (this._selectedPieceIdx >= 0 && this._rotateHandle) {
            const rh = this._rotateHandle;
            const dx = w.x - rh.cx, dy = w.y - rh.cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const tol = Math.max(rh.r * 0.25, 6);
            if (Math.abs(dist - rh.r) < tol) {
              this.canvas.style.cursor = 'grab';
              return;
            }
          }
          const hit = this._hitPiece(w.x, w.y);
          this.canvas.style.cursor = (hit >= 0) ? 'pointer' : 'grab';
        }
      }
    });

    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      this.offsetX = mx - factor * (mx - this.offsetX);
      this.offsetY = my - factor * (my - this.offsetY);
      this.zoom *= factor;
      document.getElementById('nm-zoom-val').textContent = Math.round(this.zoom * 100) + '%';
      this.draw();
    }, { passive: false });
  },

  _showPieceToolbar() {
    const tb = document.getElementById('nm-piece-toolbar');
    if (tb) tb.style.display = 'block';
    const lbl = document.getElementById('nm-piece-tb-label');
    const c = this.components[this.activeIdx];
    if (lbl && c && c.pieces && this._selectedPieceIdx >= 0) {
      const piece = c.pieces[this._selectedPieceIdx];
      const name = (typeof App !== 'undefined' && App.getDisplayName)
        ? App.getDisplayName(piece.partName || '')
        : (piece.partName || '');
      lbl.textContent = `Piece ${this._selectedPieceIdx + 1}: ${name}`;
    }
  },

  _hidePieceToolbar() {
    const tb = document.getElementById('nm-piece-toolbar');
    if (tb) tb.style.display = 'none';
  },

  deselectPiece() {
    this._selectedPieceIdx = -1;
    this._hidePieceToolbar();
    this.draw();
  },

  /* Rotate the selected piece by `deg` degrees around its centroid */
  rotateSelected(deg) {
    if (this._selectedPieceIdx < 0) return;
    const c = this.components[this.activeIdx];
    if (!c || !c.pieces) return;
    const piece = c.pieces[this._selectedPieceIdx];
    if (!piece || !piece.poly || piece.poly.length < 3) return;
    // Centroid (average of vertices)
    let cx = 0, cy = 0;
    for (const [x, y] of piece.poly) { cx += x; cy += y; }
    cx /= piece.poly.length;
    cy /= piece.poly.length;
    const rad = deg * Math.PI / 180;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    const rot = (p) => [
      cx + (p[0] - cx) * cs - (p[1] - cy) * sn,
      cy + (p[0] - cx) * sn + (p[1] - cy) * cs,
    ];
    piece.poly = piece.poly.map(rot);
    if (Array.isArray(piece.innerLines)) {
      piece.innerLines = piece.innerLines.map(line => ({
        ...line,
        pts: (line.pts || []).map(rot),
      }));
    }
    piece.rot = ((piece.rot || 0) + deg) % 360;
    this._recomputeAfterEdit();
  },

  /* Flip the selected piece around its centroid */
  flipSelected(axis) {
    if (this._selectedPieceIdx < 0) return;
    const c = this.components[this.activeIdx];
    if (!c || !c.pieces) return;
    const piece = c.pieces[this._selectedPieceIdx];
    if (!piece || !piece.poly || piece.poly.length < 3) return;
    let cx = 0, cy = 0;
    for (const [x, y] of piece.poly) { cx += x; cy += y; }
    cx /= piece.poly.length;
    cy /= piece.poly.length;
    const flipPt = (p) => (axis === 'h')
      ? [2 * cx - p[0], p[1]]
      : [p[0], 2 * cy - p[1]];
    piece.poly = piece.poly.map(flipPt);
    if (Array.isArray(piece.innerLines)) {
      piece.innerLines = piece.innerLines.map(line => ({
        ...line,
        pts: (line.pts || []).map(flipPt),
      }));
    }
    this._recomputeAfterEdit();
  },

  /* Delete the selected piece */
  deleteSelected() {
    if (this._selectedPieceIdx < 0) return;
    const c = this.components[this.activeIdx];
    if (!c || !c.pieces) return;
    if (c.pieces.length <= 1) {
      // Last piece — leave it alone, just deselect
      this.deselectPiece();
      return;
    }
    c.pieces.splice(this._selectedPieceIdx, 1);
    this._selectedPieceIdx = -1;
    this._hidePieceToolbar();
    this._recomputeAfterEdit();
  },

  /* After any edit (move/rotate/flip/delete), recompute parallelogram bbox,
     gross/net areas, and refresh the breakdown panel + sidebar. Manual edits
     mark the component as user-modified so future auto-rebuilds preserve it. */
  _recomputeAfterEdit() {
    const c = this.components[this.activeIdx];
    if (!c || !c.pieces) return;
    // Recompute parallelogram bbox from all piece polys
    const allPts = c.pieces.flatMap(p => p.poly);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of allPts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const w = maxX - minX, h = maxY - minY;
    c.gross = w * h;
    c.paraW = w;
    c.paraH = h;
    c.pgram = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
    c.displayBBox = { minX, minY, maxX, maxY, w, h };
    // Mark user-edited so subsequent rebuilds (e.g. unit change) don't undo
    c._userEdited = true;
    // Refresh sidebar (areas / efficiency text) and redraw canvas
    this._renderSidebar && this._renderSidebar();
    this.draw();
  },

  zoomIn() { this.zoom *= 1.25; document.getElementById('nm-zoom-val').textContent = Math.round(this.zoom * 100) + '%'; this.draw(); },
  zoomOut() { this.zoom *= 0.8; document.getElementById('nm-zoom-val').textContent = Math.round(this.zoom * 100) + '%'; this.draw(); },

  _resizeCanvas() {
    const cv = this.canvas;
    const wrap = cv.parentElement;
    cv.width = wrap.clientWidth;
    cv.height = wrap.clientHeight;
  },

  fitView() {
    if (!this.canvas) return;
    this._resizeCanvas();
    const c = this.components[this.activeIdx];
    if (!c) return;
    const bb = c.displayBBox;
    const padding = 60;
    const sx = (this.canvas.width - padding * 2) / bb.w;
    const sy = (this.canvas.height - padding * 2) / bb.h;
    this.zoom = Math.min(sx, sy, 20);
    this.offsetX = (this.canvas.width - bb.w * this.zoom) / 2 - bb.minX * this.zoom;
    this.offsetY = (this.canvas.height - bb.h * this.zoom) / 2 - bb.minY * this.zoom;
    document.getElementById('nm-zoom-val').textContent = Math.round(this.zoom * 100) + '%';
  },

  /* Get effective rules for a part (per-comp override or global default). */
  _rulesFor(partId) {
    const r = this._compRules[partId] || {};
    return {
      pieces: r.pieces !== undefined ? r.pieces : this.piecesCount,
      rotations: r.rotations || this.rotations,
      mirror: r.mirror !== undefined ? r.mirror : this.allowMirror,
      allowance: r.allowance !== undefined ? r.allowance : (this.wastagePct / 100),
    };
  },

  /* Build the analyses array from the `_groups` definitions.
     Each group becomes one entry in `this.components`. */
  _rebuildComponents() {
    this.components = [];
    if (!App.parts || App.parts.length === 0) return;
    if (!this._groups || this._groups.length === 0) return;

    // ── Auto-flip enforcement before computing analyses ──
    // Match part flip state to its rule's mirror setting. If rule says
    // 'must' → part should be X-flipped. Otherwise → original orientation.
    // Same idempotent pattern as _runNestingProceed in App. Runs every
    // time we rebuild so polygon stays in sync with rules.
    if (typeof App !== 'undefined' && App.flipPart) {
      for (const partId in this._compRules) {
        const part = App.parts.find(p => p.id === partId);
        if (!part) continue;
        const rule = this._compRules[partId];
        if (!rule) continue;
        const wantH = (rule.mirror === 'must');
        const haveH = !!part._flipH;
        if (wantH !== haveH) App.flipPart(partId, 'h');
      }
    }

    let combinedSeq = 1;
    for (const g of this._groups) {
      if (g.type === 'single') {
        const part = App.parts.find(p => p.id === g.partId);
        if (!part) continue;
        const rules = this._rulesFor(part.id);

        // ── Mirror=Must: alternate original / flipped pieces ──
        // Same approach as nesting engine. When user picks "Must" mirror,
        // each piece in the parallelogram alternates chirality:
        //   piece 0 = original
        //   piece 1 = X-flipped (mirror of piece 0)
        //   piece 2 = original
        //   piece 3 = X-flipped
        //   ...
        // For non-must modes, all pieces use the same source polygon.
        const piecesSpec = [];
        if (rules.mirror === 'must' && rules.pieces >= 2) {
          // Build flipped variant once
          const flippedPts = part.pts.map(p => [-p[0], p[1]]);
          let minX = Infinity, minY = Infinity;
          for (const [x, y] of flippedPts) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
          }
          const flippedNorm = flippedPts.map(p => [p[0] - minX, p[1] - minY]);
          const flippedPart = { ...part, pts: flippedNorm };
          // Alternate: even idx → original, odd idx → flipped
          for (let i = 0; i < rules.pieces; i++) {
            const variant = (i % 2 === 0) ? part : flippedPart;
            piecesSpec.push({ part: variant, idx: i });
          }
        } else {
          for (let i = 0; i < rules.pieces; i++) {
            piecesSpec.push({ part, idx: i });
          }
        }
        // Pass mirror as 'none' downstream when must — chirality is already
        // baked into the alternating piecesSpec, engine should NOT apply
        // any further mirror transform (which could un-flip the flipped piece)
        const workingRules = (rules.mirror === 'must' && rules.pieces >= 2)
          ? { ...rules, mirror: 'none' }
          : rules;
        const analysis = this._analyzeMulti(piecesSpec, false, workingRules);
        analysis.id = part.id;
        analysis.name = part.name || 'Component';
        analysis.groupRef = g;
        analysis.allowance = rules.allowance;
        this.components.push(analysis);
      } else if (g.type === 'combined') {
        // Combined: each partId contributes its `pieces` count from compRules.
        // For 'must' parts, the polygon was already flipped via App.flipPart
        // when the user clicked Must in the rules popup. No further flip needed.
        const piecesSpec = [];
        const partsInGroup = [];
        let combinedRots = new Set();
        let combinedAllowance = 0;
        let totalPieces = 0;
        const pieceMirrorModes = [];
        for (const pid of g.partIds) {
          const part = App.parts.find(p => p.id === pid);
          if (!part) continue;
          const r = this._rulesFor(pid);

          // For must parts, build flipped variant and alternate per piece.
          // For non-must parts, all pieces use original.
          let flippedPart = null;
          if (r.mirror === 'must' && r.pieces >= 2) {
            const fpts = part.pts.map(p => [-p[0], p[1]]);
            let minX = Infinity, minY = Infinity;
            for (const [x, y] of fpts) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
            }
            flippedPart = { ...part, pts: fpts.map(p => [p[0] - minX, p[1] - minY]) };
          }

          // Mode for piece-mirror-map. Mirror baked into pieces above for
          // must, so downstream gets 'none' (engine doesn't re-mirror /
          // un-flip the pre-flipped polygons).
          let pmir;
          if (r.mirror === 'must') pmir = 'none';
          else if (r.mirror === 'none' || r.mirror === false) pmir = 'none';
          else pmir = 'optional';

          for (let i = 0; i < r.pieces; i++) {
            const variant = (flippedPart && i % 2 === 1) ? flippedPart : part;
            piecesSpec.push({ part: variant, idx: i });
            pieceMirrorModes.push(pmir);
          }
          partsInGroup.push(part.name || pid);
          for (const rot of r.rotations) combinedRots.add(rot);
          combinedAllowance += r.allowance * r.pieces;
          totalPieces += r.pieces;
        }
        if (piecesSpec.length === 0) continue;
        const combRules = {
          pieces: piecesSpec.length,
          rotations: combinedRots,
          mirror: 'optional',
          allowance: totalPieces > 0 ? combinedAllowance / totalPieces : 0,
          pieceMirrorModes,
        };
        const analysis = this._analyzeMulti(piecesSpec, true, combRules);
        analysis.id = g.id;
        analysis.name = g.name || `Combined Set ${combinedSeq++}`;
        analysis.groupRef = g;
        analysis.allowance = combRules.allowance;
        this.components.push(analysis);
      }
    }
    if (this.activeIdx >= this.components.length) this.activeIdx = 0;
  },

  /* Generic N-piece nesting analysis. piecesSpec = [{part, idx}, ...].
     For each piece we try all allowed rotations × mirrors and pack greedily,
     placing each next piece tightly against the existing layout to minimize
     bounding parallelogram area. */
  _analyzeMulti(piecesSpec, isCombined, ruleOverride = null) {
    // Use override rules if provided (per-component), else fall back to global
    const rots = Array.from(
      ruleOverride ? ruleOverride.rotations : this.rotations
    ).sort((a,b)=>a-b);

    // Mirror mode resolution. Schema:
    //   'none'     → original only,  mirror variants = [false]
    //   'optional' → try both,        mirror variants = [false, true]
    //   'must'     → mirror only,     mirror variants = [true]
    // Legacy: boolean true/undefined → 'optional', false → 'none'.
    //
    // For combined sets (multiple component types), ruleOverride may also
    // include `pieceMirrorModes` — array parallel to `ordered` after sort,
    // but since we sort by area below, we re-key by partId after sort.
    const modeToVariants = (mode) =>
      (mode === 'must')     ? [true]
      : (mode === 'none')   ? [false]
      :                       [false, true];
    const normalizeMode = (m) => {
      if (m === 'must') return 'must';
      if (m === 'none' || m === false) return 'none';
      return 'optional';
    };
    let groupMirMode;
    if (ruleOverride && ruleOverride.mirror !== undefined) {
      groupMirMode = normalizeMode(ruleOverride.mirror);
    } else {
      groupMirMode = this.allowMirror ? 'optional' : 'none';
    }
    const groupMirrors = modeToVariants(groupMirMode);

    // Build per-spec mirror maps. For combined sets, use pieceMirrorModes
    // array (one mode per piece by index). For single-component sets, use
    // the group-level mirror mode applied uniformly to ALL parts in piecesSpec.
    // This ensures single-component 'must' mode tries BOTH X and Y axes,
    // not just boolean-true (which was being treated as X-only).
    const pieceMirrorMap = new Map();  // partId → mode string
    if (ruleOverride && Array.isArray(ruleOverride.pieceMirrorModes)) {
      // Combined-set path: per-piece modes from array
      for (let i = 0; i < piecesSpec.length; i++) {
        const partId = piecesSpec[i].part.id;
        const mode = normalizeMode(ruleOverride.pieceMirrorModes[i]);
        const existing = pieceMirrorMap.get(partId);
        // Most-restrictive wins if same partId has different modes
        if (!existing || mode === 'must' || (existing !== 'must' && mode === 'none')) {
          pieceMirrorMap.set(partId, mode);
        }
      }
    } else {
      // Single-component path: apply groupMirMode to every distinct partId.
      // This is what makes single-component 'must' actually try X+Y axes via
      // mirrorsForPiece() inside _packGreedy.
      for (const sp of piecesSpec) {
        pieceMirrorMap.set(sp.part.id, groupMirMode);
      }
    }
    // Default group-level fallback if not in combined mode
    const mirrors = groupMirrors;

    // Pre-compute net area per piece type and total net
    let totalNet = 0;
    for (const sp of piecesSpec) totalNet += Math.abs(polyArea(sp.part.pts));

    // Sort pieces largest-first for better packing (skyline strategy)
    const ordered = piecesSpec.slice().sort((a, b) =>
      Math.abs(polyArea(b.part.pts)) - Math.abs(polyArea(a.part.pts))
    );

    // Try a few seed orientations for the first piece, pick best final layout.
    // Seed mirror options must match what the packer will allow per piece —
    // this means BOTH 'x' and 'y' axis flips for the first piece if its mode
    // is 'must' or 'optional'. Otherwise the first piece could be locked into
    // a non-mirrored orientation that isn't even allowed.
    let bestLayout = null;
    const firstPart = ordered[0].part;
    const firstMirMode = pieceMirrorMap.get(firstPart.id);
    // Seed mirror options for first piece. For 'must' mode, ALWAYS use Y-flip
    // so the layout is guaranteed mirrored. Rotations still try all 4 angles
    // for material-saving packing.
    let firstMirrors;
    if (firstMirMode === 'must')          firstMirrors = ['y'];        // Y-flip locked, rotations free
    else if (firstMirMode === 'optional') firstMirrors = [false, 'x', 'y'];
    else if (firstMirMode === 'none')     firstMirrors = [false];
    else                                  firstMirrors = groupMirrors;

    for (const rot0 of rots) {
      for (const mir0 of firstMirrors) {
        const layout = this._packGreedy(ordered, rot0, mir0, rots, groupMirrors, pieceMirrorMap, modeToVariants);
        if (!layout) continue;
        // Use score (bbox + balance penalty) for ranking layouts, same as
        // packGreedy uses internally for piece placement decisions.
        if (!bestLayout || layout.score < bestLayout.score) bestLayout = layout;
      }
    }

    if (!bestLayout) {
      // Trivial fallback: stack horizontally
      const placedPieces = [];
      let xCursor = 0;
      for (const sp of ordered) {
        const bb = polyBBox(sp.part.pts);
        const norm = sp.part.pts.map(p => [p[0] - bb.x + xCursor, p[1] - bb.y]);
        placedPieces.push({ poly: norm, rot: 0, mir: false, partId: sp.part.id, partName: sp.part.name });
        xCursor += bb.w + this.gapMm;
      }
      const all = placedPieces.flatMap(p => p.poly);
      const bb = this._bbox(all);
      const fallbackGross = bb.w * bb.h;
      bestLayout = { pieces: placedPieces, gross: fallbackGross, score: fallbackGross,
        pgram: [[bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.maxX, bb.maxY], [bb.minX, bb.maxY]],
        paraW: bb.w, paraH: bb.h };
    }

    // Re-center for display with margin=20mm top/left
    const allPts = bestLayout.pieces.flatMap(p => p.poly);
    const bb = this._bbox(allPts);
    // Display offset: reserve space ABOVE for title (25mm) and BELOW for
    // dimension line + report breakdown (~100mm). Right side gets 40mm
    // for the vertical dimension line.
    const TOP_PAD = 25;      // title row
    const BOTTOM_PAD = 100;  // dimension line + report breakdown
    const RIGHT_PAD = 40;    // vertical dimension line
    const ox = -bb.minX + 20, oy = -bb.minY + TOP_PAD;
    const pieces = bestLayout.pieces.map(p => ({
      ...p, poly: p.poly.map(pt => [pt[0] + ox, pt[1] + oy])
    }));
    const pgram = bestLayout.pgram.map(pt => [pt[0] + ox, pt[1] + oy]);
    const displayBBox = { minX: 0, minY: 0, w: bb.w + 20 + RIGHT_PAD, h: bb.h + TOP_PAD + BOTTOM_PAD };

    const N = piecesSpec.length;
    const grossTotal = bestLayout.gross;
    const grossPerPiece = grossTotal / N;
    const netPerPiece = totalNet / N;
    const efficiency = grossPerPiece > 0 ? (netPerPiece / grossPerPiece * 100) : 0;
    const interlockWaste = grossPerPiece - netPerPiece;

    return {
      pieces,                  // [{poly, rot, mir, partId, partName}]
      pgram,
      displayBBox,
      isCombined,
      pieceCount: N,
      net: netPerPiece,        // per piece (avg in combined mode)
      grossPerPiece, grossTotal,
      efficiency, interlockWaste,
      paraW: bestLayout.paraW, paraH: bestLayout.paraH,
      totalNet,                // sum of all pieces' areas
    };
  },

  /* Greedy bottom-left packer for N pieces. Places pieces one at a time;
     for each placement tries every allowed rotation/mirror and every BL
     position relative to the existing layout, picking the position that
     minimizes bbox area growth.

     Mirror modes:
       'none'     → original orientation only, full rotation freedom
       'optional' → tries with and without mirror, full rotation freedom
       'must'     → mirror applied to every piece, full rotation freedom
                    (each piece is mirrored, but rotation can vary so
                    pieces can interlock for tight packing) */
  _packGreedy(orderedSpec, rot0, mir0, allRots, allMirrors, pieceMirrorMap, modeToVariants) {
    const placed = [];
    const gap = this.gapMm;

    // For each piece, get its allowed (rot, mir) combinations.
    // 'must' mode = every piece must be mirrored, but each can pick any
    //   rotation × mirror-axis combo for best packing fit.
    // 'none' mode = no mirror, all rotations.
    // 'optional' mode = full freedom (mirror or not, all axes, all rotations).
    // For each piece, get its allowed transforms.
    //
    // 'must' mode (TWO-STEP approach):
    //   STEP 1: Apply Y-flip (heel↔toe) to source polygon as a FIXED step
    //   STEP 2: Try all rotations on the already-flipped shape
    //   Result: every placed piece is guaranteed mirrored vs the original
    //   DXF, AND packer has rotation freedom for tight interlocking.
    //   No combination of rotation can "cancel" the flip — Y-flip + any
    //   rotation is still a valid mirror of the original.
    //
    //   Returns transforms with `preMirror: 'y'` flag — the placement code
    //   applies _transform(pts, rot, 'y') so flipY is baked in before rot.
    //
    // 'none' mode: original only, full rotation.
    // 'optional' / fallback: full freedom (mirror or not, all axes, all rotations).
    const transformsForPiece = (sp) => {
      const mode = pieceMirrorMap && pieceMirrorMap.get(sp.part.id);
      if (mode === 'must') {
        // Y-flip baked in; rotations vary for packing fit
        return allRots.map(r => ({ rot: r, mir: 'y' }));
      }
      if (mode === 'none') {
        // Try fine rotations (every 30°) to find tight interlocks like
        // toe-to-toe for shoe vamps. Pure 90° steps miss many good fits.
        const fineRots = [];
        for (let a = 0; a < 360; a += 30) fineRots.push(a);
        return fineRots.map(r => ({ rot: r, mir: false }));
      }
      // 'optional' / undefined / legacy: full freedom
      const mirs = (mode === 'optional') ? [false, 'x', 'y'] : allMirrors;
      const out = [];
      for (const r of allRots) for (const m of mirs) out.push({ rot: r, mir: m });
      return out;
    };

    // Place first piece at origin with given rot0/mir0.
    // For 'must' mode the seed already picked mir0='y' (or 'x' for legacy
    // groupMirrors). Either way, _transform applies mirror BEFORE rotation,
    // which is exactly the two-step "flip first, then rotate" semantic.
    const first0 = this._transform(orderedSpec[0].part.pts, rot0, mir0);
    placed.push({
      poly: first0, rot: rot0, mir: mir0,
      partId: orderedSpec[0].part.id, partName: orderedSpec[0].part.name
    });

    // Place each subsequent piece
    //
    // Scoring: primary metric is bounding-box area (gross). For tied
    // areas (within ~0.5%), prefer layouts where width and height are more
    // balanced — i.e. closer to square. For 'sidebyside' / 'stacked' user
    // preference, apply a STRONG penalty to the unwanted orientation so it
    // forces the layout regardless of small area gains.
    //
    // layoutPref values:
    //   'auto' (default) — gentle ratio penalty, lets packer find tightest
    //   'sidebyside'    — heavy penalty if h > w (forces wider-than-tall)
    //   'stacked'       — heavy penalty if w > h (forces taller-than-wide)
    const layoutPref = this.layoutPref || 'auto';
    const computeScore = (bbW, bbH) => {
      const gross = bbW * bbH;
      if (layoutPref === 'sidebyside') {
        // Strong penalty if layout is taller than wide
        if (bbH > bbW) return gross * 2;  // 100% penalty — almost always loses
        const ratio = bbW / Math.max(1, bbH);
        return gross + (ratio - 1) * gross * 0.001;  // tiny tiebreak
      }
      if (layoutPref === 'stacked') {
        if (bbW > bbH) return gross * 2;
        const ratio = bbH / Math.max(1, bbW);
        return gross + (ratio - 1) * gross * 0.001;
      }
      // 'auto' — mild balanced preference, mostly bbox area decides
      const ratio = Math.max(bbW, bbH) / Math.max(1, Math.min(bbW, bbH));
      return gross + (ratio - 1) * gross * 0.003;
    };

    for (let i = 1; i < orderedSpec.length; i++) {
      const sp = orderedSpec[i];
      let bestPlace = null;
      // Iterate this piece's allowed transforms. For 'must' mode this is
      // a single locked combination matching the seed; for 'optional' / 'none'
      // it's the full allowed grid.
      const transforms = transformsForPiece(sp);
      for (const t of transforms) {
        const rot = t.rot;
        const mir = t.mir;
        const pieceShape = this._transform(sp.part.pts, rot, mir);
        const bb = this._bbox(pieceShape);
        // Try placement positions: align along right edge and bottom edge of placed group
        const placedAll = placed.flatMap(p => p.poly);
        const allBB = this._bbox(placedAll);
        // Side-by-side: try fine vertical offsets to find tight interlocks.
        // Wider range (-0.6..0.6) with finer step (0.025) gives 49 candidates
        // — twice the previous resolution to catch tight side-by-side fits
        // where pieces nest closely without big gaps.
        for (let vFrac = -0.6; vFrac <= 0.6; vFrac += 0.025) {
          const voff = allBB.minY + vFrac * allBB.h;
          const xOff = this._minXOffsetMulti(placed, pieceShape, voff, gap);
          if (xOff === null) continue;
          const trial = pieceShape.map(p => [p[0] + xOff, p[1] + voff]);
          const newAll = placedAll.concat(trial);
          const nbb = this._bbox(newAll);
          const score = computeScore(nbb.w, nbb.h);
          if (!bestPlace || score < bestPlace.score) {
            bestPlace = { poly: trial, rot, mir, gross: nbb.w * nbb.h, score };
          }
        }
        // Stacked: same wider range and finer step
        for (let hFrac = -0.6; hFrac <= 0.6; hFrac += 0.025) {
          const hoff = allBB.minX + hFrac * allBB.w;
          const yOff = this._minYOffsetMulti(placed, pieceShape, hoff, gap);
          if (yOff === null) continue;
          const trial = pieceShape.map(p => [p[0] + hoff, p[1] + yOff]);
          const newAll = placedAll.concat(trial);
          const nbb = this._bbox(newAll);
          const score = computeScore(nbb.w, nbb.h);
          if (!bestPlace || score < bestPlace.score) {
            bestPlace = { poly: trial, rot, mir, gross: nbb.w * nbb.h, score };
          }
        }
        // ── Edge-aligned baseline placements ──
        // Explicitly try clean baseline-aligned positions: piece 2 placed
        // at the same Y (or X) coordinate as piece 1. These often produce
        // the simplest tight side-by-side / stacked layouts that the
        // fractional sweep can miss because of bbox-relative quantization.
        const pBB = this._bbox(pieceShape);
        const baselineCandidates = [
          { dy: 0, mode: 'side' },                  // piece 2 top aligns with placed top
          { dy: allBB.h - pBB.h, mode: 'side' },    // piece 2 bottom aligns with placed bottom
          { dy: (allBB.h - pBB.h) / 2, mode: 'side' }, // vertically centered
          { dx: 0, mode: 'stack' },                 // piece 2 left aligns with placed left
          { dx: allBB.w - pBB.w, mode: 'stack' },   // piece 2 right aligns with placed right
          { dx: (allBB.w - pBB.w) / 2, mode: 'stack' }, // horizontally centered
        ];
        for (const cand of baselineCandidates) {
          if (cand.mode === 'side') {
            const voff = allBB.minY + cand.dy;
            const xOff = this._minXOffsetMulti(placed, pieceShape, voff, gap);
            if (xOff === null) continue;
            const trial = pieceShape.map(p => [p[0] + xOff, p[1] + voff]);
            const nbb = this._bbox(placedAll.concat(trial));
            const score = computeScore(nbb.w, nbb.h);
            if (!bestPlace || score < bestPlace.score) {
              bestPlace = { poly: trial, rot, mir, gross: nbb.w * nbb.h, score };
            }
          } else {
            const hoff = allBB.minX + cand.dx;
            const yOff = this._minYOffsetMulti(placed, pieceShape, hoff, gap);
            if (yOff === null) continue;
            const trial = pieceShape.map(p => [p[0] + hoff, p[1] + yOff]);
            const nbb = this._bbox(placedAll.concat(trial));
            const score = computeScore(nbb.w, nbb.h);
            if (!bestPlace || score < bestPlace.score) {
              bestPlace = { poly: trial, rot, mir, gross: nbb.w * nbb.h, score };
            }
          }
        }
      }
      if (!bestPlace) return null;
      placed.push({
        poly: bestPlace.poly, rot: bestPlace.rot, mir: bestPlace.mir,
        partId: sp.part.id, partName: sp.part.name
      });
    }

    const allPts = placed.flatMap(p => p.poly);
    const bb = this._bbox(allPts);
    const finalGross = bb.w * bb.h;
    // Use the same computeScore helper that drove placement decisions, so
    // the seed loop's "pick best" comparison honors layout preference too.
    const finalScore = computeScore(bb.w, bb.h);
    return {
      pieces: placed,
      gross: finalGross,
      score: finalScore,
      pgram: [[bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.maxX, bb.maxY], [bb.minX, bb.maxY]],
      paraW: bb.w, paraH: bb.h
    };
  },

  /* Find minimum X push to place piece B (already at voff vertical offset)
     to the right of all placed pieces without overlap. Considers gap. */
  _minXOffsetMulti(placedArr, bPts, voff, gap) {
    const b = bPts.map(p => [p[0], p[1] + voff]);
    const bBB = this._bbox(b);
    // Sample horizontal scanlines covering B's vertical extent
    let maxPush = -Infinity;
    let foundOverlap = false;
    for (const placed of placedArr) {
      const aBB = this._bbox(placed.poly);
      const yMin = Math.max(aBB.minY, bBB.minY);
      const yMax = Math.min(aBB.maxY, bBB.maxY);
      if (yMax <= yMin) {
        // No vertical overlap with this placed piece
        const candidate = aBB.maxX - bBB.minX + gap;
        if (candidate > maxPush) maxPush = candidate;
        continue;
      }
      foundOverlap = true;
      for (let y = yMin; y <= yMax; y += 1) {
        const aSpans = this._xSpansAt(placed.poly, y);
        const bSpans = this._xSpansAt(b, y);
        for (const [, ax2] of aSpans) {
          for (const [bx1] of bSpans) {
            const push = ax2 - bx1 + gap;
            if (push > maxPush) maxPush = push;
          }
        }
      }
    }
    if (maxPush === -Infinity) {
      // Place at the right edge of all placed
      let rightmost = -Infinity;
      for (const p of placedArr) {
        const bb = this._bbox(p.poly);
        if (bb.maxX > rightmost) rightmost = bb.maxX;
      }
      return rightmost - bBB.minX + gap;
    }
    return maxPush;
  },

  _minYOffsetMulti(placedArr, bPts, hoff, gap) {
    const b = bPts.map(p => [p[0] + hoff, p[1]]);
    const bBB = this._bbox(b);
    let maxPush = -Infinity;
    for (const placed of placedArr) {
      const aBB = this._bbox(placed.poly);
      const xMin = Math.max(aBB.minX, bBB.minX);
      const xMax = Math.min(aBB.maxX, bBB.maxX);
      if (xMax <= xMin) {
        const candidate = aBB.maxY - bBB.minY + gap;
        if (candidate > maxPush) maxPush = candidate;
        continue;
      }
      for (let x = xMin; x <= xMax; x += 1) {
        const aSpans = this._ySpansAt(placed.poly, x);
        const bSpans = this._ySpansAt(b, x);
        for (const [, ay2] of aSpans) {
          for (const [by1] of bSpans) {
            const push = ay2 - by1 + gap;
            if (push > maxPush) maxPush = push;
          }
        }
      }
    }
    if (maxPush === -Infinity) {
      let bottommost = -Infinity;
      for (const p of placedArr) {
        const bb = this._bbox(p.poly);
        if (bb.maxY > bottommost) bottommost = bb.maxY;
      }
      return bottommost - bBB.minY + gap;
    }
    return maxPush;
  },

  _transform(pts, rot, mirror) {
    // mirror values:
    //   false (or undefined) → no mirror
    //   true or 'x'         → flip X (left↔right): x → -x
    //   'y'                 → flip Y (top↔bottom, i.e. heel↔toe): y → -y
    let r = pts;
    if (mirror === 'x' || mirror === true) {
      r = r.map(p => [-p[0], p[1]]);
    } else if (mirror === 'y') {
      r = r.map(p => [p[0], -p[1]]);
    }
    if (rot) {
      const rad = rot * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      r = r.map(p => [p[0]*c - p[1]*s, p[0]*s + p[1]*c]);
    }
    // Normalize to positive coords
    const bb = this._bbox(r);
    return r.map(p => [p[0] - bb.minX, p[1] - bb.minY]);
  },

  _bbox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  },

  /* Get [x1, x2] spans of polygon's interior at scanline y. */
  _xSpansAt(poly, y) {
    const xs = [];
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = poly[i][1], yj = poly[j][1];
      if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
        const t = (y - yi) / (yj - yi);
        xs.push(poly[i][0] + t * (poly[j][0] - poly[i][0]));
      }
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i+1]]);
    return spans;
  },

  _ySpansAt(poly, x) {
    const ys = [];
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i][0], xj = poly[j][0];
      if ((xi <= x && xj > x) || (xj <= x && xi > x)) {
        const t = (x - xi) / (xj - xi);
        ys.push(poly[i][1] + t * (poly[j][1] - poly[i][1]));
      }
    }
    ys.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < ys.length; i += 2) spans.push([ys[i], ys[i+1]]);
    return spans;
  },

  /* Fraction of a 1cm grid box (at gxmm, gymm origin) covered by the poly. */
  _boxCoverage(poly, gxmm, gymm) {
    // Clip poly to 10mm × 10mm box starting at (gxmm, gymm)
    // Simple approach: sample 10×10 sub-grid and count "inside" samples.
    let count = 0;
    const nSamples = 6;
    for (let i = 0; i < nSamples; i++) {
      for (let j = 0; j < nSamples; j++) {
        const sx = gxmm + (i + 0.5) * 10 / nSamples;
        const sy = gymm + (j + 0.5) * 10 / nSamples;
        if (this._pip(poly, sx, sy)) count++;
      }
    }
    return count / (nSamples * nSamples);
  },

  _pip(poly, px, py) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if ((yi > py) !== (yj > py)) {
        const xI = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
        if (px < xI) inside = !inside;
      }
    }
    return inside;
  },

  _renderSidebar() {
    const list = document.getElementById('nm-comp-list');
    if (!list) return;
    list.innerHTML = '';

    // ── Slim live-controls panel (full settings live in pre-open popup) ──
    const ctrlBox = document.createElement('div');
    ctrlBox.style.cssText = 'background:var(--panel);border:1px solid var(--border2);border-radius:6px;padding:10px;margin-bottom:10px';
    ctrlBox.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <div>
          <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--text3);margin-bottom:3px;text-transform:uppercase">Gap (mm)</div>
          <input type="number" min="0" max="50" step="0.5" value="${this.gapMm}" onchange="LeatherNorm.setGap(this.value)"
            style="width:100%;background:var(--card);border:1px solid var(--border);color:var(--text);padding:5px 7px;border-radius:3px;font-family:var(--font-mono);font-size:11px;outline:none">
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--text3);margin-bottom:3px;text-transform:uppercase">Display Unit</div>
          <select onchange="LeatherNorm.setUnit(this.value)" style="width:100%;background:var(--card);border:1px solid var(--border);color:var(--text);padding:5px 7px;border-radius:3px;font-family:var(--font-mono);font-size:11px;outline:none">
            <option value="cm2"${this.unit==='cm2'?' selected':''}>cm²</option>
            <option value="dm2"${this.unit==='dm2'?' selected':''}>dm²</option>
            <option value="sqft"${this.unit==='sqft'?' selected':''}>sq.ft</option>
            <option value="sqin"${this.unit==='sqin'?' selected':''}>sq.in</option>
          </select>
        </div>
      </div>
      <button class="header-btn" style="width:100%;justify-content:center;font-size:11px;padding:6px 8px" onclick="LeatherNorm._editRulesNow()">⚙ Edit Per-Component Rules</button>
    `;
    list.appendChild(ctrlBox);

    // ── Selection toolbar (shown above cards) ──
    const selBar = document.createElement('div');
    selBar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
    const numSel = this._selected.size;
    selBar.innerHTML = `
      <button class="header-btn ${numSel >= 2 ? 'primary' : ''}" style="font-size:11px;padding:5px 10px" ${numSel < 2 ? 'disabled' : ''} onclick="LeatherNorm._combineSelected()">🧩 Combine Selected (${numSel})</button>
      <button class="header-btn" style="font-size:11px;padding:5px 8px" onclick="LeatherNorm._selectAll()">All</button>
      <button class="header-btn" style="font-size:11px;padding:5px 8px" ${numSel === 0 ? 'disabled' : ''} onclick="LeatherNorm._clearSelection()">None</button>
    `;
    list.appendChild(selBar);

    // Tip box
    const tipBox = document.createElement('div');
    tipBox.style.cssText = 'font-size:10px;color:var(--text3);padding:6px 10px;background:rgba(255,180,80,0.06);border-left:3px solid var(--accent);border-radius:3px;margin-bottom:8px;line-height:1.5';
    tipBox.innerHTML = `💡 Tap <b>checkbox</b> to multi-select. <b>Ctrl/Shift-click</b> on desktop. <b>Long-press</b> or <b>right-click</b> for menu. Or <b>drag</b> a card onto another to combine.`;
    list.appendChild(tipBox);

    // ── Component cards ──
    if (this.components.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:var(--text3);padding:10px;text-align:center';
      empty.textContent = 'No components.';
      list.appendChild(empty);
      document.getElementById('nm-stats').innerHTML = '';
      document.getElementById('nm-title').textContent = '—';
      return;
    }
    this.components.forEach((c, i) => {
      const card = document.createElement('div');
      const isActive = i === this.activeIdx;
      const isSelected = this._selected.has(i);
      const isCombined = c.groupRef && c.groupRef.type === 'combined';
      card.className = 'nm-comp-card' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');
      card.draggable = true;
      card.dataset.idx = i;
      // For combined sets, c.name is "Combined Set N" (kept as-is). For
      // individual components, look up custom rename via App.getDisplayName.
      const displayName = isCombined
        ? c.name
        : ((typeof App !== 'undefined' && App.getDisplayName) ? App.getDisplayName(c.name) : c.name);
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div class="nm-card-checkbox ${isSelected ? 'checked' : ''}" data-cb-idx="${i}" title="Select for combining"></div>
          <div style="flex:1;min-width:0">
            <div class="nm-comp-name">${isCombined ? '🧩 ' : ''}${displayName}</div>
            <div class="nm-comp-meta">
              ${c.pieceCount} pcs • Net: ${this._formatArea(c.net)} • Eff: ${c.efficiency.toFixed(1)}%
            </div>
          </div>
          ${isCombined ? `<button title="Delete combined group" onclick="event.stopPropagation();LeatherNorm._removeGroup(${i})" style="background:none;border:none;color:var(--text3);cursor:pointer;padding:2px 6px;font-size:14px">✕</button>` : ''}
        </div>`;

      // Checkbox click — toggles selection without changing active
      const checkbox = card.querySelector('.nm-card-checkbox');
      checkbox.addEventListener('click', e => {
        e.stopPropagation();
        if (this._selected.has(i)) this._selected.delete(i);
        else this._selected.add(i);
        this._renderSidebar();
      });

      // Card click — desktop: Ctrl/Shift multi-select, plain = activate
      card.addEventListener('click', e => {
        if (e.shiftKey && this._selected.size > 0) {
          const lastIdx = this.activeIdx;
          const start = Math.min(lastIdx, i);
          const end = Math.max(lastIdx, i);
          for (let k = start; k <= end; k++) this._selected.add(k);
        } else if (e.ctrlKey || e.metaKey) {
          if (this._selected.has(i)) this._selected.delete(i);
          else this._selected.add(i);
        } else {
          // Plain click — activate (don't clear selection)
          this.activeIdx = i;
          // Switching active component — deselect any per-piece edit
          this._selectedPieceIdx = -1;
          this._hidePieceToolbar && this._hidePieceToolbar();
          this.fitView();
        }
        this._renderSidebar();
        this.draw();
      });

      // Right-click context menu (desktop)
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (!this._selected.has(i)) {
          this._selected.clear();
          this._selected.add(i);
          this._renderSidebar();
        }
        this._showContextMenu(e.clientX, e.clientY);
      });

      // Long-press support (touch + mouse)
      let pressTimer = null;
      const startPress = (clientX, clientY) => {
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (!this._selected.has(i)) {
            this._selected.add(i);
            this._renderSidebar();
          }
          this._showContextMenu(clientX, clientY);
        }, 550);
      };
      const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
      card.addEventListener('touchstart', e => {
        const t = e.touches[0];
        startPress(t.clientX, t.clientY);
      }, { passive: true });
      card.addEventListener('touchend', cancelPress);
      card.addEventListener('touchmove', cancelPress);
      card.addEventListener('mousedown', e => {
        if (e.button === 0) startPress(e.clientX, e.clientY);
      });
      card.addEventListener('mouseup', cancelPress);
      card.addEventListener('mouseleave', cancelPress);

      // Drag-and-drop
      card.addEventListener('dragstart', e => {
        cancelPress();
        e.dataTransfer.setData('text/plain', String(i));
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.style.outline = '2px dashed var(--accent)';
      });
      card.addEventListener('dragleave', () => {
        card.style.outline = '';
      });
      card.addEventListener('drop', e => {
        e.preventDefault();
        card.style.outline = '';
        const srcIdx = parseInt(e.dataTransfer.getData('text/plain'));
        if (!isNaN(srcIdx) && srcIdx !== i) {
          this._combineByIndices([srcIdx, i]);
        }
      });

      list.appendChild(card);
    });
    this._renderStats();
  },

  /* Reopen the rules popup mid-session to edit per-component rules. */
  _editRulesNow() {
    this._showPreOpenRulesPopup();
  },

  /* Right-click context menu for selected component cards. */
  _showContextMenu(x, y) {
    const old = document.getElementById('nm-ctx-menu');
    if (old) old.remove();
    const sel = Array.from(this._selected);
    const menu = document.createElement('div');
    menu.id = 'nm-ctx-menu';
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2020;background:var(--panel);border:1px solid var(--border);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);padding:4px;min-width:240px;font-size:12px`;
    const items = [];
    if (sel.length >= 2) {
      items.push({ label: `🧩 Combine ${sel.length} into one parallelogram`, action: () => this._combineByIndices(sel) });
    } else if (sel.length === 1) {
      items.push({ label: '🧩 Combine with… (need 2+ selected)', disabled: true });
    }
    items.push({ label: '☰ Select all', action: () => { this._selected.clear(); for (let k = 0; k < this.components.length; k++) this._selected.add(k); this._renderSidebar(); } });
    items.push({ label: '✗ Clear selection', action: () => { this._selected.clear(); this._renderSidebar(); } });
    // Allow deleting combined ones
    const combinedSel = sel.filter(i => this.components[i] && this.components[i].groupRef && this.components[i].groupRef.type === 'combined');
    if (combinedSel.length > 0) {
      items.push({ label: `🗑 Delete ${combinedSel.length} combined group(s)`, action: () => {
        // Remove highest-index first to keep indices stable
        combinedSel.sort((a,b)=>b-a).forEach(i => this._removeGroup(i, true));
        this._selected.clear();
        this._rebuildComponents();
        this._renderSidebar();
        this.fitView();
        this.draw();
      } });
    }
    for (const it of items) {
      const b = document.createElement('button');
      b.style.cssText = `display:block;width:100%;text-align:left;padding:8px 12px;background:none;border:none;color:${it.disabled?'var(--text3)':'var(--text)'};cursor:${it.disabled?'not-allowed':'pointer'};border-radius:3px;font-size:12px`;
      b.textContent = it.label;
      if (!it.disabled) {
        b.onmouseenter = () => b.style.background = 'var(--card)';
        b.onmouseleave = () => b.style.background = 'none';
        b.onclick = () => { menu.remove(); it.action(); };
      }
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    // Close on click outside
    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
      };
      document.addEventListener('click', close);
    }, 0);
  },

  /* Combine the components at the given indices into a NEW combined group.
     Pulls part IDs (single groups) and/or sub-part IDs (combined groups). */
  _combineByIndices(indices) {
    const partIds = [];
    for (const idx of indices) {
      const c = this.components[idx];
      if (!c || !c.groupRef) continue;
      if (c.groupRef.type === 'single') {
        if (!partIds.includes(c.groupRef.partId)) partIds.push(c.groupRef.partId);
      } else if (c.groupRef.type === 'combined') {
        for (const pid of c.groupRef.partIds) {
          if (!partIds.includes(pid)) partIds.push(pid);
        }
      }
    }
    if (partIds.length < 2) {
      alert('Need 2 or more different components to combine.');
      return;
    }
    // Add new combined group
    const id = 'g_' + Date.now().toString(36);
    this._groups.push({ type: 'combined', id, partIds, name: null });
    this._selected.clear();
    this._rebuildComponents();
    // Activate the newly added group
    this.activeIdx = this.components.length - 1;
    this._renderSidebar();
    this.fitView();
    this.draw();
  },

  /* Toolbar helpers */
  _combineSelected() {
    if (this._selected.size < 2) {
      alert('Select 2 or more components first (use checkboxes or Ctrl+click).');
      return;
    }
    this._combineByIndices(Array.from(this._selected));
  },

  _selectAll() {
    this._selected.clear();
    for (let i = 0; i < this.components.length; i++) this._selected.add(i);
    this._renderSidebar();
  },

  _clearSelection() {
    this._selected.clear();
    this._renderSidebar();
  },

  /* Remove a group by component index. If skipRebuild, caller will rebuild. */
  _removeGroup(componentIdx, skipRebuild = false) {
    const c = this.components[componentIdx];
    if (!c || !c.groupRef) return;
    const groupIdx = this._groups.indexOf(c.groupRef);
    if (groupIdx >= 0) this._groups.splice(groupIdx, 1);
    if (!skipRebuild) {
      this._rebuildComponents();
      if (this.activeIdx >= this.components.length) this.activeIdx = Math.max(0, this.components.length - 1);
      this._renderSidebar();
      this.fitView();
      this.draw();
    }
  },

  _renderStats() {
    const c = this.components[this.activeIdx];
    if (!c) return;
    const stats = document.getElementById('nm-stats');
    const isCombined = c.isCombined;
    const titleName = isCombined
      ? c.name
      : ((typeof App !== 'undefined' && App.getDisplayName) ? App.getDisplayName(c.name) : c.name);
    document.getElementById('nm-title').textContent = titleName +
      ` (${c.pieceCount} pieces, ${this.gapMm}mm gap)`;
    // Total grid box count covered
    const totalBoxes = this._computeTotalBoxes(c);
    // Final Norm = Gross per piece × (1 + allowance)
    const allowance = c.allowance !== undefined ? c.allowance : (this.wastagePct / 100);
    const finalNormPerPiece = c.grossPerPiece * (1 + allowance);
    const allowancePctText = (allowance * 100).toFixed(1);
    stats.innerHTML = `
      <div class="nm-stat-row"><span class="nm-stat-lbl">Pieces in parallelogram</span><span class="nm-stat-val">${c.pieceCount}</span></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Net Area (per piece)</span><span class="nm-stat-val">${this._formatArea(c.net)}</span></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Gross Area (per piece)</span><span class="nm-stat-val">${this._formatArea(c.grossPerPiece)}</span></div>
      <div class="nm-stat-row" style="background:rgba(255,180,80,0.10);border-color:rgba(255,180,80,0.3)"><span class="nm-stat-lbl" style="color:#d8841a">⚠ Interlock Waste</span><span class="nm-stat-val" style="color:#e89030">${this._formatArea(c.interlockWaste)}</span></div>
      <div class="nm-stat-row highlight"><span class="nm-stat-lbl">Efficiency %</span><span class="nm-stat-val">${c.efficiency.toFixed(1)}%</span></div>
      <div style="height:8px"></div>
      <div class="nm-stat-row" style="background:var(--accent-dim);border-color:var(--accent)"><span class="nm-stat-lbl" style="color:var(--accent)">★ Final Norm/piece (+${allowancePctText}%)</span><span class="nm-stat-val" style="color:var(--accent);font-size:13px">${this._formatArea(finalNormPerPiece)}</span></div>
      <div style="height:8px"></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Total Net (all pieces)</span><span class="nm-stat-val">${this._formatArea(c.totalNet)}</span></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Gross Total</span><span class="nm-stat-val">${this._formatArea(c.grossTotal)}</span></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Parallelogram</span><span class="nm-stat-val">${c.paraW.toFixed(1)}×${c.paraH.toFixed(1)} mm</span></div>
      <div style="height:8px"></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Grid boxes (1cm²)</span><span class="nm-stat-val">${totalBoxes.fullEquiv.toFixed(1)} boxes</span></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Full boxes</span><span class="nm-stat-val">${totalBoxes.full}</span></div>
      <div class="nm-stat-row"><span class="nm-stat-lbl">Partial boxes</span><span class="nm-stat-val">${totalBoxes.partial}</span></div>
      ${this._renderComponentBreakdown(c, finalNormPerPiece, allowance)}
    `;
  },

  /* ── Per-component breakdown for combined sets ──────────────────────
     When a parallelogram contains multiple component types (e.g. 2 vamps
     + 2 quarters), this section shows how the area is attributed to
     each type. Uses convex-hull-share method: each component's gross =
     area of the convex hull of all its pieces, scaled if hulls overlap
     so the total matches the parallelogram area exactly.

     Returns empty string for non-combined or single-component cases. */
  _renderComponentBreakdown(c, finalNormPerPiece, allowance) {
    if (!c.isCombined) return '';

    // Group pieces by partName (component type). Each entry tracks count,
    // net area sum, and accumulates vertices for hull computation.
    const byComp = new Map();
    for (const p of c.pieces) {
      const name = p.partName || '(unnamed)';
      if (!byComp.has(name)) {
        byComp.set(name, { count: 0, netSum: 0, points: [] });
      }
      const e = byComp.get(name);
      e.count++;
      e.netSum += Math.abs(polyArea(p.poly));
      for (const pt of p.poly) e.points.push(pt);
    }

    // Only show breakdown if there are 2+ distinct component types — for
    // a single component type it's redundant with the main stats.
    if (byComp.size < 2) return '';

    // Compute convex-hull area per component (the bounded region of the
    // parallelogram each component occupies)
    let totalHull = 0;
    const compHulls = new Map();
    for (const [name, e] of byComp) {
      const hull = LeatherNorm._convexHull(e.points);
      const hullArea = Math.abs(polyArea(hull));
      compHulls.set(name, hullArea);
      totalHull += hullArea;
    }

    // Scale hulls to sum exactly to parallelogram total. This handles
    // overlapping hulls (when components are interleaved) by splitting
    // overlap zones proportionally to hull share.
    const scaleFactor = (totalHull > 0) ? (c.grossTotal / totalHull) : 1;

    // Build the breakdown rows. For each component:
    //   gross_share = hull_area × scale → that component's slice of total
    //   gross_per_piece = gross_share / count
    //   norm_per_piece = gross_per_piece × (1 + allowance)
    //   util = net_per_piece / gross_per_piece × 100
    let rows = '';
    const sortedComps = Array.from(byComp.entries())
      .sort((a, b) => b[1].netSum - a[1].netSum);  // largest first

    for (const [name, e] of sortedComps) {
      const grossShare = compHulls.get(name) * scaleFactor;
      const grossPerPiece = grossShare / e.count;
      const netPerPiece = e.netSum / e.count;
      const normPerPiece = grossPerPiece * (1 + allowance);
      const utilPct = grossPerPiece > 0 ? (netPerPiece / grossPerPiece * 100) : 0;
      const truncName = name.length > 22 ? name.slice(0, 20) + '…' : name;
      rows += `
        <div style="border-top:1px dashed var(--border2);padding:6px 0 4px;margin-top:4px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
            <span style="font-weight:600;color:var(--text);font-size:11px" title="${name}">${truncName}</span>
            <span style="font-size:10px;color:var(--text3);font-family:var(--font-mono)">${e.count} pcs</span>
          </div>
          <div class="nm-stat-row" style="padding:3px 6px;font-size:10px"><span class="nm-stat-lbl" style="font-size:10px">Net/piece</span><span class="nm-stat-val" style="font-size:10px;color:var(--accent)">${this._formatArea(netPerPiece)}</span></div>
          <div class="nm-stat-row" style="padding:3px 6px;font-size:10px"><span class="nm-stat-lbl" style="font-size:10px">Gross/piece</span><span class="nm-stat-val" style="font-size:10px;color:var(--green)">${this._formatArea(grossPerPiece)}</span></div>
          <div class="nm-stat-row" style="padding:3px 6px;font-size:10px"><span class="nm-stat-lbl" style="font-size:10px">Norm/piece (+${(allowance*100).toFixed(1)}%)</span><span class="nm-stat-val" style="font-size:10px;color:var(--accent);font-weight:600">${this._formatArea(normPerPiece)}</span></div>
          <div class="nm-stat-row" style="padding:3px 6px;font-size:10px"><span class="nm-stat-lbl" style="font-size:10px">Util %</span><span class="nm-stat-val" style="font-size:10px">${utilPct.toFixed(1)}%</span></div>
        </div>`;
    }

    return `
      <div style="height:14px"></div>
      <div style="font-size:11px;color:var(--text2);font-weight:700;margin-bottom:4px;letter-spacing:0.5px;text-transform:uppercase;border-top:1px solid var(--border2);padding-top:10px">Per-Component Breakdown</div>
      <div style="font-size:9px;color:var(--text3);line-height:1.4;margin-bottom:6px;font-style:italic">Hull-share method — each component's slice of parallelogram area</div>
      ${rows}
    `;
  },

  /* ── Convex hull (Andrew's monotone chain) ─────────────────────────
     Used by _renderComponentBreakdown for per-component area attribution.
     Same algorithm as Costing._convexHull — duplicated here so this
     module remains independent. */
  _convexHull(points) {
    if (!points || points.length < 3) return points || [];
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const n = pts.length;
    const cross = (O, A, B) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = n - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  },


  /* Sum coverage of all 1cm grid boxes the pieces cover. */
  _computeTotalBoxes(c) {
    let full = 0, partial = 0, fullEquiv = 0;
    const step = 10;
    for (const piece of c.pieces) {
      const pbb = this._bbox(piece.poly);
      const gx0 = Math.floor(pbb.minX / step) * step;
      const gy0 = Math.floor(pbb.minY / step) * step;
      const gx1 = Math.ceil(pbb.maxX / step) * step;
      const gy1 = Math.ceil(pbb.maxY / step) * step;
      for (let gx = gx0; gx < gx1; gx += step) {
        for (let gy = gy0; gy < gy1; gy += step) {
          const cov = this._boxCoverage(piece.poly, gx, gy);
          if (cov > 0.97) { full++; fullEquiv += 1; }
          else if (cov > 0.01) { partial++; fullEquiv += cov; }
        }
      }
    }
    return { full, partial, fullEquiv };
  },

  /* Main canvas draw: 1cm grid + partial-box labels + pieces + parallelogram. */
  draw() {
    if (!this.ctx) return;
    const c = this.components[this.activeIdx];
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.zoom, this.zoom);

    if (!c) {
      ctx.restore();
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Import DXF files to see norm calculations', this.canvas.width / 2, this.canvas.height / 2);
      return;
    }

    const bb = c.displayBBox;

    // Background
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(bb.minX, bb.minY, bb.w, bb.h);

    // Draw 1cm grid (10mm boxes)
    const gridStep = 10;
    const gx0 = Math.floor(bb.minX / gridStep) * gridStep;
    const gy0 = Math.floor(bb.minY / gridStep) * gridStep;
    const gx1 = Math.ceil((bb.minX + bb.w) / gridStep) * gridStep;
    const gy1 = Math.ceil((bb.minY + bb.h) / gridStep) * gridStep;
    ctx.strokeStyle = '#d0d0d8';
    ctx.lineWidth = 0.5 / this.zoom;
    for (let x = gx0; x <= gx1; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, gy0); ctx.lineTo(x, gy1); ctx.stroke();
    }
    for (let y = gy0; y <= gy1; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke();
    }

    // Grid box labels — sequential count (1, 2, 3, ...) + partial coverage
    // For each piece, walk grid boxes. Numbering restarts per piece.
    if (this.showLabels && this.zoom > 1.0) {
      const fs = 3.0;  // mm-space font size (constant in world coords)
      ctx.font = fs + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Distinct color per piece for box labels
      const pieceColors = ['rgba(20,80,140,0.95)','rgba(100,40,130,0.95)','rgba(150,80,40,0.95)','rgba(40,110,90,0.95)','rgba(120,30,30,0.95)','rgba(60,80,140,0.95)'];
      for (let pi = 0; pi < c.pieces.length; pi++) {
        const piece = c.pieces[pi];
        const color = pieceColors[pi % pieceColors.length];
        const pbb = this._bbox(piece.poly);
        const pgx0 = Math.floor(pbb.minX / gridStep) * gridStep;
        const pgy0 = Math.floor(pbb.minY / gridStep) * gridStep;
        const pgx1 = Math.ceil(pbb.maxX / gridStep) * gridStep;
        const pgy1 = Math.ceil(pbb.maxY / gridStep) * gridStep;
        // Running total of box-equivalents (full + partials). Each box label
        // shows cumulative count including this box's coverage. Skip boxes
        // with negligible coverage (< 5%) — they're sliver overlaps from
        // bbox padding and would create visually duplicate labels.
        let runningTotal = 0;
        let lastLabel = null;
        ctx.fillStyle = color;
        for (let gy = pgy0; gy < pgy1; gy += gridStep) {
          for (let gx = pgx0; gx < pgx1; gx += gridStep) {
            const cov = this._boxCoverage(piece.poly, gx, gy);
            if (cov < 0.05) continue;  // skip slivers
            runningTotal += cov;
            const cx = gx + gridStep / 2;
            const cy = gy + gridStep / 2;
            const label = (Math.abs(runningTotal - Math.round(runningTotal)) < 0.05)
              ? String(Math.round(runningTotal))
              : runningTotal.toFixed(1);
            // Dedupe: if this label is identical to the previous one (because
            // small coverage increments rounded to the same display), skip
            // drawing — avoids stacking duplicate "109.7 109.7" labels.
            if (label === lastLabel) continue;
            ctx.fillText(label, cx, cy);
            lastLabel = label;
          }
        }
      }
    }

    // Parallelogram
    if (c.pgram && c.pgram.length >= 3) {
      ctx.strokeStyle = 'rgba(30, 110, 200, 0.9)';
      ctx.fillStyle = 'rgba(30, 110, 200, 0.06)';
      ctx.lineWidth = 2 / this.zoom;
      ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.beginPath();
      c.pgram.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);

      // ── CorelDRAW-style measurement lines (width + height) ──
      // Draw measure lines OUTSIDE the parallelogram bbox with tick marks
      // and the dimension label at the midpoint.
      const pbb = this._bbox(c.pgram);
      const offset = 12;  // mm — distance from parallelogram to measure line
      const tick = 3;     // mm — tick mark half-length
      ctx.strokeStyle = 'rgba(220, 80, 40, 0.9)';  // red-orange like CAD
      ctx.fillStyle = 'rgba(220, 80, 40, 1.0)';
      ctx.lineWidth = 1.0 / this.zoom;

      // ── Horizontal (WIDTH) measurement — below the parallelogram ──
      const widthY = pbb.maxY + offset;
      // Extension lines (vertical ticks to the parallelogram corners)
      ctx.beginPath();
      ctx.moveTo(pbb.minX, pbb.maxY + 2);
      ctx.lineTo(pbb.minX, widthY + tick);
      ctx.moveTo(pbb.maxX, pbb.maxY + 2);
      ctx.lineTo(pbb.maxX, widthY + tick);
      ctx.stroke();
      // Main horizontal dimension line
      ctx.beginPath();
      ctx.moveTo(pbb.minX, widthY);
      ctx.lineTo(pbb.maxX, widthY);
      ctx.stroke();
      // Arrow ticks at ends (angled like CAD)
      ctx.beginPath();
      ctx.moveTo(pbb.minX, widthY - tick);
      ctx.lineTo(pbb.minX, widthY + tick);
      ctx.moveTo(pbb.maxX, widthY - tick);
      ctx.lineTo(pbb.maxX, widthY + tick);
      ctx.stroke();
      // Width label in the middle — with background so it's readable over grid
      const widthLabel = this._formatDim(pbb.maxX - pbb.minX);
      ctx.font = 'bold 4.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const wMid = (pbb.minX + pbb.maxX) / 2;
      const wMetrics = ctx.measureText(widthLabel);
      const wPad = 1.5;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(wMid - wMetrics.width/2 - wPad, widthY - 2.7, wMetrics.width + wPad*2, 4.2);
      ctx.fillStyle = 'rgba(220, 80, 40, 1.0)';
      ctx.fillText(widthLabel, wMid, widthY);

      // ── Vertical (HEIGHT) measurement — right of the parallelogram ──
      const heightX = pbb.maxX + offset;
      ctx.strokeStyle = 'rgba(220, 80, 40, 0.9)';
      // Extension lines (horizontal ticks)
      ctx.beginPath();
      ctx.moveTo(pbb.maxX + 2, pbb.minY);
      ctx.lineTo(heightX + tick, pbb.minY);
      ctx.moveTo(pbb.maxX + 2, pbb.maxY);
      ctx.lineTo(heightX + tick, pbb.maxY);
      ctx.stroke();
      // Main vertical dimension line
      ctx.beginPath();
      ctx.moveTo(heightX, pbb.minY);
      ctx.lineTo(heightX, pbb.maxY);
      ctx.stroke();
      // Tick marks at ends
      ctx.beginPath();
      ctx.moveTo(heightX - tick, pbb.minY);
      ctx.lineTo(heightX + tick, pbb.minY);
      ctx.moveTo(heightX - tick, pbb.maxY);
      ctx.lineTo(heightX + tick, pbb.maxY);
      ctx.stroke();
      // Height label — rotated 90° so it reads along the line
      const heightLabel = this._formatDim(pbb.maxY - pbb.minY);
      const hMid = (pbb.minY + pbb.maxY) / 2;
      ctx.save();
      ctx.translate(heightX, hMid);
      ctx.rotate(-Math.PI / 2);
      const hMetrics = ctx.measureText(heightLabel);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(-hMetrics.width/2 - wPad, -2.7, hMetrics.width + wPad*2, 4.2);
      ctx.fillStyle = 'rgba(220, 80, 40, 1.0)';
      ctx.fillText(heightLabel, 0, 0);
      ctx.restore();
    }

    // Pieces — distinct color per piece
    const pieceFills = ['rgba(80,160,220,0.30)','rgba(180,100,200,0.30)','rgba(220,160,80,0.30)','rgba(80,200,160,0.30)','rgba(220,80,80,0.30)','rgba(120,140,220,0.30)'];
    const pieceStrokes = ['rgba(20,80,140,0.95)','rgba(100,40,130,0.95)','rgba(150,80,40,0.95)','rgba(40,110,90,0.95)','rgba(120,30,30,0.95)','rgba(60,80,140,0.95)'];
    const selIdx = (typeof this._selectedPieceIdx === 'number') ? this._selectedPieceIdx : -1;
    for (let pi = 0; pi < c.pieces.length; pi++) {
      const piece = c.pieces[pi];
      const isSelected = (pi === selIdx);
      // Highlighted piece gets brighter fill + thick orange outline
      ctx.fillStyle = isSelected ? 'rgba(255,180,40,0.45)' : pieceFills[pi % pieceFills.length];
      ctx.strokeStyle = isSelected ? 'rgba(255,140,0,1)' : pieceStrokes[pi % pieceStrokes.length];
      ctx.lineWidth = (isSelected ? 3.0 : 1.5) / this.zoom;
      ctx.beginPath();
      piece.poly.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // ── Rotate handle on selected piece ──
    // Draw a red curved arrow arc + ROTATE label centered on the selected
    // piece's bounding box. User can grab anywhere along this arc and drag
    // around the piece's centroid to rotate it freely. Same visual style
    // as the main canvas rotate indicator.
    if (selIdx >= 0 && selIdx < c.pieces.length) {
      const sp = c.pieces[selIdx];
      const sbb = this._bbox(sp.poly);
      const cxh = sbb.minX + sbb.w / 2;
      const cyh = sbb.minY + sbb.h / 2;
      const rh = Math.min(sbb.w, sbb.h) * 0.35;
      // Curved arrow arc
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 3 / this.zoom;
      ctx.beginPath();
      ctx.arc(cxh, cyh, rh, -Math.PI * 0.7, Math.PI * 0.5, false);
      ctx.stroke();
      // Arrowhead at end of arc
      const ah = Math.max(6 / this.zoom, rh * 0.25);
      const ax = cxh + rh * Math.cos(Math.PI * 0.5);
      const ay = cyh + rh * Math.sin(Math.PI * 0.5);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ah * 0.7, ay - ah);
      ctx.lineTo(ax + ah * 0.7, ay - ah);
      ctx.closePath();
      ctx.fillStyle = '#ff4444';
      ctx.fill();
      // ROTATE label below the arc
      ctx.fillStyle = '#ff4444';
      ctx.font = `bold ${Math.max(9, 12 / this.zoom)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ROTATE', cxh, cyh + rh + 14 / this.zoom);
      // Stash the handle geometry so the mouse handler can hit-test it
      this._rotateHandle = { cx: cxh, cy: cyh, r: rh };
    } else {
      this._rotateHandle = null;
    }

    // Piece labels (large letter or number in centroid)
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.font = 'bold 6px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let pi = 0; pi < c.pieces.length; pi++) {
      const cen = this._centroid(c.pieces[pi].poly);
      // For combined mode, show partName (or its custom rename) instead of letter
      let label;
      if (c.isCombined) {
        const rawName = c.pieces[pi].partName || '';
        const displayName = (typeof App !== 'undefined' && App.getDisplayName)
          ? App.getDisplayName(rawName) : rawName;
        label = displayName.slice(0, 6);
      } else {
        label = String.fromCharCode(65 + pi);  // A, B, C...
      }
      ctx.fillText(label, cen[0], cen[1]);
    }

    // ── Title (above parallelogram) ──
    if (c.pgram && c.pgram.length >= 3) {
      const pbb = this._bbox(c.pgram);
      const titleStr = this._buildTitle(c);
      ctx.fillStyle = '#1a1a1a';
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(titleStr, pbb.minX, pbb.minY - 12);
      // Subtitle with pieces info
      ctx.fillStyle = '#555';
      ctx.font = '5px sans-serif';
      ctx.fillText(`${c.pieceCount} pieces · gap ${this.gapMm}mm`, pbb.minX, pbb.minY - 5);

      // ── Breakdown report (below parallelogram, below dimension line) ──
      this._drawBreakdownOnCanvas(ctx, c, pbb);
    }

    ctx.restore();
  },

  /* Build title string — component name(s) joined by + for combined. */
  _buildTitle(c) {
    if (c.isCombined) {
      // Get unique part names in the order they appear
      const names = [];
      for (const piece of c.pieces) {
        const n = piece.partName || 'Part';
        if (!names.includes(n)) names.push(n);
      }
      return names.join(' + ');
    }
    return c.name || 'Component';
  },

  /* Build the breakdown rows (same data used by canvas draw + SVG export). */
  _buildBreakdownRows(c) {
    const allowance = c.allowance !== undefined ? c.allowance : (this.wastagePct / 100);
    const additionalWaste = c.grossPerPiece * allowance;
    const finalGross = c.grossPerPiece + additionalWaste;
    const rows = [
      ['Total Area (all pieces)', this._formatArea(c.totalNet)],
      ['Net Norm (per piece)', this._formatArea(c.net)],
      ['Gross Norm (per piece)', this._formatArea(c.grossPerPiece)],
      ['Interlock Waste', this._formatArea(c.interlockWaste)],
      [`Wastage Allowance (${(allowance * 100).toFixed(1)}%)`, this._formatArea(additionalWaste)],
      ['Final Total Gross', this._formatArea(finalGross)],
      ['Efficiency', c.efficiency.toFixed(1) + '%'],
    ];

    // ── Per-component breakdown (only for combined sets with 2+ types) ──
    // Append separator + per-component rows so the canvas / SVG export
    // shows each component type's own gross/norm/util alongside the
    // aggregate stats. Same hull-share method used in the right panel.
    if (c.isCombined) {
      const compRows = this._buildPerComponentRows(c, allowance);
      if (compRows.length) {
        rows.push(['', '']);  // visual separator
        rows.push(['── Per Component ──', '']);
        for (const r of compRows) rows.push(r);
      }
    }
    return rows;
  },

  /* Returns array of [label, value] pairs for per-component breakdown.
     Empty array if not multi-component. Uses convex-hull-share method
     to attribute parallelogram area to each component type. */
  _buildPerComponentRows(c, allowance) {
    const byComp = new Map();
    for (const p of c.pieces) {
      const name = this._displayName(p.partName || '(unnamed)');
      if (!byComp.has(name)) byComp.set(name, { count: 0, netSum: 0, points: [] });
      const e = byComp.get(name);
      e.count++;
      e.netSum += Math.abs(polyArea(p.poly));
      for (const pt of p.poly) e.points.push(pt);
    }
    if (byComp.size < 2) return [];

    let totalHull = 0;
    const compHulls = new Map();
    for (const [name, e] of byComp) {
      const hull = LeatherNorm._convexHull(e.points);
      const hullArea = Math.abs(polyArea(hull));
      compHulls.set(name, hullArea);
      totalHull += hullArea;
    }
    const scaleFactor = (totalHull > 0) ? (c.grossTotal / totalHull) : 1;

    const out = [];
    const sorted = Array.from(byComp.entries()).sort((a, b) => b[1].netSum - a[1].netSum);
    for (const [name, e] of sorted) {
      const grossShare = compHulls.get(name) * scaleFactor;
      const grossPer = grossShare / e.count;
      const normPer = grossPer * (1 + allowance);
      const truncName = name.length > 18 ? name.slice(0, 16) + '…' : name;
      // Label includes piece count, value is the per-piece final norm
      out.push([
        `${truncName} (${e.count}×) Norm/pc`,
        this._formatArea(normPer),
      ]);
    }
    return out;
  },

  /* Display name uses user's custom rename if set, else original part name.
     Custom names are stored in App._partDisplayNames map (set via the
     rename UI). Same lookup used everywhere a part name is shown. */
  _displayName(partName) {
    if (typeof App !== 'undefined' && App._partDisplayNames) {
      const custom = App._partDisplayNames.get(partName);
      if (custom) return custom;
    }
    return partName;
  },

  _drawBreakdownOnCanvas(ctx, c, pbb) {
    const rows = this._buildBreakdownRows(c);
    // Place breakdown below the dimension line (which sits at pbb.maxY + 12)
    const startY = pbb.maxY + 24;
    const rowHeight = 6;
    // Header box
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(100,100,100,0.4)';
    ctx.lineWidth = 0.3;
    const boxW = Math.max(110, pbb.maxX - pbb.minX);
    const boxH = rowHeight * rows.length + 10;
    ctx.fillRect(pbb.minX, startY - 2, boxW, boxH);
    ctx.strokeRect(pbb.minX, startY - 2, boxW, boxH);
    // Header label
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 4.5px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('📐 NORM BREAKDOWN', pbb.minX + 2, startY);
    // Rows
    ctx.font = '4px monospace';
    for (let i = 0; i < rows.length; i++) {
      const y = startY + 6 + i * rowHeight;
      const [label, value] = rows[i];
      // Skip blank separator row visually but keep its space
      if (label === '' && value === '') continue;
      // Highlight Final Total Gross + section header
      const isFinal = label === 'Final Total Gross';
      const isHeader = label === '── Per Component ──';
      const isCompRow = label.endsWith('Norm/pc');
      if (isHeader) {
        ctx.fillStyle = '#666';
        ctx.font = 'italic bold 3.8px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, pbb.minX + 2, y);
        continue;
      }
      ctx.fillStyle = isFinal ? '#d8841a' : (isCompRow ? '#1f77b4' : '#333');
      ctx.font = isFinal ? 'bold 4.2px sans-serif' :
                 (isCompRow ? '3.8px sans-serif' : '4px sans-serif');
      ctx.textAlign = 'left';
      ctx.fillText(label, pbb.minX + 2, y);
      ctx.textAlign = 'right';
      ctx.font = isFinal ? 'bold 4.2px monospace' :
                 (isCompRow ? 'bold 3.8px monospace' : '4px monospace');
      ctx.fillText(value, pbb.minX + boxW - 2, y);
    }
  },

  _centroid(poly) {
    let sx = 0, sy = 0;
    for (const [x, y] of poly) { sx += x; sy += y; }
    return [sx / poly.length, sy / poly.length];
  },

  /* Export current view as a printable SVG report. */
  /* ══════════════════════════════════════════════════════════════════
     APPLY TO CANVAS — convert this Norm Calc parallelogram into a
     dedicated sheet on the main canvas.
     ─────────────────────────────────────────────────────────────────
     The active component's parallelogram becomes the new sheet:
       • Sheet width  = parallelogram width
       • Sheet height = parallelogram height
       • Sheet type   = rectangular
       • Hide outline = none (sheet is the rectangle)
       • Pieces       = current piece arrangement (after manual rotate /
                        flip / drag adjustments), placed inside the sheet
                        at margin offset
     
     This converts the "calculator preview" into a real working sheet —
     the user's hand-tuned Norm Calc layout becomes a production-ready
     canvas they can then export, print, or save as a project.
     ═════════════════════════════════════════════════════════════════ */
  applyToCanvas() {
    if (!this.components || this.components.length === 0) {
      alert('Nothing to apply — no parallelograms calculated yet.');
      return;
    }
    const comp = this.components[this.activeIdx];
    if (!comp || !comp.pieces || comp.pieces.length === 0) {
      alert('Active component has no pieces to apply.');
      return;
    }
    if (typeof App === 'undefined' || typeof Renderer === 'undefined') {
      alert('Main app not ready.');
      return;
    }

    // ── Compute parallelogram bounding box from current piece positions ──
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const piece of comp.pieces) {
      for (const [x, y] of piece.poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const paraW = maxX - minX;
    const paraH = maxY - minY;
    if (paraW <= 0 || paraH <= 0) {
      alert('Invalid parallelogram dimensions.');
      return;
    }

    // Margin from current settings (fallback 5mm)
    const settings = App.getSettings ? App.getSettings() : { margin: 5 };
    const margin = settings.margin || 5;

    // Sheet sized to match Norm Calc display area exactly:
    //   width  = parallelogram + horizontal margin (for dimension arrows)
    //   height = parallelogram + extra room for top title + bottom NORM
    //            BREAKDOWN table (allow ~30% extra below para for table)
    // The breakdown table renders at the bottom of the Norm Calc canvas,
    // so we mirror that layout here.
    const titleSpace = paraH * 0.06;        // top title bar room
    const breakdownSpace = paraH * 0.40;    // bottom breakdown table room (fits ~10 rows + header)
    const sideSpace = paraW * 0.08;         // side margin for dimension arrows
    const sheetW = paraW + 2 * sideSpace;
    const sheetH = paraH + titleSpace + breakdownSpace;

    // ── Capture decoration data (not image) for native re-render on main canvas ──
    // Instead of an image overlay (which looks washed out and doesn't scale
    // crisply), we store the decoration parameters and let the main Renderer
    // draw them natively. Reuses _buildBreakdownRows so labels & values
    // match the Norm Calc sidebar exactly.
    let breakdown = [];
    try {
      const rows = this._buildBreakdownRows(comp);
      // _buildBreakdownRows returns [['label', 'value'], ...] arrays (with
      // optional separator rows). Convert to our object format with highlight
      // flag on "Final Total Gross" (the big orange number).
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const label = row[0];
        const value = row[1];
        if (label === '─') continue;        // skip separator rows
        const highlight = (typeof label === 'string' && label.startsWith('Final'));
        breakdown.push({ label, value, highlight });
      }
    } catch (err) {
      console.warn('[NormCalc applyToCanvas] breakdown build failed:', err);
    }
    const decoration = {
      paraW,
      paraH,
      gridStep: 10,                                    // 1cm grid
      sideSpace,
      titleSpace,
      breakdownSpace,
      title: `${comp.name} · ${comp.pieces.length} pieces · gap ${this.gapMm}mm`,
      breakdown,
    };

    // ── Resize the main canvas sheet ──
    // Update the s-width / s-height input fields (which feed getSettings)
    // AND directly update Renderer.sheetW / sheetH for the live canvas.
    // We keep current display unit — _formatNum + factor converts mm → unit.
    const u = (App._UNIT_FACTORS && App.currentUnit && App._UNIT_FACTORS[App.currentUnit])
      ? App._UNIT_FACTORS[App.currentUnit] : 1;
    const wEl = document.getElementById('s-width');
    const hEl = document.getElementById('s-height');
    if (wEl) wEl.value = (App._formatNum ? App._formatNum(sheetW / u) : Math.ceil(sheetW));
    if (hEl) hEl.value = (App._formatNum ? App._formatNum(sheetH / u) : Math.ceil(sheetH));
    Renderer.sheetW = sheetW;
    Renderer.sheetH = sheetH;
    // Clear any existing custom hide outline — new sheet is plain rectangular
    App._sheetOutline = null;
    Renderer.sheetOutline = null;
    App._sheetType = 'rect';
    // Clear old defects (they were positioned for the old sheet)
    App._defects = [];
    Renderer.defects = [];
    if (App._updateDefectStats) App._updateDefectStats();

    // ── Build placements inside the new sheet ──
    // Pieces sit in the parallelogram region: starting at (sideSpace, titleSpace)
    // with the same internal arrangement they had in Norm Calc.
    const offX = sideSpace - minX;
    const offY = titleSpace - minY;
    const placements = [];
    for (const piece of comp.pieces) {
      const partName = piece.partName || comp.name;
      const partRef = App.parts.find(p =>
        p.name === partName || p.id === piece.partId
      ) || App.parts[0];
      const worldPoly = piece.poly.map(([x, y]) => [x + offX, y + offY]);
      const innerLines = Array.isArray(piece.innerLines)
        ? piece.innerLines.map(line => ({
            ...line,
            pts: (line.pts || []).map(([x, y]) => [x + offX, y + offY]),
          }))
        : [];
      let pxMin = Infinity, pyMin = Infinity;
      for (const [x, y] of worldPoly) {
        if (x < pxMin) pxMin = x;
        if (y < pyMin) pyMin = y;
      }
      placements.push({
        partId: partRef.id,
        partName: partRef.name,
        color: partRef.color,
        pts: worldPoly,
        worldPoly,
        x: pxMin,
        y: pyMin,
        rotation: piece.rot || 0,
        mirror: piece.mir || false,
        sheet: 0,
        innerLines,
      });
    }

    // Set the nest result on main app
    App.nestResult = {
      placements,
      placed: placements.length,
      unplaced: 0,
      sheets: [{ index: 0, placements: placements.slice() }],
    };
    Renderer.nestResult = App.nestResult;

    // Set the captured decoration on Renderer so the main canvas renders
    // grid, parallelogram outline, dimension arrows, title, and breakdown
    // table natively (matching Norm Calc preview).
    Renderer.normCalcDecoration = decoration;
    if (typeof App !== 'undefined') {
      App._sheetSetByNormCalc = true;
    }

    // Close norm calc modal
    const modal = document.getElementById('norm-modal');
    if (modal) modal.classList.remove('active');

    // Refresh main canvas — fit view so new sheet is visible
    if (Renderer.fitView) Renderer.fitView();
    if (Renderer.draw) Renderer.draw();
    if (App.updateUI) App.updateUI();

    const status = document.getElementById('nest-status');
    if (status) status.textContent = `✓ Applied to canvas: ${sheetW.toFixed(0)}×${sheetH.toFixed(0)}mm sheet, ${placements.length} pieces`;
  },


  exportReport() {
    const c = this.components[this.activeIdx];
    if (!c) { alert('No component selected.'); return; }
    const bb = c.displayBBox;
    const W = bb.w, H = bb.h;
    const scale = 2;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W*scale} ${(H+110)*scale}" width="${W*scale*2}">`;
    svg += `<rect width="100%" height="100%" fill="#ffffff"/>`;
    svg += `<g transform="translate(${-bb.minX*scale},${(-bb.minY+40)*scale}) scale(${scale})">`;
    const step = 10;
    const gx0 = Math.floor(bb.minX / step) * step;
    const gy0 = Math.floor(bb.minY / step) * step;
    const gx1 = Math.ceil((bb.minX + bb.w) / step) * step;
    const gy1 = Math.ceil((bb.minY + bb.h) / step) * step;
    svg += `<g stroke="#d0d0d8" stroke-width="0.3">`;
    for (let x = gx0; x <= gx1; x += step) svg += `<line x1="${x}" y1="${gy0}" x2="${x}" y2="${gy1}"/>`;
    for (let y = gy0; y <= gy1; y += step) svg += `<line x1="${gx0}" y1="${y}" x2="${gx1}" y2="${y}"/>`;
    svg += `</g>`;

    const pieceStrokes = ['#14508c','#642882','#965028','#286e5a','#781e1e','#3c5096'];
    const pieceFills = ['rgba(80,160,220,0.30)','rgba(180,100,200,0.30)','rgba(220,160,80,0.30)','rgba(80,200,160,0.30)','rgba(220,80,80,0.30)','rgba(120,140,220,0.30)'];

    // Coverage labels — running cumulative total (full + partials)
    if (this.showLabels) {
      for (let pi = 0; pi < c.pieces.length; pi++) {
        const poly = c.pieces[pi].poly;
        const color = pieceStrokes[pi % pieceStrokes.length];
        const pbb = this._bbox(poly);
        let runningTotal = 0;
        let lastLabel = null;
        for (let gy = Math.floor(pbb.minY/step)*step; gy < pbb.maxY; gy += step) {
          for (let gx = Math.floor(pbb.minX/step)*step; gx < pbb.maxX; gx += step) {
            const cov = this._boxCoverage(poly, gx, gy);
            if (cov < 0.05) continue;
            runningTotal += cov;
            const cx = gx + 5;
            const label = (Math.abs(runningTotal - Math.round(runningTotal)) < 0.05)
              ? String(Math.round(runningTotal))
              : runningTotal.toFixed(1);
            if (label === lastLabel) continue;
            svg += `<text x="${cx}" y="${gy+6}" font-size="3" font-family="monospace" fill="${color}" text-anchor="middle">${label}</text>`;
            lastLabel = label;
          }
        }
      }
    }
    if (c.pgram) {
      svg += `<polygon points="${c.pgram.map(p=>p[0]+','+p[1]).join(' ')}" fill="rgba(30,110,200,0.06)" stroke="rgba(30,110,200,0.9)" stroke-width="1" stroke-dasharray="3,2"/>`;
      // Dimension lines
      const pbb = this._bbox(c.pgram);
      const offset = 12, tick = 3;
      const dimCol = 'rgba(220,80,40,0.9)';
      // Horizontal (width) below
      const wY = pbb.maxY + offset;
      svg += `<g stroke="${dimCol}" stroke-width="0.5" fill="none">`;
      svg += `<line x1="${pbb.minX}" y1="${pbb.maxY+2}" x2="${pbb.minX}" y2="${wY+tick}"/>`;
      svg += `<line x1="${pbb.maxX}" y1="${pbb.maxY+2}" x2="${pbb.maxX}" y2="${wY+tick}"/>`;
      svg += `<line x1="${pbb.minX}" y1="${wY}" x2="${pbb.maxX}" y2="${wY}"/>`;
      svg += `<line x1="${pbb.minX}" y1="${wY-tick}" x2="${pbb.minX}" y2="${wY+tick}"/>`;
      svg += `<line x1="${pbb.maxX}" y1="${wY-tick}" x2="${pbb.maxX}" y2="${wY+tick}"/>`;
      svg += `</g>`;
      const widthLabel = this._formatDim(pbb.maxX - pbb.minX);
      const wMid = (pbb.minX + pbb.maxX) / 2;
      // Approximate label background (white rectangle under the text)
      svg += `<rect x="${wMid - widthLabel.length * 1.2}" y="${wY - 2.3}" width="${widthLabel.length * 2.4}" height="3.6" fill="#fff"/>`;
      svg += `<text x="${wMid}" y="${wY+1.4}" font-size="4" font-family="sans-serif" font-weight="bold" fill="#dc5028" text-anchor="middle">${widthLabel}</text>`;
      // Vertical (height) right
      const hX = pbb.maxX + offset;
      const hMid = (pbb.minY + pbb.maxY) / 2;
      svg += `<g stroke="${dimCol}" stroke-width="0.5" fill="none">`;
      svg += `<line x1="${pbb.maxX+2}" y1="${pbb.minY}" x2="${hX+tick}" y2="${pbb.minY}"/>`;
      svg += `<line x1="${pbb.maxX+2}" y1="${pbb.maxY}" x2="${hX+tick}" y2="${pbb.maxY}"/>`;
      svg += `<line x1="${hX}" y1="${pbb.minY}" x2="${hX}" y2="${pbb.maxY}"/>`;
      svg += `<line x1="${hX-tick}" y1="${pbb.minY}" x2="${hX+tick}" y2="${pbb.minY}"/>`;
      svg += `<line x1="${hX-tick}" y1="${pbb.maxY}" x2="${hX+tick}" y2="${pbb.maxY}"/>`;
      svg += `</g>`;
      const heightLabel = this._formatDim(pbb.maxY - pbb.minY);
      svg += `<rect x="${hX - 2.3}" y="${hMid - heightLabel.length * 1.2}" width="3.6" height="${heightLabel.length * 2.4}" fill="#fff"/>`;
      svg += `<text x="${hX}" y="${hMid}" font-size="4" font-family="sans-serif" font-weight="bold" fill="#dc5028" text-anchor="middle" transform="rotate(-90 ${hX} ${hMid})">${heightLabel}</text>`;
    }
    for (let pi = 0; pi < c.pieces.length; pi++) {
      const piece = c.pieces[pi];
      svg += `<polygon points="${piece.poly.map(p=>p[0]+','+p[1]).join(' ')}" fill="${pieceFills[pi%pieceFills.length]}" stroke="${pieceStrokes[pi%pieceStrokes.length]}" stroke-width="0.8"/>`;
      const cen = this._centroid(piece.poly);
      const label = c.isCombined
        ? (piece.partName || '').slice(0, 6)
        : String.fromCharCode(65 + pi);
      svg += `<text x="${cen[0]}" y="${cen[1]}" font-size="6" font-family="sans-serif" font-weight="bold" fill="#222" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
    }
    // Title above parallelogram (same as canvas)
    if (c.pgram) {
      const pbb = this._bbox(c.pgram);
      const titleStr = this._buildTitle(c);
      svg += `<text x="${pbb.minX}" y="${pbb.minY-12}" font-size="8" font-family="sans-serif" font-weight="bold" fill="#1a1a1a">${titleStr}</text>`;
      svg += `<text x="${pbb.minX}" y="${pbb.minY-5}" font-size="5" font-family="sans-serif" fill="#555">${c.pieceCount} pieces · gap ${this.gapMm}mm</text>`;
      // Breakdown box below
      const rows = this._buildBreakdownRows(c);
      const startY = pbb.maxY + 24;
      const rowHeight = 6;
      const boxW = Math.max(110, pbb.maxX - pbb.minX);
      const boxH = rowHeight * rows.length + 10;
      svg += `<rect x="${pbb.minX}" y="${startY-2}" width="${boxW}" height="${boxH}" fill="rgba(255,255,255,0.95)" stroke="rgba(100,100,100,0.4)" stroke-width="0.3"/>`;
      svg += `<text x="${pbb.minX+2}" y="${startY+3.5}" font-size="4.5" font-family="sans-serif" font-weight="bold" fill="#1a1a1a">📐 NORM BREAKDOWN</text>`;
      for (let i = 0; i < rows.length; i++) {
        const y = startY + 9.5 + i * rowHeight;
        const [label, value] = rows[i];
        if (label === '' && value === '') continue;
        const isFinal = label === 'Final Total Gross';
        const isHeader = label === '── Per Component ──';
        const isCompRow = label.endsWith('Norm/pc');
        if (isHeader) {
          svg += `<text x="${pbb.minX+2}" y="${y}" font-size="3.8" font-family="sans-serif" font-style="italic" font-weight="bold" fill="#666">${label}</text>`;
          continue;
        }
        const color = isFinal ? '#d8841a' : (isCompRow ? '#1f77b4' : '#333');
        const fw = (isFinal || isCompRow) ? 'bold' : 'normal';
        const fs = isFinal ? '4.2' : (isCompRow ? '3.8' : '4');
        const escapedLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        svg += `<text x="${pbb.minX+2}" y="${y}" font-size="${fs}" font-family="sans-serif" font-weight="${fw}" fill="${color}">${escapedLabel}</text>`;
        svg += `<text x="${pbb.minX+boxW-2}" y="${y}" font-size="${fs}" font-family="monospace" font-weight="${fw}" fill="${color}" text-anchor="end">${value}</text>`;
      }
    }
    svg += `</g>`;
    // Short footer with extras (grid box count, parallelogram dims)
    const totalBoxes = this._computeTotalBoxes(c);
    const allowance = c.allowance !== undefined ? c.allowance : (this.wastagePct / 100);
    svg += `<g font-family="sans-serif" transform="translate(20, ${(bb.h + 60) * scale})">`;
    svg += `<text y="0" font-size="10" fill="#666">Parallelogram: ${c.paraW.toFixed(1)} × ${c.paraH.toFixed(1)} mm · Grid boxes: ${totalBoxes.fullEquiv.toFixed(1)} (${totalBoxes.full} full + ${totalBoxes.partial} partial)</text>`;
    svg += `</g>`;
    svg += `</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `norm_${c.name.replace(/[^a-z0-9]/gi,'_')}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  /* ══════════════════════════════════════════════════════════════════
     EXPORT — EXCEL
     ─────────────────────────────────────────────────────────────────
     Generates a multi-sheet Excel workbook covering ALL component
     analyses currently shown (not just the active one). Sheet 1 is a
     summary; one sheet per component with full breakdown.
     ═════════════════════════════════════════════════════════════════ */
  async exportExcel() {
    if (!this.components || !this.components.length) {
      alert('No components to export. Add parts and configure first.');
      return;
    }
    if (typeof ExcelJS === 'undefined') {
      alert('Excel library not loaded.');
      return;
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NestForge Pro';
    wb.created = new Date();

    // ── Summary sheet ──
    const sum = wb.addWorksheet('Summary');
    sum.columns = [
      { header: 'Component', key: 'name', width: 28 },
      { header: 'Pieces', key: 'count', width: 8 },
      { header: 'Net/piece', key: 'net', width: 12 },
      { header: 'Gross/piece', key: 'gross', width: 12 },
      { header: 'Norm/piece', key: 'norm', width: 12 },
      { header: 'Efficiency %', key: 'eff', width: 11 },
      { header: 'Total Net', key: 'totNet', width: 11 },
      { header: 'Gross Total', key: 'totGross', width: 11 },
      { header: 'Parallelogram (mm)', key: 'pgram', width: 18 },
    ];
    // Header style
    sum.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sum.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1d6f42' } };
    sum.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    for (const c of this.components) {
      const allowance = c.allowance !== undefined ? c.allowance : (this.wastagePct / 100);
      const norm = c.grossPerPiece * (1 + allowance);
      const dispName = (typeof App !== 'undefined' && App.getDisplayName)
        ? (c.isCombined ? c.name : App.getDisplayName(c.name)) : c.name;
      sum.addRow({
        name: (c.isCombined ? '🧩 ' : '') + dispName,
        count: c.pieceCount,
        net: this._formatArea(c.net),
        gross: this._formatArea(c.grossPerPiece),
        norm: this._formatArea(norm),
        eff: c.efficiency.toFixed(1) + '%',
        totNet: this._formatArea(c.totalNet),
        totGross: this._formatArea(c.grossTotal),
        pgram: `${c.paraW.toFixed(1)} × ${c.paraH.toFixed(1)}`,
      });
    }
    sum.eachRow((row, idx) => {
      if (idx === 1) return;
      row.alignment = { vertical: 'middle', horizontal: idx === 1 ? 'center' : 'left' };
    });

    // ── Per-component detail sheets ──
    for (const c of this.components) {
      // Excel sheet name: 31 char limit, no [ ] : * ? / \
      let safeName = (c.name || 'Component').replace(/[\[\]:*?\/\\]/g, '_').slice(0, 28);
      const sheet = wb.addWorksheet(safeName);
      sheet.columns = [
        { header: 'Metric', key: 'k', width: 30 },
        { header: 'Value', key: 'v', width: 18 },
      ];
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1d6f42' } };

      const rows = this._buildBreakdownRows(c);
      for (const [k, v] of rows) {
        if (k === '' && v === '') { sheet.addRow({}); continue; }
        if (k === '── Per Component ──') {
          const r = sheet.addRow({ k: 'PER-COMPONENT BREAKDOWN', v: '' });
          r.font = { bold: true, italic: true, color: { argb: 'FF666666' } };
          continue;
        }
        const isFinal = k === 'Final Total Gross';
        const isCompRow = k.endsWith('Norm/pc');
        const r = sheet.addRow({ k, v });
        if (isFinal) {
          r.font = { bold: true, color: { argb: 'FFd8841a' } };
        } else if (isCompRow) {
          r.font = { bold: true, color: { argb: 'FF1f77b4' } };
        }
      }

      // Add piece details — one row per piece with rotation/mirror/coords
      sheet.addRow({});
      const hdr = sheet.addRow({ k: 'Piece # / Component', v: 'Rotation · Mirror · Centroid (mm)' });
      hdr.font = { bold: true };
      hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
      for (let pi = 0; pi < c.pieces.length; pi++) {
        const p = c.pieces[pi];
        const cen = this._centroid(p.poly);
        const dispPartName = (typeof App !== 'undefined' && App.getDisplayName)
          ? App.getDisplayName(p.partName || '') : (p.partName || '');
        sheet.addRow({
          k: `${pi + 1}. ${dispPartName}`,
          v: `${p.rot}° · ${p.mir ? 'Mirrored' : 'Original'} · (${cen[0].toFixed(1)}, ${cen[1].toFixed(1)})`,
        });
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = URL.createObjectURL(blob);
    a.download = `norm-report-${ts}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  /* ══════════════════════════════════════════════════════════════════
     EXPORT — PDF
     ─────────────────────────────────────────────────────────────────
     Page-per-component layout with summary on first page. Uses jsPDF
     (already loaded for costing reports).
     ═════════════════════════════════════════════════════════════════ */
  exportPdf() {
    if (!this.components || !this.components.length) {
      alert('No components to export. Add parts and configure first.');
      return;
    }
    const jspdf = window.jspdf || window.jsPDF || (window.jspdf && window.jspdf.jsPDF);
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : window.jsPDF;
    if (!JsPDF) {
      alert('PDF library not loaded.');
      return;
    }
    const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const M = 15;
    let y = M;

    // ── Title page header ──
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.setTextColor(20, 20, 20);
    pdf.text('Leather Norm Report', M, y); y += 7;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(120, 120, 120);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, M, y); y += 8;
    pdf.setDrawColor(200);
    pdf.line(M, y, pageW - M, y); y += 6;

    // ── Summary table ──
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(20, 20, 20);
    pdf.text('Summary', M, y); y += 6;

    const cols = [
      { lbl: 'Component', w: 50 },
      { lbl: 'Pcs',       w: 10 },
      { lbl: 'Net/pc',    w: 22 },
      { lbl: 'Gross/pc',  w: 22 },
      { lbl: 'Norm/pc',   w: 22 },
      { lbl: 'Eff%',      w: 14 },
      { lbl: 'Pgram',     w: 32 },
    ];

    pdf.setFillColor(29, 111, 66);
    pdf.rect(M, y, pageW - 2 * M, 6, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(8);
    let cx = M + 1;
    for (const col of cols) {
      pdf.text(col.lbl, cx + 1, y + 4);
      cx += col.w;
    }
    y += 6;

    pdf.setTextColor(40, 40, 40);
    pdf.setFont('helvetica', 'normal');
    let stripe = false;
    for (const c of this.components) {
      const allowance = c.allowance !== undefined ? c.allowance : (this.wastagePct / 100);
      const norm = c.grossPerPiece * (1 + allowance);
      const dispName = (typeof App !== 'undefined' && App.getDisplayName)
        ? (c.isCombined ? c.name : App.getDisplayName(c.name)) : c.name;
      const labelName = (c.isCombined ? '[Combined] ' : '') + dispName;
      const truncName = labelName.length > 28 ? labelName.slice(0, 26) + '…' : labelName;

      if (stripe) { pdf.setFillColor(245, 245, 245); pdf.rect(M, y, pageW - 2 * M, 5, 'F'); }
      stripe = !stripe;
      cx = M + 1;
      pdf.text(truncName, cx + 1, y + 3.5);                     cx += cols[0].w;
      pdf.text(String(c.pieceCount), cx + 1, y + 3.5);          cx += cols[1].w;
      pdf.text(this._formatArea(c.net), cx + 1, y + 3.5);       cx += cols[2].w;
      pdf.text(this._formatArea(c.grossPerPiece), cx + 1, y + 3.5); cx += cols[3].w;
      pdf.text(this._formatArea(norm), cx + 1, y + 3.5);        cx += cols[4].w;
      pdf.text(c.efficiency.toFixed(1) + '%', cx + 1, y + 3.5); cx += cols[5].w;
      pdf.text(`${c.paraW.toFixed(0)} × ${c.paraH.toFixed(0)}`, cx + 1, y + 3.5);
      y += 5;
      if (y > pageH - 20) { pdf.addPage(); y = M; }
    }
    y += 4;

    // ── Per-component detail pages ──
    for (const c of this.components) {
      pdf.addPage();
      y = M;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(14);
      pdf.setTextColor(20, 20, 20);
      const dispName = (typeof App !== 'undefined' && App.getDisplayName)
        ? (c.isCombined ? c.name : App.getDisplayName(c.name)) : c.name;
      pdf.text((c.isCombined ? '🧩 ' : '') + dispName, M, y); y += 7;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(120, 120, 120);
      pdf.text(`${c.pieceCount} pieces · ${this.gapMm}mm gap`, M, y); y += 8;
      pdf.setDrawColor(200);
      pdf.line(M, y, pageW - M, y); y += 6;

      const rows = this._buildBreakdownRows(c);
      pdf.setFontSize(10);
      for (const [k, v] of rows) {
        if (k === '' && v === '') { y += 2; continue; }
        if (k === '── Per Component ──') {
          y += 3;
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(100, 100, 100);
          pdf.text('PER-COMPONENT BREAKDOWN', M, y);
          y += 5;
          pdf.setFont('helvetica', 'normal');
          continue;
        }
        const isFinal = k === 'Final Total Gross';
        const isCompRow = k.endsWith('Norm/pc');
        if (isFinal) {
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(216, 132, 26);
        } else if (isCompRow) {
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(31, 119, 180);
        } else {
          pdf.setFont('helvetica', 'normal');
          pdf.setTextColor(40, 40, 40);
        }
        pdf.text(k, M, y);
        pdf.text(String(v), pageW - M, y, { align: 'right' });
        y += 5;
        if (y > pageH - 20) { pdf.addPage(); y = M; }
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    pdf.save(`norm-report-${ts}.pdf`);
  },
};


