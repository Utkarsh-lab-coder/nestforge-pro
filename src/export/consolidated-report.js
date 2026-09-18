/*
 * NestForge Pro — ConsolidatedReport — multi-worksheet article-level export
 *
 * Original location: lines 13788..14815 of nestforge-pro.html (1028 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const ConsolidatedReport = {
  /* ══════════════════════════════════════════════════════════════════
     CONSOLIDATED (MULTI-WORKSHEET) COSTING REPORT
     Combines ALL worksheets into one article-level report.
     Each worksheet = one component of the same article.
     ═════════════════════════════════════════════════════════════════ */
  _consolidated: {
    brand: '', article: '', buyer: '', order: '', season: '', operator: '',
    notes: '', productImage: null, specs: [], fmt: 'excel',
  },

  /* Entry point — called from top-bar button */
  exportConsolidatedReport() {
    // Save current worksheet first so its latest costing inputs are persisted
    App._saveCurrentWS();
    this._openConsolidatedDialog();
  },

  _openConsolidatedDialog() {
    const modal = document.getElementById('cr-modal');
    // Restore values from in-memory state
    document.getElementById('cr-brand').value    = this._consolidated.brand;
    document.getElementById('cr-article').value  = this._consolidated.article;
    document.getElementById('cr-buyer').value    = this._consolidated.buyer;
    document.getElementById('cr-order').value    = this._consolidated.order;
    document.getElementById('cr-season').value   = this._consolidated.season;
    document.getElementById('cr-operator').value = this._consolidated.operator;
    document.getElementById('cr-notes').value    = this._consolidated.notes;

    // Re-render specs list
    const specsHost = document.getElementById('cr-specs');
    specsHost.innerHTML = '';
    for (const s of this._consolidated.specs) this._renderConsolidatedSpecRow(s.key, s.value);

    // Re-render image preview
    this._renderConsolidatedImagePreview();

    // Render worksheets preview (read-only list of what will be included)
    this._renderConsolidatedWSPreview();

    // Set format buttons
    this._setConsolidatedFmt(this._consolidated.fmt);

    modal.classList.add('active');
  },

  _closeConsolidatedDialog() {
    // Persist what the user typed so reopening keeps the state
    this._saveConsolidatedInputs();
    document.getElementById('cr-modal').classList.remove('active');
  },

  _saveConsolidatedInputs() {
    this._consolidated.brand    = document.getElementById('cr-brand').value.trim();
    this._consolidated.article  = document.getElementById('cr-article').value.trim();
    this._consolidated.buyer    = document.getElementById('cr-buyer').value.trim();
    this._consolidated.order    = document.getElementById('cr-order').value.trim();
    this._consolidated.season   = document.getElementById('cr-season').value.trim();
    this._consolidated.operator = document.getElementById('cr-operator').value.trim();
    this._consolidated.notes    = document.getElementById('cr-notes').value.trim();
    // Specs
    const specs = [];
    document.querySelectorAll('#cr-specs .cr-spec-row').forEach(row => {
      const k = row.querySelector('.cr-spec-key').value.trim();
      const v = row.querySelector('.cr-spec-val').value.trim();
      if (k || v) specs.push({ key: k, value: v });
    });
    this._consolidated.specs = specs;
  },

  _addConsolidatedSpec() {
    this._renderConsolidatedSpecRow('', '');
  },

  _renderConsolidatedSpecRow(k, v) {
    const host = document.getElementById('cr-specs');
    const row = document.createElement('div');
    row.className = 'cr-spec-row';
    row.innerHTML =
      `<input type="text" class="cr-spec-key" placeholder="Field name" value="${this._escAttr(k)}">
       <input type="text" class="cr-spec-val" placeholder="Value" value="${this._escAttr(v)}">
       <button class="cr-spec-del" title="Remove">✕</button>`;
    row.querySelector('.cr-spec-del').addEventListener('click', () => row.remove());
    host.appendChild(row);
  },

  _escAttr(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  },

  _onConsolidatedImageChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { alert('Image too large. Maximum 5 MB.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        this._consolidated.productImage = { dataURL: e.target.result, width: img.width, height: img.height };
        this._renderConsolidatedImagePreview();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  _removeConsolidatedImage() {
    this._consolidated.productImage = null;
    const input = document.getElementById('cr-img-input');
    if (input) input.value = '';
    this._renderConsolidatedImagePreview();
  },

  _renderConsolidatedImagePreview() {
    const drop = document.getElementById('cr-img-drop');
    if (!drop) return;
    if (this._consolidated.productImage) {
      drop.innerHTML = `
        <img src="${this._consolidated.productImage.dataURL}">
        <div style="margin-top:6px;font-size:10px;color:var(--text3)">Click to replace · <a href="#" onclick="event.stopPropagation();App._removeConsolidatedImage();return false;" style="color:var(--accent)">Remove</a></div>`;
    } else {
      drop.innerHTML = '📷 Click to upload product image';
    }
  },

  _setConsolidatedFmt(fmt) {
    this._consolidated.fmt = fmt;
    const exBtn = document.getElementById('cr-fmt-excel');
    const pdBtn = document.getElementById('cr-fmt-pdf');
    if (exBtn) exBtn.classList.toggle('active', fmt === 'excel');
    if (pdBtn) pdBtn.classList.toggle('active', fmt === 'pdf');
  },

  /* Compute per-worksheet costing data for the consolidated report.
     Returns an array of components; skips worksheets without nestResults.
     Also returns aggregate totals.                                       */
  _collectAllWorksheetsCosting() {
    const components = [];
    let grandTotal = 0;
    let totalPieces = 0;
    let grandSheetAreaMm = 0;
    let grandPartsAreaMm = 0;
    let grandSheetCount = 0;

    for (let i = 0; i < App._worksheets.length; i++) {
      const ws = App._worksheets[i];
      if (!ws || !ws.nestResult || ws.nestResult.placed === 0) continue;
      const c = ws.cost || {};
      const unit = c.unit || 'sqdm';
      const price = parseFloat(c.price) || 0;
      const mode = c.mode || 'piece';
      // Use nestResult's settings — stored in the nestResult itself
      const sheetW = ws.nestResult.usableW ? (ws.nestResult.usableW + 2 * (ws.nestResult.margin || 0)) : 0;
      // More reliable: get from nestResult directly
      const result = ws.nestResult;
      // Compute areas
      const placementSheetAreaMm = (result.usableW && result.usableH)
        ? (result.usableW + 2*0) * (result.usableH + 2*0) * result.sheetCount
        : 0;
      // Fall back: compute from placements bbox if sheet dims missing
      let trueSheetW = 0, trueSheetH = 0;
      if (ws.cost && ws.cost.sheetW) { trueSheetW = ws.cost.sheetW; trueSheetH = ws.cost.sheetH; }
      // The cleanest: use the settings stored on the result via usableW/H + margin
      // We don't store margin directly; use the one at nesting time. Fall back to
      // using placement bounding box extent.
      let sheetAreaMm = 0;
      if (result.usableW && result.usableH) {
        // usableW+2m × usableH+2m is the full sheet; but we only know usable.
        // Good enough for consolidated total — use usable area (what was actually
        // available for parts). For a proper "total material cost" we'd want full
        // sheet, but we don't have margin here; use usable.
        sheetAreaMm = result.usableW * result.usableH * result.sheetCount;
      } else {
        // Approx from placements
        let mnx=Infinity, mny=Infinity, mxx=-Infinity, mxy=-Infinity;
        for (const p of result.placements) {
          const bb = polyBBox(p.pts);
          const x0 = p.x + bb.x, y0 = p.y + bb.y;
          if (x0 < mnx) mnx = x0;
          if (y0 < mny) mny = y0;
          if (x0 + bb.w > mxx) mxx = x0 + bb.w;
          if (y0 + bb.h > mxy) mxy = y0 + bb.h;
        }
        sheetAreaMm = isFinite(mnx) ? (mxx-mnx)*(mxy-mny) * result.sheetCount : 0;
      }
      const partsAreaMm = result.placements.reduce((s, p) => s + polyArea(p.pts), 0);
      const util = sheetAreaMm > 0 ? (partsAreaMm / sheetAreaMm) : 0;
      const count = mode === 'pair' ? (result.placed / 2) : result.placed;
      const sheetAreaInUnit = App._mmSqToUnit(sheetAreaMm, unit);
      const norm = count > 0 ? sheetAreaInUnit / count : 0;
      const costPer = norm * price;
      const total = sheetAreaInUnit * price;

      components.push({
        wsIndex: i,
        wsName: ws.name,
        component: (c.component || ws.name).trim(),
        material: (c.material || '(unspecified)').trim(),
        unit: unit,
        uLbl: App._unitLabel(unit),
        price: price,
        mode: mode,
        placed: result.placed,
        count: count,
        sheetCount: result.sheetCount,
        sheetAreaInUnit: sheetAreaInUnit,
        norm: norm,
        costPer: costPer,
        total: total,
        util: util * 100,
        wastePct: (1 - util) * 100,
        // Layout image rendered from the stored ws state (no active-sheet switch)
        layoutImage: App._renderWorksheetLayoutToDataURL(ws, 1000, 700),
      });

      grandTotal     += total;
      totalPieces    += result.placed;
      grandSheetAreaMm += sheetAreaMm;
      grandPartsAreaMm += partsAreaMm;
      grandSheetCount += result.sheetCount;
    }

    // Grand util
    const grandUtil = grandSheetAreaMm > 0 ? (grandPartsAreaMm / grandSheetAreaMm) * 100 : 0;

    // Cost per pair: sum of per-component costPer (if all in 'pair' mode)
    // If mixed: convert everything to per-piece then divide by 2
    let costPerPair = 0;
    let allPairMode = components.length > 0 && components.every(c => c.mode === 'pair');
    if (allPairMode) {
      costPerPair = components.reduce((s, c) => s + c.costPer, 0);
    } else {
      // Fallback: sum of per-piece costs × 2 (rough estimate — one pair = 2 pieces)
      costPerPair = components.reduce((s, c) => {
        const perPiece = c.mode === 'pair' ? c.costPer / 2 : c.costPer;
        return s + perPiece;
      }, 0) * 2;
    }

    return {
      components,
      grandTotal,
      totalPieces,
      grandSheetAreaMm,
      grandPartsAreaMm,
      grandUtil,
      grandWastePct: 100 - grandUtil,
      grandSheetCount,
      costPerPair,
      allPairMode,
    };
  },

  _renderConsolidatedWSPreview() {
    const host = document.getElementById('cr-ws-preview');
    host.innerHTML = '';
    const data = this._collectAllWorksheetsCosting();
    if (data.components.length === 0) {
      host.innerHTML = '<div style="font-size:11px;color:var(--yellow);font-family:var(--font-mono)">⚠ No nested worksheets found. Run nesting on at least one sheet before exporting.</div>';
      return;
    }
    for (const c of data.components) {
      const row = document.createElement('div');
      row.className = 'cr-preview-item';
      row.innerHTML = `
        <span><b>${this._escAttr(c.component)}</b> — ${c.placed} pcs (${c.material})</span>
        <span>₹${c.total.toLocaleString('en-IN',{maximumFractionDigits:2,minimumFractionDigits:2})}</span>`;
      host.appendChild(row);
    }
    const totalRow = document.createElement('div');
    totalRow.className = 'cr-preview-item';
    totalRow.style.borderTop = '1px dashed var(--border2)';
    totalRow.style.paddingTop = '6px';
    totalRow.style.marginTop = '4px';
    totalRow.innerHTML = `
      <span><b>GRAND TOTAL</b> (${data.components.length} component${data.components.length!==1?'s':''})</span>
      <span style="color:var(--green);font-weight:700">₹${data.grandTotal.toLocaleString('en-IN',{maximumFractionDigits:2,minimumFractionDigits:2})}</span>`;
    host.appendChild(totalRow);
    if (data.allPairMode) {
      const perPair = document.createElement('div');
      perPair.className = 'cr-preview-item';
      perPair.innerHTML = `
        <span>Cost per pair (all components combined)</span>
        <span style="color:var(--accent);font-weight:700">₹${data.costPerPair.toLocaleString('en-IN',{maximumFractionDigits:2,minimumFractionDigits:2})}</span>`;
      host.appendChild(perPair);
    }
  },

  async _downloadConsolidatedReport() {
    this._saveConsolidatedInputs();
    const data = this._collectAllWorksheetsCosting();
    if (data.components.length === 0) {
      alert('No nested worksheets found. Run nesting on at least one sheet first.');
      return;
    }
    const meta = {
      ...this._consolidated,
      date: new Date(),
    };
    const d = meta.date;
    const pad = n => String(n).padStart(2,'0');
    meta.dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    meta.timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    meta.pad = pad;

    if (this._consolidated.fmt === 'pdf') {
      await this._exportConsolidatedPDF(meta, data);
    } else {
      await this._exportConsolidatedExcel(meta, data);
    }
    this._closeConsolidatedDialog();
  },



  // Convert sq.mm to the user-selected price unit

  /* ══════════════════════════════════════════════════════════════════
     CONSOLIDATED EXCEL EXPORT
     One article, multiple components (one per worksheet)
     ═════════════════════════════════════════════════════════════════ */
  async _exportConsolidatedExcel(meta, data) {
    if (typeof ExcelJS === 'undefined') {
      alert('Excel library failed to load.');
      return;
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NestForge Pro';
    wb.created = new Date();

    const ws = wb.addWorksheet('Article Costing', {
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 }
    });

    // 7 columns
    ws.columns = [
      { width: 24 },  // Component name
      { width: 18 },  // Material
      { width: 10 },  // Pieces
      { width: 14 },  // Norm
      { width: 13 },  // Price
      { width: 14 },  // Cost/unit
      { width: 16 },  // Total
    ];

    const COLORS = {
      brandOrange: 'FFEA580C', brandDark: 'FFC2410C', textDark: 'FF1F2937',
      textMuted:   'FF6B7280', bgLight:   'FFFAFAFA', bgStripe:  'FFF3F4F6',
      border:      'FFD1D5DB', borderDark:'FF9CA3AF', green:     'FF16A34A',
      yellow:      'FFCA8A04', blue:      'FF2563EB', white:     'FFFFFFFF',
    };
    const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const borderAll = (color=COLORS.border) => ({
      top:    { style: 'thin', color: { argb: color } },
      bottom: { style: 'thin', color: { argb: color } },
      left:   { style: 'thin', color: { argb: color } },
      right:  { style: 'thin', color: { argb: color } },
    });

    let r = 1;

    // ── HEADER BANNER ──
    ws.mergeCells(r, 1, r, 5);
    const brandCell = ws.getCell(r, 1);
    brandCell.value = meta.brand || 'ARTICLE COSTING REPORT';
    brandCell.font = { bold: true, size: 22, color: { argb: COLORS.white } };
    brandCell.fill = fill(COLORS.brandOrange);
    brandCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
    ws.mergeCells(r, 6, r, 7);
    const dateCell = ws.getCell(r, 6);
    dateCell.value = meta.dateStr + '  ' + meta.timeStr;
    dateCell.font = { bold: true, size: 11, color: { argb: COLORS.white } };
    dateCell.fill = fill(COLORS.brandOrange);
    dateCell.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
    ws.getRow(r).height = 36;
    r++;

    // Article subtitle row
    ws.mergeCells(r, 1, r, 5);
    const articleCell = ws.getCell(r, 1);
    articleCell.value = meta.article || '(unnamed article)';
    articleCell.font = { bold: true, size: 14, color: { argb: COLORS.textDark } };
    articleCell.fill = fill(COLORS.bgLight);
    articleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
    ws.mergeCells(r, 6, r, 7);
    const rightCell = ws.getCell(r, 6);
    rightCell.value = (meta.buyer ? 'Buyer: ' + meta.buyer : '') +
                      (meta.order ? (meta.buyer ? '   ' : '') + 'Order: ' + meta.order : '');
    rightCell.font = { italic: true, size: 11, color: { argb: COLORS.textMuted } };
    rightCell.fill = fill(COLORS.bgLight);
    rightCell.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
    ws.getRow(r).height = 24;
    r++;

    ws.getRow(r).height = 6; r++;

    // ── PRODUCT IMAGE ──
    if (meta.productImage) {
      const imgRowStart = r;
      const imgRows = 12;
      for (let i = 0; i < imgRows; i++) ws.getRow(r + i).height = 17;
      try {
        const du = meta.productImage.dataURL;
        const ext = du.startsWith('data:image/png') ? 'png' : 'jpeg';
        const imgId = wb.addImage({ base64: du.split(',')[1], extension: ext });
        const maxW = 360, maxH = 200;
        const ratio = meta.productImage.width / meta.productImage.height;
        let dispW = maxW, dispH = maxW / ratio;
        if (dispH > maxH) { dispH = maxH; dispW = maxH * ratio; }
        ws.addImage(imgId, {
          tl: { col: 2, row: imgRowStart - 0.5 },
          ext: { width: dispW, height: dispH }
        });
      } catch (e) { console.warn('Image embed failed:', e); }
      r += imgRows;
      ws.getRow(r).height = 6; r++;
    }

    // ── SUMMARY DASHBOARD ──
    ws.mergeCells(r, 1, r, 7);
    const dh = ws.getCell(r, 1);
    dh.value = 'SUMMARY';
    dh.font = { bold: true, size: 11, color: { argb: COLORS.white } };
    dh.fill = fill(COLORS.brandDark);
    dh.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(r).height = 20;
    r++;

    const paintTile = (startRow, startCol, endCol, label, value, color) => {
      ws.mergeCells(startRow, startCol, startRow, endCol);
      const lc = ws.getCell(startRow, startCol);
      lc.value = label;
      lc.font = { bold: true, size: 9, color: { argb: COLORS.textMuted } };
      lc.alignment = { vertical: 'middle', horizontal: 'center' };
      lc.fill = fill(COLORS.bgLight);
      lc.border = {
        top:   { style: 'medium', color: { argb: color } },
        left:  { style: 'thin',   color: { argb: COLORS.border } },
        right: { style: 'thin',   color: { argb: COLORS.border } },
      };
      ws.getRow(startRow).height = 18;
      ws.mergeCells(startRow + 1, startCol, startRow + 1, endCol);
      const vc = ws.getCell(startRow + 1, startCol);
      vc.value = value;
      vc.font = { bold: true, size: 16, color: { argb: color } };
      vc.alignment = { vertical: 'middle', horizontal: 'center' };
      vc.fill = fill(COLORS.bgLight);
      vc.border = {
        bottom: { style: 'thin', color: { argb: COLORS.border } },
        left:   { style: 'thin', color: { argb: COLORS.border } },
        right:  { style: 'thin', color: { argb: COLORS.border } },
      };
      ws.getRow(startRow + 1).height = 30;
    };

    // 2x2 tile grid (7 cols → use 1-4 and 5-7 for first row; then same for second)
    // Actually use 4 tiles: cols 1-2, 3-4, 5-6, 7. Simpler: 4 tiles in pairs.
    // Let's split into 2x2: row1 = tile1(1-4), tile2(5-7); row2 = tile3(1-4), tile4(5-7)
    const fmtINR = (n) => '₹' + Number(n).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    paintTile(r, 1, 4, 'GRAND TOTAL COST', fmtINR(data.grandTotal), COLORS.green);
    paintTile(r, 5, 7, 'TOTAL PIECES', String(data.totalPieces), COLORS.blue);
    r += 2;
    paintTile(r, 1, 4, 'COMPONENTS',
      String(data.components.length) + (data.allPairMode ? '   (per-pair: ' + fmtINR(data.costPerPair) + ')' : ''),
      COLORS.brandOrange);
    paintTile(r, 5, 7, 'OVERALL UTIL', data.grandUtil.toFixed(1) + ' %', COLORS.yellow);
    r += 2;
    ws.getRow(r).height = 8; r++;

    // ── ARTICLE DETAILS box ──
    const sectionTitle = (text) => {
      ws.mergeCells(r, 1, r, 7);
      const t = ws.getCell(r, 1);
      t.value = text;
      t.font = { bold: true, size: 11, color: { argb: COLORS.white } };
      t.fill = fill(COLORS.brandOrange);
      t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(r).height = 20;
      r++;
    };
    const kvRow = (key, value, stripe) => {
      ws.mergeCells(r, 1, r, 2);
      const kc = ws.getCell(r, 1);
      kc.value = key;
      kc.font = { bold: true, size: 10, color: { argb: COLORS.textMuted } };
      kc.alignment = { vertical: 'middle', indent: 1 };
      kc.fill = fill(stripe ? COLORS.bgStripe : COLORS.white);
      kc.border = {
        bottom: { style: 'thin', color: { argb: COLORS.border } },
        left:   { style: 'thin', color: { argb: COLORS.border } },
      };
      ws.mergeCells(r, 3, r, 7);
      const vc = ws.getCell(r, 3);
      vc.value = value;
      vc.font = { size: 10, color: { argb: COLORS.textDark } };
      vc.alignment = { vertical: 'middle', indent: 1 };
      vc.fill = fill(stripe ? COLORS.bgStripe : COLORS.white);
      vc.border = {
        bottom: { style: 'thin', color: { argb: COLORS.border } },
        right:  { style: 'thin', color: { argb: COLORS.border } },
      };
      ws.getRow(r).height = 18;
      r++;
    };

    sectionTitle('ARTICLE DETAILS');
    let s = false;
    if (meta.brand)    { kvRow('Brand',    meta.brand,    s); s = !s; }
    if (meta.article)  { kvRow('Article',  meta.article,  s); s = !s; }
    if (meta.buyer)    { kvRow('Buyer',    meta.buyer,    s); s = !s; }
    if (meta.order)    { kvRow('Order #',  meta.order,    s); s = !s; }
    if (meta.season)   { kvRow('Season',   meta.season,   s); s = !s; }
    if (meta.operator) { kvRow('Prepared by', meta.operator, s); s = !s; }
    for (const sp of (meta.specs || [])) {
      kvRow(sp.key || '(field)', sp.value, s); s = !s;
    }
    ws.getRow(r).height = 8; r++;

    // ── COMPONENT BREAKDOWN TABLE (the main content) ──
    sectionTitle('COMPONENT COSTING BREAKDOWN');

    // Table header
    const headers = ['Component', 'Material', 'Pieces', 'Norm / ' + (data.allPairMode ? 'pair' : 'piece'), 'Price', 'Cost / ' + (data.allPairMode ? 'pair' : 'piece'), 'Total'];
    for (let i = 0; i < 7; i++) {
      const cell = ws.getCell(r, i + 1);
      cell.value = headers[i];
      cell.font = { bold: true, size: 10, color: { argb: COLORS.textDark } };
      cell.fill = fill(COLORS.bgStripe);
      cell.alignment = { vertical: 'middle', horizontal: i <= 1 ? 'left' : 'right', indent: 1 };
      cell.border = borderAll(COLORS.borderDark);
    }
    ws.getRow(r).height = 22;
    r++;

    let stripe = false;
    for (const comp of data.components) {
      const row = ws.getRow(r);
      const vals = [
        comp.component,
        comp.material,
        comp.placed,
        comp.norm.toFixed(3) + ' ' + comp.uLbl,
        '₹' + comp.price.toFixed(2) + '/' + comp.uLbl,
        fmtINR(comp.costPer),
        fmtINR(comp.total),
      ];
      for (let i = 0; i < 7; i++) {
        const cell = ws.getCell(r, i + 1);
        cell.value = vals[i];
        cell.font = { size: 10, color: { argb: COLORS.textDark }, bold: i === 0 || i === 6 };
        cell.fill = fill(stripe ? COLORS.bgStripe : COLORS.white);
        cell.alignment = { vertical: 'middle', horizontal: i <= 1 ? 'left' : 'right', indent: 1 };
        cell.border = borderAll(COLORS.border);
        if (i === 6) cell.font = { size: 10, bold: true, color: { argb: COLORS.green } };
      }
      ws.getRow(r).height = 20;
      stripe = !stripe;
      r++;
    }

    // Grand total row
    for (let i = 0; i < 7; i++) {
      const cell = ws.getCell(r, i + 1);
      cell.fill = fill(COLORS.green);
      cell.font = { bold: true, size: 11, color: { argb: COLORS.white } };
      cell.alignment = { vertical: 'middle', horizontal: i <= 1 ? 'left' : 'right', indent: 1 };
      cell.border = borderAll(COLORS.green);
    }
    ws.getCell(r, 1).value = 'GRAND TOTAL';
    ws.getCell(r, 3).value = data.totalPieces;
    ws.getCell(r, 7).value = fmtINR(data.grandTotal);
    ws.getRow(r).height = 26;
    r++;

    // Per-pair total row (if applicable)
    if (data.allPairMode) {
      for (let i = 0; i < 7; i++) {
        const cell = ws.getCell(r, i + 1);
        cell.fill = fill(COLORS.bgLight);
        cell.font = { bold: true, size: 10, color: { argb: COLORS.brandDark } };
        cell.alignment = { vertical: 'middle', horizontal: i <= 1 ? 'left' : 'right', indent: 1 };
        cell.border = borderAll(COLORS.borderDark);
      }
      ws.getCell(r, 1).value = 'COST PER PAIR (all components)';
      ws.getCell(r, 7).value = fmtINR(data.costPerPair);
      ws.getRow(r).height = 22;
      r++;
    }

    ws.getRow(r).height = 8; r++;

    // ── NESTED LAYOUTS — one image per component ──
    const componentsWithImages = data.components.filter(c => c.layoutImage);
    if (componentsWithImages.length > 0) {
      sectionTitle('NESTED LAYOUTS');
      for (const comp of componentsWithImages) {
        // Sub-header row for this component
        ws.mergeCells(r, 1, r, 7);
        const ch = ws.getCell(r, 1);
        ch.value = comp.component + '   —   ' + comp.placed + ' pcs' +
                   '   •   ' + comp.util.toFixed(1) + '% util' +
                   '   •   ' + fmtINR(comp.total);
        ch.font = { bold: true, size: 10, color: { argb: COLORS.textDark } };
        ch.fill = fill(COLORS.bgLight);
        ch.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        ch.border = {
          top:    { style: 'thin',   color: { argb: COLORS.border } },
          bottom: { style: 'medium', color: { argb: COLORS.brandOrange } },
          left:   { style: 'thin',   color: { argb: COLORS.border } },
          right:  { style: 'thin',   color: { argb: COLORS.border } },
        };
        ws.getRow(r).height = 18;
        r++;

        // Reserve rows for the image (about 15 rows = ~260px tall)
        try {
          const du = comp.layoutImage;
          const ext = du.startsWith('data:image/png') ? 'png' : 'jpeg';
          const imgId = wb.addImage({ base64: du.split(',')[1], extension: ext });
          const imgRowStart = r;
          const imgRows = 18;
          for (let i = 0; i < imgRows; i++) ws.getRow(r + i).height = 17;
          // Image spans most of width (7 cols), centered
          ws.addImage(imgId, {
            tl: { col: 0.3, row: imgRowStart - 0.3 },
            ext: { width: 600, height: 300 }
          });
          r += imgRows;
        } catch (e) {
          console.warn('Could not embed layout image for', comp.component, e);
        }
        ws.getRow(r).height = 6; r++;
      }
      ws.getRow(r).height = 6; r++;
    }

    // ── NOTES section (if any) ──
    if (meta.notes && meta.notes.trim()) {
      sectionTitle('NOTES / REMARKS');
      ws.mergeCells(r, 1, r, 7);
      const nc = ws.getCell(r, 1);
      nc.value = meta.notes;
      nc.font = { size: 10, color: { argb: COLORS.textDark } };
      nc.alignment = { vertical: 'top', horizontal: 'left', indent: 1, wrapText: true };
      nc.fill = fill(COLORS.white);
      nc.border = borderAll(COLORS.border);
      const noteLines = Math.max(2, Math.ceil(meta.notes.length / 90));
      ws.getRow(r).height = Math.min(100, 18 * noteLines);
      r++;
      ws.getRow(r).height = 8; r++;
    }

    // ── FOOTER ──
    ws.mergeCells(r, 1, r, 7);
    const foot = ws.getCell(r, 1);
    foot.value = 'Generated by NestForge Pro — ' + meta.dateStr + ' ' + meta.timeStr
               + (data.components.length > 0 ? '  •  ' + data.components.length + ' components, ' + data.totalPieces + ' pieces' : '');
    foot.font = { italic: true, size: 9, color: { argb: COLORS.textMuted } };
    foot.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(r).height = 18;
    r++;

    // ── SHEET 2: Raw data per component ──
    const ws2 = wb.addWorksheet('Raw Data');
    ws2.columns = [
      { header: 'Component', key: 'comp', width: 22 },
      { header: 'Material', key: 'mat', width: 18 },
      { header: 'Pieces', key: 'pcs', width: 10 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Price', key: 'price', width: 12 },
      { header: 'Norm', key: 'norm', width: 14 },
      { header: 'Cost/' + (data.allPairMode ? 'pair' : 'piece'), key: 'costper', width: 14 },
      { header: 'Total', key: 'total', width: 14 },
      { header: 'Util %', key: 'util', width: 10 },
      { header: 'Sheets used', key: 'sheets', width: 12 },
    ];
    for (const c of data.components) {
      ws2.addRow({
        comp: c.component, mat: c.material, pcs: c.placed, unit: c.uLbl,
        price: c.price, norm: +c.norm.toFixed(4),
        costper: +c.costPer.toFixed(2), total: +c.total.toFixed(2),
        util: +c.util.toFixed(2), sheets: c.sheetCount,
      });
    }
    ws2.addRow({ comp: 'TOTAL', pcs: data.totalPieces, total: +data.grandTotal.toFixed(2), util: +data.grandUtil.toFixed(2), sheets: data.grandSheetCount });
    ws2.getRow(1).font = { bold: true };
    ws2.getRow(1).fill = fill(COLORS.bgStripe);
    ws2.getRow(ws2.rowCount).font = { bold: true };
    ws2.getRow(ws2.rowCount).fill = fill(COLORS.bgLight);

    // Download
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const slug = ((meta.brand || 'article') + '_' + (meta.article || 'costing'))
      .toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,48);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}_consolidated_${meta.date.getFullYear()}${meta.pad(meta.date.getMonth()+1)}${meta.pad(meta.date.getDate())}.xlsx`;
    a.click();
  },

  /* ══════════════════════════════════════════════════════════════════
     CONSOLIDATED PDF EXPORT
     ═════════════════════════════════════════════════════════════════ */
  async _exportConsolidatedPDF(meta, data) {
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      alert('PDF library failed to load.');
      return;
    }
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 12, CW = W - 2*M;
    let y = 0;

    const C = {
      brandOrange: [234, 88, 12],  brandDark: [194, 65, 12],
      textDark:   [31, 41, 55],    textMuted: [107, 114, 128],
      bgLight:    [250, 250, 250], bgStripe:  [243, 244, 246],
      border:     [209, 213, 219], borderDark:[156, 163, 175],
      green:      [22, 163, 74],   yellow:    [202, 138, 4],
      blue:       [37, 99, 235],   white:     [255, 255, 255],
    };
    const setFill = ([r,g,b]) => pdf.setFillColor(r, g, b);
    const setText = ([r,g,b]) => pdf.setTextColor(r, g, b);
    const setDraw = ([r,g,b]) => pdf.setDrawColor(r, g, b);
    const ensureSpace = (needed) => { if (y + needed > H - M) { pdf.addPage(); y = M; } };
    const fmtINR = (n) => '\u20B9' + Number(n).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    // ── HEADER BANNER ──
    setFill(C.brandOrange);
    pdf.rect(0, 0, W, 22, 'F');
    setText(C.white);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(20);
    pdf.text(meta.brand || 'ARTICLE COSTING', M, 11);
    pdf.setFontSize(10);
    pdf.text(meta.dateStr + '   ' + meta.timeStr, W - M, 11, { align: 'right' });
    pdf.setFontSize(12);
    pdf.text(meta.article || '(unnamed article)', M, 18);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    const rightText = (meta.buyer ? 'Buyer: ' + meta.buyer : '') +
                      (meta.order ? (meta.buyer ? '   ' : '') + 'Order: ' + meta.order : '');
    if (rightText) pdf.text(rightText, W - M, 18, { align: 'right' });
    y = 22;
    setFill(C.bgLight);
    pdf.rect(0, y, W, 3, 'F');
    y += 6;

    // ── PRODUCT IMAGE ──
    if (meta.productImage) {
      try {
        const maxImgH = 55;
        const ratio = meta.productImage.width / meta.productImage.height;
        let imgH = maxImgH;
        let imgW = imgH * ratio;
        if (imgW > CW * 0.8) { imgW = CW * 0.8; imgH = imgW / ratio; }
        ensureSpace(imgH + 4);
        const imgX = (W - imgW) / 2;
        const fmt = meta.productImage.dataURL.startsWith('data:image/png') ? 'PNG' : 'JPEG';
        pdf.addImage(meta.productImage.dataURL, fmt, imgX, y, imgW, imgH, undefined, 'FAST');
        y += imgH + 4;
      } catch (e) { console.warn('Image embed failed:', e); }
    }

    // ── KPI DASHBOARD (4 tiles) ──
    ensureSpace(38);
    setFill(C.brandDark);
    pdf.rect(M, y, CW, 6, 'F');
    setText(C.white);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text('SUMMARY', M + 2, y + 4);
    y += 7;

    const drawTile = (tx, ty, tw, th, label, value, accentColor) => {
      setFill(accentColor);
      pdf.rect(tx, ty, tw, 1.2, 'F');
      setFill(C.bgLight);
      pdf.rect(tx, ty + 1.2, tw, th - 1.2, 'F');
      setDraw(C.border);
      pdf.setLineWidth(0.2);
      pdf.rect(tx, ty, tw, th);
      setText(C.textMuted);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7);
      pdf.text(label, tx + tw/2, ty + 5, { align: 'center' });
      setText(accentColor);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(13);
      pdf.text(value, tx + tw/2, ty + 13, { align: 'center' });
    };

    const tileW = (CW - 4) / 2;
    const tileH = 18;
    drawTile(M, y, tileW, tileH, 'GRAND TOTAL COST', fmtINR(data.grandTotal), C.green);
    drawTile(M + tileW + 4, y, tileW, tileH, 'TOTAL PIECES', String(data.totalPieces), C.blue);
    y += tileH + 2;
    drawTile(M, y, tileW, tileH, 'COMPONENTS', String(data.components.length), C.brandOrange);
    drawTile(M + tileW + 4, y, tileW, tileH, 'OVERALL UTILIZATION', data.grandUtil.toFixed(1) + ' %', C.yellow);
    y += tileH + 6;

    // ── HELPERS ──
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
    const kvRow = (key, value) => {
      ensureSpace(6);
      const rowH = 5.5;
      setFill(stripe ? C.bgStripe : C.white);
      pdf.rect(M, y - 1, CW, rowH, 'F');
      setDraw(C.border);
      pdf.setLineWidth(0.1);
      pdf.line(M, y + rowH - 1, M + CW, y + rowH - 1);
      setText(C.textMuted);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(String(key), M + 2, y + 2.5);
      setText(C.textDark);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.text(String(value), M + 55, y + 2.5);
      y += rowH;
      stripe = !stripe;
    };

    // ── ARTICLE DETAILS ──
    section('ARTICLE DETAILS');
    stripe = false;
    if (meta.brand)    kvRow('Brand', meta.brand);
    if (meta.article)  kvRow('Article', meta.article);
    if (meta.buyer)    kvRow('Buyer', meta.buyer);
    if (meta.order)    kvRow('Order #', meta.order);
    if (meta.season)   kvRow('Season', meta.season);
    if (meta.operator) kvRow('Prepared by', meta.operator);
    for (const s of (meta.specs || [])) kvRow(s.key || '(field)', s.value);
    y += 3;

    // ── COMPONENT COSTING TABLE ──
    section('COMPONENT COSTING BREAKDOWN');

    // Column layout (mm): comp, material, pieces, norm, cost/piece, total
    const tCols = [
      { x: M + 2,         w: 42, label: 'Component',   align: 'left'  },
      { x: M + 44,        w: 32, label: 'Material',    align: 'left'  },
      { x: M + 76,        w: 18, label: 'Pieces',      align: 'right' },
      { x: M + 94,        w: 28, label: 'Norm',        align: 'right' },
      { x: M + 122,       w: 28, label: 'Cost/' + (data.allPairMode ? 'pair' : 'piece'), align: 'right' },
      { x: M + 150,       w: CW - 148, label: 'Total', align: 'right' },
    ];

    // Table header
    ensureSpace(8);
    setFill(C.bgStripe);
    pdf.rect(M, y, CW, 6, 'F');
    setDraw(C.borderDark);
    pdf.setLineWidth(0.3);
    pdf.rect(M, y, CW, 6);
    setText(C.textDark);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    for (const col of tCols) {
      const tx = col.align === 'right' ? col.x + col.w - 2 : col.x;
      pdf.text(col.label, tx, y + 4, { align: col.align });
    }
    y += 6;

    let pbStripe = false;
    for (const c of data.components) {
      ensureSpace(7);
      const rowH = 6;
      setFill(pbStripe ? C.bgStripe : C.white);
      pdf.rect(M, y, CW, rowH, 'F');
      setDraw(C.border);
      pdf.setLineWidth(0.1);
      pdf.line(M, y + rowH, M + CW, y + rowH);
      const vals = [
        String(c.component).slice(0, 24),
        String(c.material).slice(0, 20),
        String(c.placed),
        c.norm.toFixed(3) + ' ' + c.uLbl,
        fmtINR(c.costPer),
        fmtINR(c.total),
      ];
      for (let i = 0; i < tCols.length; i++) {
        setText(C.textDark);
        pdf.setFont('helvetica', i === 0 ? 'bold' : (i === tCols.length - 1 ? 'bold' : 'normal'));
        pdf.setFontSize(9);
        if (i === tCols.length - 1) setText(C.green);
        const col = tCols[i];
        const tx = col.align === 'right' ? col.x + col.w - 2 : col.x;
        pdf.text(vals[i], tx, y + 4, { align: col.align });
      }
      y += rowH;
      pbStripe = !pbStripe;
    }

    // Grand total row
    ensureSpace(9);
    setFill(C.green);
    pdf.rect(M, y, CW, 8, 'F');
    setText(C.white);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('GRAND TOTAL', tCols[0].x, y + 5);
    pdf.text(String(data.totalPieces), tCols[2].x + tCols[2].w - 2, y + 5, { align: 'right' });
    pdf.text(fmtINR(data.grandTotal), tCols[5].x + tCols[5].w - 2, y + 5, { align: 'right' });
    y += 8;

    // Per-pair row
    if (data.allPairMode) {
      ensureSpace(8);
      setFill(C.bgLight);
      pdf.rect(M, y, CW, 7, 'F');
      setDraw(C.borderDark);
      pdf.setLineWidth(0.2);
      pdf.rect(M, y, CW, 7);
      setText(C.brandDark);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text('COST PER PAIR (all components)', tCols[0].x, y + 4.5);
      pdf.text(fmtINR(data.costPerPair), tCols[5].x + tCols[5].w - 2, y + 4.5, { align: 'right' });
      y += 7;
    }
    y += 4;

    // ── NESTED LAYOUTS — one per component on its own or shared page ──
    const componentsWithImages = data.components.filter(c => c.layoutImage);
    if (componentsWithImages.length > 0) {
      // Put layouts on fresh page(s) for clarity. Each layout gets ~half a page.
      pdf.addPage();
      y = M;
      // Page title
      setFill(C.brandOrange);
      pdf.rect(M, y, CW, 8, 'F');
      setText(C.white);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.text('NESTED LAYOUTS', M + 2, y + 5.5);
      y += 11;

      // Each layout: component header (6mm) + image (~100mm tall) + 6mm gap = 112mm
      // Fits 2 layouts per A4 page (297mm - 24mm margins = 273mm usable)
      const layoutH = 100;  // image height in mm
      const layoutW = CW;

      for (const comp of componentsWithImages) {
        // If this layout won't fit, new page
        if (y + layoutH + 10 > H - M) {
          pdf.addPage();
          y = M;
        }

        // Component header bar
        setFill(C.bgLight);
        pdf.rect(M, y, CW, 7, 'F');
        setDraw(C.brandOrange);
        pdf.setLineWidth(0.8);
        pdf.line(M, y + 7, M + CW, y + 7);
        setText(C.textDark);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(10);
        pdf.text(comp.component, M + 2, y + 5);
        setText(C.textMuted);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        const hdrRight = comp.placed + ' pcs  •  ' + comp.util.toFixed(1) + '% util  •  ' + fmtINR(comp.total);
        pdf.text(hdrRight, W - M - 2, y + 5, { align: 'right' });
        y += 8;

        // Image
        try {
          const fmt = comp.layoutImage.startsWith('data:image/png') ? 'PNG' : 'JPEG';
          pdf.addImage(comp.layoutImage, fmt, M, y, layoutW, layoutH, undefined, 'FAST');
          // Border around the image
          setDraw(C.border);
          pdf.setLineWidth(0.2);
          pdf.rect(M, y, layoutW, layoutH);
        } catch (e) {
          console.warn('Could not add layout for', comp.component, e);
        }
        y += layoutH + 6;
      }
    }

    // ── NOTES ──
    if (meta.notes && meta.notes.trim()) {
      section('NOTES / REMARKS');
      ensureSpace(20);
      setText(C.textDark);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      const noteLines = pdf.splitTextToSize(meta.notes, CW - 4);
      for (const line of noteLines) {
        ensureSpace(5);
        pdf.text(line, M + 2, y + 3);
        y += 4.5;
      }
      y += 3;
    }

    // ── FOOTER on every page ──
    const pageCount = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      pdf.setPage(i);
      setText(C.textMuted);
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(8);
      pdf.text('NestForge Pro  —  ' + meta.dateStr + ' ' + meta.timeStr, M, H - 5);
      pdf.text(`Page ${i} / ${pageCount}`, W - M, H - 5, { align: 'right' });
    }

    const slug = ((meta.brand || 'article') + '_' + (meta.article || 'costing'))
      .toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,48);
    pdf.save(`${slug}_consolidated_${meta.date.getFullYear()}${meta.pad(meta.date.getMonth()+1)}${meta.pad(meta.date.getDate())}.pdf`);
  },
};



