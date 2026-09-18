/*
 * NestForge Pro — ExportManager — DXF/SVG/PDF/PNG export of nested layouts
 *
 * Original location: lines 15995..16282 of nestforge-pro.html (288 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const ExportManager = {

  /* ── EXPORT DIALOG ─────────────────────────────────────────────── */
  _exportFmt: 'svg',

  openExportDialog() {
    if (!this.nestResult) return;
    const modal = document.getElementById('export-modal');
    // Wire stamp-checkbox visibility (once)
    const stampCb = document.getElementById('ex-stamp');
    const stampSub = document.getElementById('ex-stamp-sub');
    const updateStampVis = () => stampSub.classList.toggle('visible', stampCb.checked);
    stampCb.onchange = updateStampVis;
    updateStampVis();
    modal.classList.add('active');
  },

  _closeExportDialog() {
    document.getElementById('export-modal').classList.remove('active');
  },

  _setExportFmt(fmt) {
    this._exportFmt = fmt;
    document.querySelectorAll('.ex-format-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.fmt === fmt));
  },

  _getExportOpts() {
    const stampEnabled = document.getElementById('ex-stamp').checked;
    const allSheetsEl = document.getElementById('ex-allsheets');
    return {
      includeInner: document.getElementById('ex-inner').checked,
      includeLabels: document.getElementById('ex-labels').checked,
      allSheets: allSheetsEl ? allSheetsEl.checked : false,
      stamp: stampEnabled,
      stampPos: document.getElementById('ex-stamp-pos').value,
      stampSize: parseFloat(document.getElementById('ex-stamp-size').value) || 6,
      stampDate: stampEnabled && document.getElementById('ex-stamp-date').checked,
      stampTime: stampEnabled && document.getElementById('ex-stamp-time').checked,
      stampText: document.getElementById('ex-stamp-text').value.trim(),
    };
  },

  _buildStampText(opts) {
    const parts = [];
    if (opts.stampDate || opts.stampTime) {
      const d = new Date();
      const pad = n => String(n).padStart(2,'0');
      const bits = [];
      if (opts.stampDate) bits.push(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
      if (opts.stampTime) bits.push(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
      parts.push(bits.join(' '));
    }
    if (opts.stampText) parts.push(opts.stampText);
    return parts;
  },

  _getStampAnchor(pos, sheetW, sheetH, margin, fontSize, lineCount) {
    const pad = Math.max(margin + 2, fontSize);
    const totalH = fontSize * 1.35 * lineCount;
    switch(pos) {
      case 'tl': return { x: pad, y: pad + fontSize, anchor: 'start',  baseline: 'alphabetic' };
      case 'tr': return { x: sheetW - pad, y: pad + fontSize, anchor: 'end', baseline: 'alphabetic' };
      case 'bl': return { x: pad, y: sheetH - pad - totalH + fontSize, anchor: 'start', baseline: 'alphabetic' };
      case 'br':
      default:   return { x: sheetW - pad, y: sheetH - pad - totalH + fontSize, anchor: 'end', baseline: 'alphabetic' };
    }
  },

  _doExport() {
    const opts = this._getExportOpts();
    this._closeExportDialog();

    // If "all sheets" is on AND we have a multi-sheet result, export each sheet
    // as its own file (nest_sheet_1.svg, nest_sheet_2.svg, …).
    // Otherwise just export the currently-active sheet.
    // PDF is special — when "all sheets" is on, PDF generates a single
    // multi-page file. Other formats (SVG/DXF) download separate files.
    if (this._exportFmt === 'pdf') {
      this._exportPDF(opts);
      return;
    }

    const exportFn = (this._exportFmt === 'dxf')
      ? this._exportDXF.bind(this)
      : this._exportSVG.bind(this);

    if (opts.allSheets && this.nestResult && this.nestResult.sheetCount > 1) {
      const origSheet = Renderer.currentSheet;
      let i = 0;
      const next = () => {
        if (i >= this.nestResult.sheetCount) {
          Renderer.currentSheet = origSheet;
          return;
        }
        Renderer.currentSheet = i;
        exportFn(opts);
        i++;
        setTimeout(next, 250);
      };
      next();
    } else {
      exportFn(opts);
    }
  },

  /* ── VECTOR PDF EXPORT ─────────────────────────────────────────
     Multi-page vector PDF. When "Export all sheets together" is on,
     this combines:
       1. All worksheets (Sheet 1 / Sheet 2 tabs in left sidebar)
       2. All auto-overflow sheets within each worksheet (multi-sheet mode)
     into ONE multi-page PDF — page 1 = WS1/sheet1, page 2 = WS1/sheet2,
     page 3 = WS2/sheet1, etc.

     All shapes drawn as vector paths (jsPDF .lines() command) so the
     result imports into CorelDraw / Illustrator / Inkscape as EDITABLE
     separate objects — each part is a movable polygon, each inner line
     is a movable polyline, each label is a text object.

     Page size: matches each sheet's dimensions in mm (1:1 scale).      */
  _exportPDF(opts) {
    if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
      alert('jsPDF library not loaded — PDF export unavailable.');
      return;
    }
    const jsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;

    // Save current worksheet state so we can switch worksheets non-destructively
    if (typeof this._saveCurrentWS === 'function') this._saveCurrentWS();
    const origActiveWS = (typeof WorksheetManager !== 'undefined') ? WorksheetManager._activeWS : 0;
    const origCurrentSheet = Renderer.currentSheet;

    // Build the list of (worksheetIdx, sheetIdxInWS) tuples to export.
    // Logic:
    //   - If allSheets is OFF → only current worksheet, only current sheet (1 page total)
    //   - If allSheets is ON  → ALL worksheets that have nestResult, ALL their sheets
    const allWorksheets = (typeof WorksheetManager !== 'undefined') ? WorksheetManager._worksheets : [];
    const exportJobs = [];  // [{wsIdx, sheetIdx, ws}]

    if (opts.allSheets && allWorksheets.length > 1) {
      // ALL worksheets that have a nestResult
      for (let wsi = 0; wsi < allWorksheets.length; wsi++) {
        const ws = allWorksheets[wsi];
        if (!ws || !ws.nestResult || !ws.nestResult.placements || ws.nestResult.placements.length === 0) continue;
        // Within each worksheet, count its sheets (auto-overflow sheets)
        const sheetSet = new Set();
        for (const pl of ws.nestResult.placements) sheetSet.add(pl.sheet || 0);
        const wsDistinctSheets = [...sheetSet].sort((a, b) => a - b);
        const wsCount = Math.max(ws.nestResult.sheetCount || 1, wsDistinctSheets.length);
        const sheetsForThisWS = wsDistinctSheets.length > 1
          ? wsDistinctSheets
          : Array.from({ length: wsCount }, (_, i) => i);
        for (const sIdx of sheetsForThisWS) {
          exportJobs.push({ wsIdx: wsi, sheetIdx: sIdx, ws });
        }
      }
    } else if (opts.allSheets && this.nestResult) {
      // Single worksheet but maybe multiple auto-overflow sheets
      const sheetSet = new Set();
      for (const pl of this.nestResult.placements) sheetSet.add(pl.sheet || 0);
      const distinctSheets = [...sheetSet].sort((a, b) => a - b);
      const sheetCount = Math.max(this.nestResult.sheetCount || 1, distinctSheets.length);
      const sheets = distinctSheets.length > 1
        ? distinctSheets
        : Array.from({ length: sheetCount }, (_, i) => i);
      const ws = allWorksheets[origActiveWS] || { name: 'Sheet 1', nestResult: this.nestResult, settings: this.getSettings() };
      for (const sIdx of sheets) {
        exportJobs.push({ wsIdx: origActiveWS, sheetIdx: sIdx, ws });
      }
    } else {
      // Just the currently-visible sheet on currently-active worksheet
      const ws = allWorksheets[origActiveWS] || { name: 'Sheet 1', nestResult: this.nestResult, settings: this.getSettings() };
      if (!this.nestResult) {
        alert('No nest result to export. Run nesting first.');
        return;
      }
      exportJobs.push({ wsIdx: origActiveWS, sheetIdx: origCurrentSheet, ws });
    }

    console.log('[NestForge PDF export]', {
      allSheetsChecked: opts.allSheets,
      totalWorksheets: allWorksheets.length,
      jobs: exportJobs.map(j => ({ ws: j.wsIdx, sheet: j.sheetIdx, wsName: j.ws.name }))
    });

    if (exportJobs.length === 0) {
      alert('Nothing to export. Run nesting first.');
      return;
    }

    // Hex → RGB
    const hexToRgb = (hex) => {
      if (!hex || hex[0] !== '#') return [102, 102, 102];
      let h = hex.slice(1);
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };

    // First job determines first page size
    const firstJob = exportJobs[0];
    const firstSettings = firstJob.ws.settings || this.getSettings();
    const firstW = firstSettings.sheetW;
    const firstH = firstSettings.sheetH;
    const pdf = new jsPDF({
      orientation: firstW > firstH ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [firstW, firstH],
      compress: true
    });

    // Render a single (worksheet, sheet) onto current PDF page
    const renderJob = (job, isFirstPage) => {
      const ws = job.ws;
      const result = ws.nestResult;
      const settings = ws.settings || this.getSettings();
      const sheetW = settings.sheetW;
      const sheetH = settings.sheetH;
      const margin = settings.margin;
      const wsName = ws.name || ('Sheet ' + (job.wsIdx + 1));

      if (!isFirstPage) {
        pdf.addPage([sheetW, sheetH], sheetW > sheetH ? 'landscape' : 'portrait');
      }

      const placements = result.placements.filter(p => (p.sheet || 0) === job.sheetIdx);

      // Sheet outline (light grey border)
      pdf.setDrawColor(204, 204, 204);
      pdf.setLineWidth(0.3);
      pdf.rect(0, 0, sheetW, sheetH, 'S');

      // Usable area dashed border (blue)
      pdf.setDrawColor(102, 136, 255);
      pdf.setLineWidth(0.2);
      pdf.setLineDashPattern([2, 2], 0);
      pdf.rect(margin, margin, sheetW - 2*margin, sheetH - 2*margin, 'S');
      pdf.setLineDashPattern([], 0);

      // Each placement
      for (const pl of placements) {
        const { pts, x, y, color, partName, innerLines } = pl;
        const bbox = polyBBox(pts);
        const dx = x - bbox.x, dy = y - bbox.y;
        const dPts = translatePts(pts, dx, dy);
        const [rgb_r, rgb_g, rgb_b] = hexToRgb(color);

        pdf.setDrawColor(rgb_r, rgb_g, rgb_b);
        pdf.setLineWidth(0.4);

        const start = dPts[0];
        const segs = [];
        for (let i = 1; i < dPts.length; i++) {
          segs.push([dPts[i][0] - dPts[i-1][0], dPts[i][1] - dPts[i-1][1]]);
        }
        pdf.lines(segs, start[0], start[1], [1, 1], 'S', true);

        if (opts.includeInner && innerLines && innerLines.length) {
          for (const il of innerLines) {
            if (!il.pts || il.pts.length < 2) continue;
            const ip = translatePts(il.pts, dx, dy);
            const [ir, ig, ib] = hexToRgb(il.color || '#666');
            pdf.setDrawColor(ir, ig, ib);
            pdf.setLineWidth(0.2);
            const iSegs = [];
            for (let i = 1; i < ip.length; i++) {
              iSegs.push([ip[i][0] - ip[i-1][0], ip[i][1] - ip[i-1][1]]);
            }
            pdf.lines(iSegs, ip[0][0], ip[0][1], [1, 1], 'S', !!il.closed);
          }
        }

        if (opts.includeLabels && partName) {
          pdf.setFontSize(8);
          pdf.setTextColor(rgb_r, rgb_g, rgb_b);
          pdf.text(String(partName), x + bbox.w / 2, y + bbox.h / 2, {
            align: 'center', baseline: 'middle'
          });
        }
      }

      // Stamp
      if (opts.stamp) {
        const lines = this._buildStampText(opts);
        if (lines.length) {
          const size = opts.stampSize;
          const anchor = this._getStampAnchor(opts.stampPos, sheetW, sheetH, margin, size, lines.length);
          pdf.setFontSize(size);
          pdf.setTextColor(34, 34, 34);
          for (let i = 0; i < lines.length; i++) {
            const yPos = anchor.y + i * size * 1.35;
            const align = (anchor.anchor === 'end') ? 'right'
              : (anchor.anchor === 'middle' ? 'center' : 'left');
            pdf.text(String(lines[i]), anchor.x, yPos, { align });
          }
        }
      }

      // Page header: worksheet name + sheet number (only if exporting >1 page)
      if (exportJobs.length > 1) {
        const sheetCount = result.sheetCount || 1;
        pdf.setFontSize(5);
        pdf.setTextColor(150, 150, 150);
        const label = sheetCount > 1
          ? wsName + ' — Sheet ' + (job.sheetIdx + 1) + ' of ' + sheetCount
          : wsName;
        pdf.text(label, sheetW - 2, sheetH - 1, { align: 'right' });
      }
    };

    // Render all jobs
    for (let i = 0; i < exportJobs.length; i++) {
      renderJob(exportJobs[i], i === 0);
    }

    // Filename
    const filename = (exportJobs.length > 1)
      ? 'nest_all_sheets.pdf'
      : 'nest_sheet_' + (exportJobs[0].sheetIdx + 1) + '.pdf';
    pdf.save(filename);
  },

  /* ── SVG EXPORT ────────────────────────────────────────────────── */
  _exportSVG(opts) {
    if (!this.nestResult) return;
    const settings = this.getSettings();
    const sheetIdx = Renderer.currentSheet;
    const placements = this.nestResult.placements.filter(p => p.sheet === sheetIdx);
    const { sheetW, sheetH, margin } = settings;

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}mm" height="${sheetH}mm" viewBox="0 0 ${sheetW} ${sheetH}">
  <rect width="${sheetW}" height="${sheetH}" fill="white" stroke="#ccc" stroke-width="1"/>
  <rect x="${margin}" y="${margin}" width="${sheetW-2*margin}" height="${sheetH-2*margin}" fill="none" stroke="#6688ff" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.4"/>
`;

    for (const pl of placements) {
      const { pts, x, y, color, partName, innerLines } = pl;
      const bbox = polyBBox(pts);
      const dx = x - bbox.x, dy = y - bbox.y;
      const dPts = translatePts(pts, dx, dy);
      const d = dPts.map((p,i) => (i===0?'M':'L')+p[0].toFixed(3)+','+p[1].toFixed(3)).join(' ')+'Z';
      svg += `  <path d="${d}" fill="${color}22" stroke="${color}" stroke-width="0.8"/>\n`;

      if (opts.includeInner && innerLines && innerLines.length) {
        for (const il of innerLines) {
          if (!il.pts || il.pts.length < 2) continue;
          const ip = translatePts(il.pts, dx, dy);
          const id = ip.map((p,i) => (i===0?'M':'L')+p[0].toFixed(3)+','+p[1].toFixed(3)).join(' ') + (il.closed ? 'Z' : '');
          svg += `  <path d="${id}" fill="none" stroke="${il.color||'#666'}" stroke-width="0.4"/>\n`;
        }
      }

      if (opts.includeLabels) {
        svg += `  <text x="${(x+bbox.w/2).toFixed(1)}" y="${(y+bbox.h/2).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="8" fill="${color}">${_escXml(partName)}</text>\n`;
      }
    }

    // Stamp
    if (opts.stamp) {
      const lines = this._buildStampText(opts);
      if (lines.length) {
        const size = opts.stampSize;
        const anchor = this._getStampAnchor(opts.stampPos, sheetW, sheetH, margin, size, lines.length);
        for (let i = 0; i < lines.length; i++) {
          const yPos = anchor.y + i * size * 1.35;
          svg += `  <text x="${anchor.x}" y="${yPos}" text-anchor="${anchor.anchor}" font-family="sans-serif" font-size="${size}" fill="#222">${_escXml(lines[i])}</text>\n`;
        }
      }
    }

    svg += '</svg>';
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nest_sheet_${sheetIdx+1}.svg`;
    a.click();
  },

  /* ── DXF EXPORT ────────────────────────────────────────────────── */
  /* Writes a minimal AutoCAD R12 (AC1009) DXF — broadly compatible with
     every CAD / CAM tool (CorelDraw, AutoCAD, LibreCAD, StudioRIP, Cricut
     Design Space, Inkscape, etc.). Each part outline becomes an
     LWPOLYLINE on layer "PARTS", inner lines go on layer "MARKINGS",
     and the stamp goes on layer "STAMP" as a TEXT entity.
     Origin is bottom-left so most CAM tools open it right-side-up.       */
  _exportDXF(opts) {
    if (!this.nestResult) return;
    const settings = this.getSettings();
    const sheetIdx = Renderer.currentSheet;
    const placements = this.nestResult.placements.filter(p => p.sheet === sheetIdx);
    const { sheetW, sheetH } = settings;

    // DXF Y-axis points UP. Our canvas Y points DOWN. Flip Y on export.
    const flipY = y => sheetH - y;

    const out = [];
    const w = (code, val) => { out.push(String(code)); out.push(String(val)); };

    // ── HEADER ──
    w(0, 'SECTION'); w(2, 'HEADER');
    w(9, '$ACADVER');  w(1, 'AC1009');
    w(9, '$INSUNITS'); w(70, 4); // 4 = millimeters
    w(9, '$EXTMIN'); w(10, 0); w(20, 0);
    w(9, '$EXTMAX'); w(10, sheetW); w(20, sheetH);
    w(0, 'ENDSEC');

    // ── TABLES (layers) ──
    w(0, 'SECTION'); w(2, 'TABLES');
    w(0, 'TABLE'); w(2, 'LAYER'); w(70, 4);
    const layers = [
      { name: 'PARTS',    color: 5 },   // blue — cut lines
      { name: 'MARKINGS', color: 3 },   // green — inner markings
      { name: 'STAMP',    color: 1 },   // red — text
      { name: '0',        color: 7 },   // white — default
    ];
    for (const L of layers) {
      w(0, 'LAYER'); w(2, L.name); w(70, 0); w(62, L.color); w(6, 'CONTINUOUS');
    }
    w(0, 'ENDTAB');
    w(0, 'ENDSEC');

    // ── ENTITIES ──
    w(0, 'SECTION'); w(2, 'ENTITIES');

    const writePoly = (pts, layer, closed, dx, dy) => {
      if (!pts || pts.length < 2) return;
      // POLYLINE + VERTEX form (R12 compatible)
      w(0, 'POLYLINE');
      w(8, layer);
      w(66, 1);
      w(10, 0); w(20, 0); w(30, 0);
      w(70, closed ? 1 : 0);
      for (const [px, py] of pts) {
        w(0, 'VERTEX');
        w(8, layer);
        w(10, (px + dx).toFixed(4));
        w(20, flipY(py + dy).toFixed(4));
        w(30, 0);
      }
      w(0, 'SEQEND');
      w(8, layer);
    };

    for (const pl of placements) {
      const { pts, x, y, innerLines } = pl;
      const bbox = polyBBox(pts);
      const dx = x - bbox.x, dy = y - bbox.y;
      writePoly(pts, 'PARTS', true, dx, dy);

      if (opts.includeInner && innerLines && innerLines.length) {
        for (const il of innerLines) {
          if (!il.pts || il.pts.length < 2) continue;
          writePoly(il.pts, 'MARKINGS', !!il.closed, dx, dy);
        }
      }

      if (opts.includeLabels) {
        w(0, 'TEXT');
        w(8, 'MARKINGS');
        w(10, (x + bbox.w/2).toFixed(3));
        w(20, flipY(y + bbox.h/2).toFixed(3));
        w(30, 0);
        w(40, 3);                     // text height
        w(1, pl.partName || '');
        w(72, 1); w(73, 2);           // centered, middle
        w(11, (x + bbox.w/2).toFixed(3)); w(21, flipY(y + bbox.h/2).toFixed(3)); w(31, 0);
      }
    }

    // Stamp
    if (opts.stamp) {
      const lines = this._buildStampText(opts);
      if (lines.length) {
        const size = opts.stampSize;
        const anchor = this._getStampAnchor(opts.stampPos, sheetW, sheetH, settings.margin, size, lines.length);
        const isRight = anchor.anchor === 'end';
        for (let i = 0; i < lines.length; i++) {
          const yPos = anchor.y + i * size * 1.35; // canvas-down
          w(0, 'TEXT');
          w(8, 'STAMP');
          w(10, anchor.x.toFixed(3));
          w(20, flipY(yPos).toFixed(3));
          w(30, 0);
          w(40, size.toFixed(3));
          w(1, lines[i]);
          // 72: 0=left, 2=right
          w(72, isRight ? 2 : 0);
          w(11, anchor.x.toFixed(3));
          w(21, flipY(yPos).toFixed(3));
          w(31, 0);
        }
      }
    }

    w(0, 'ENDSEC');
    w(0, 'EOF');

    const dxf = out.join('\n');
    const blob = new Blob([dxf], { type: 'application/dxf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nest_sheet_${sheetIdx+1}.dxf`;
    a.click();
  }
};



