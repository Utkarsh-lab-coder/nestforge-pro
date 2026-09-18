/*
 * NestForge Pro — WorksheetManager — multi-tab workspace switching and persistence
 *
 * Original location: lines 16996..17255 of nestforge-pro.html (260 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const WorksheetManager = {

  /* State — single source of truth for worksheet data */
  _worksheets: [{ id: 0, name: 'Sheet 1', parts: [], nestResult: null, colorIdx: 0 }],
  _activeWS: 0,
  _wsCounter: 1,  // for naming new sheets

  /* ── WORKSPACE MANAGEMENT ──────────────────────────────────── */
  _saveCurrentWS() {
    const ws = this._worksheets[this._activeWS];
    if (!ws) return;
    ws.parts = this.parts;
    ws.nestResult = this.nestResult;
    ws.colorIdx = colorIdx;
    // Snapshot sheet settings — needed later to render this worksheet's layout
    // image into the consolidated report without activating the worksheet.
    try {
      ws.settings = this.getSettings();
    } catch (e) { /* DOM might not be ready */ }
    // Preserve costing inputs per sheet
    ws.cost = {
      article:   document.getElementById('cost-article').value,
      component: document.getElementById('cost-component').value,
      material:  document.getElementById('cost-material').value,
      price:     document.getElementById('cost-price').value,
      unit:      document.getElementById('cost-unit').value,
      mode:      this._costMode,
      specs:     this._collectSpecs(),
      reportFmt: this._reportFmt,
    };
  },

  _loadWS(idx) {
    const ws = this._worksheets[idx];
    if (!ws) return;
    this._activeWS = idx;
    this.parts = ws.parts;
    this.nestResult = ws.nestResult;
    colorIdx = ws.colorIdx || 0;
    Renderer.parts = this.parts;
    Renderer.nestResult = this.nestResult;
    Renderer.currentSheet = 0;
    // Restore costing inputs
    const c = ws.cost || {};
    document.getElementById('cost-article').value   = c.article   || '';
    document.getElementById('cost-component').value = c.component || '';
    document.getElementById('cost-material').value  = c.material  || '';
    document.getElementById('cost-price').value     = c.price     || 0;
    document.getElementById('cost-unit').value      = c.unit      || 'sqdm';
    this._setCostMode(c.mode || 'piece');
    this._setReportFmt(c.reportFmt || 'excel');
    this._clearSpecs();
    for (const s of (c.specs || [])) this._addSpec(s.key, s.value);
    this.updatePartsUI();
    this.updateUI();
    document.getElementById('empty-canvas').style.display = this.parts.length ? 'none' : 'flex';
    if (this.nestResult) {
      this.renderSheetTabs(this.nestResult.sheets);
      document.getElementById('btn-export').disabled = false;
      const mbx = document.getElementById('m-btn-export'); if (mbx) mbx.disabled = false;
    } else {
      this.renderSheetTabs([]);
      document.getElementById('btn-export').disabled = true;
      const mbx = document.getElementById('m-btn-export'); if (mbx) mbx.disabled = true;
    }
    Renderer.fitView();
    this._updateCosting();
    document.getElementById('nest-status').textContent = this.nestResult
      ? `${this.nestResult.placed} placed, ${this.nestResult.sheetCount} sheet(s)`
      : 'Ready';
  },

  switchWorksheet(idx) {
    if (idx === this._activeWS) return;
    this._saveCurrentWS();
    this._loadWS(idx);
    this._renderWSTabs();
  },

  addWorksheet() {
    this._saveCurrentWS();
    this._wsCounter++;
    const newWS = { id: this._wsCounter, name: 'Sheet ' + this._wsCounter, parts: [], nestResult: null, colorIdx: 0 };
    this._worksheets.push(newWS);
    this._loadWS(this._worksheets.length - 1);
    this._renderWSTabs();
  },

  removeWorksheet(idx) {
    if (this._worksheets.length <= 1) return; // keep at least one
    this._worksheets.splice(idx, 1);
    // Remap merge selection: drop `idx`, shift down higher indices
    const newSel = new Set();
    for (const s of this._mergeSelected) {
      if (s === idx) continue;
      newSel.add(s > idx ? s - 1 : s);
    }
    this._mergeSelected = newSel;
    // Adjust active index
    if (this._activeWS >= this._worksheets.length) this._activeWS = this._worksheets.length - 1;
    if (idx <= this._activeWS && this._activeWS > 0) this._activeWS = Math.max(0, this._activeWS - 1);
    this._loadWS(this._activeWS);
    this._renderWSTabs();
  },

  _mergeSelected: new Set(), // worksheet indices user has checked for merging

  _renderWSTabs() {
    const wrap = document.getElementById('ws-tabs');
    wrap.innerHTML = '';

    // Section header
    const hdr = document.createElement('div');
    hdr.className = 'ws-section-hdr';
    hdr.innerHTML = '<span>Sheets</span>';
    wrap.appendChild(hdr);

    // Merge button (visible only when 2+ selected)
    const mergeBtn = document.createElement('button');
    mergeBtn.id = 'ws-merge-btn';
    mergeBtn.textContent = `⇲ Merge ${this._mergeSelected.size} Sheets`;
    if (this._mergeSelected.size >= 2) mergeBtn.classList.add('visible');
    mergeBtn.addEventListener('click', () => this.mergeSelectedSheets());
    wrap.appendChild(mergeBtn);

    for (let i = 0; i < this._worksheets.length; i++) {
      const ws = this._worksheets[i];
      const partCount = ws.parts ? ws.parts.length : 0;
      const tab = document.createElement('div');
      tab.className = 'ws-tab' + (i === this._activeWS ? ' active' : '');
      tab.dataset.ws = i;

      // Merge-select checkbox
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'ws-check';
      chk.title = 'Select for merge';
      chk.checked = this._mergeSelected.has(i);
      chk.addEventListener('click', (e) => {
        e.stopPropagation();
        if (chk.checked) this._mergeSelected.add(i);
        else this._mergeSelected.delete(i);
        this._renderWSTabs();
      });
      tab.appendChild(chk);

      const icon = document.createElement('span');
      icon.className = 'ws-icon';
      icon.textContent = i === this._activeWS ? '◆' : '◇';
      tab.appendChild(icon);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'ws-name';
      nameSpan.textContent = ws.name;
      nameSpan.title = 'Double-click to rename';
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const newName = prompt('Rename sheet:', ws.name);
        if (newName && newName.trim()) {
          ws.name = newName.trim();
          this._renderWSTabs();
        }
      });
      tab.appendChild(nameSpan);

      const partsSpan = document.createElement('span');
      partsSpan.className = 'ws-parts';
      partsSpan.textContent = partCount > 0 ? partCount + 'p' : '';
      tab.appendChild(partsSpan);

      if (this._worksheets.length > 1) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'ws-close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.removeWorksheet(i); });
        tab.appendChild(closeBtn);
      }

      tab.addEventListener('click', (e) => {
        if (e.target === chk) return;
        this.switchWorksheet(i);
      });
      wrap.appendChild(tab);
    }

    // Add button
    const addBtn = document.createElement('button');
    addBtn.id = 'ws-add-btn';
    addBtn.title = 'New empty sheet';
    addBtn.textContent = '＋ New Sheet';
    addBtn.addEventListener('click', () => this.addWorksheet());
    wrap.appendChild(addBtn);
  },

  /* Merge all checked worksheets into a new sheet. The new sheet contains
     every part from each source sheet (copied, so source sheets stay intact).
     The canvas size is NOT auto-adjusted here — the auto-size popup on
     "Run Nesting" handles that when parts don't fit. */
  mergeSelectedSheets() {
    if (this._mergeSelected.size < 2) return;
    this._saveCurrentWS();

    const sourceIdxs = [...this._mergeSelected].sort((a,b)=>a-b);
    const mergedParts = [];
    const names = [];
    let localColorIdx = 0;

    for (const idx of sourceIdxs) {
      const ws = this._worksheets[idx];
      if (!ws) continue;
      names.push(ws.name);
      for (const p of (ws.parts || [])) {
        // Deep copy part so editing merged sheet doesn't affect source
        mergedParts.push({
          ...p,
          id: Date.now() + '_' + Math.random().toString(36).slice(2) + '_' + mergedParts.length,
          pts: p.pts.map(pt => [pt[0], pt[1]]),
          innerLines: (p.innerLines||[]).map(il => ({
            pts: il.pts.map(pt => [pt[0], pt[1]]),
            layer: il.layer, color: il.color, closed: il.closed
          })),
          qty: p.qty || 1
        });
        localColorIdx++;
      }
    }

    if (!mergedParts.length) { alert('Selected sheets are empty.'); return; }

    this._wsCounter++;
    const newWS = {
      id: this._wsCounter,
      name: 'Merged (' + names.join('+').slice(0, 24) + ')',
      parts: mergedParts,
      nestResult: null,
      colorIdx: localColorIdx
    };
    this._worksheets.push(newWS);
    this._mergeSelected.clear();
    this._loadWS(this._worksheets.length - 1);
    this._renderWSTabs();
    document.getElementById('nest-status').textContent =
      `Merged ${sourceIdxs.length} sheets → ${mergedParts.length} parts. Run Nesting to interlock.`;
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   LEATHER NORM CALCULATOR
   ─────────────────────────────────────────────────────────────────────
   Implements the classical "Parallelogram Method" from footwear pattern
   engineering. For each loaded component:
     1. Finds the best interlock of 2 identical pieces (by trying all
        allowed rotations + mirror, picking the orientation whose bounding
        parallelogram has smallest area).
     2. Draws the bounding parallelogram around the nested pair.
     3. Computes Net Area (polygon area ≡ grid-box counting).
     4. Computes Gross Area (parallelogram area ÷ 2 per piece).
     5. Shows on a 1cm grid with decimal coverage labels in partial boxes.
   Classical industry deliverable for leather consumption costing.
══════════════════════════════════════════════════════════════════════════════ */

