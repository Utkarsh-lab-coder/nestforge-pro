/*
 * NestForge Pro — DXFImport — load DXF files and classify shapes
 *
 * Original location: lines 16376..16995 of nestforge-pro.html (620 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const DXFImport = {
  setupDragDrop() {
    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');
    const folderInp = document.getElementById('folder-input');
    const zipInp = document.getElementById('zip-input');

    // Process a drop event — handles files, folders, and zips
    const handleDrop = async (e) => {
      e.preventDefault();
      dz.classList.remove('drag-over');
      const items = e.dataTransfer.items;
      const files = [];

      if (items && items.length && items[0].webkitGetAsEntry) {
        // Folder-aware drop
        const entries = [];
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
        for (const entry of entries) {
          await this._walkEntry(entry, files);
        }
      } else {
        // Fallback: plain file list
        for (const f of Array.from(e.dataTransfer.files)) files.push(f);
      }
      await this._ingestDropped(files);
    };

    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', handleDrop);
    fi.addEventListener('change', () => {
      this.loadFiles(Array.from(fi.files)); fi.value='';
    });
    folderInp.addEventListener('change', () => {
      const files = Array.from(folderInp.files).filter(f => /\.(dxf|svg)$/i.test(f.name));
      folderInp.value = '';
      this.loadFiles(files);
    });
    zipInp.addEventListener('change', async () => {
      const f = zipInp.files[0]; zipInp.value = '';
      if (!f) return;
      const extracted = await this._extractZip(f);
      this.loadFiles(extracted);
    });
    // Canvas drop
    const cw = document.getElementById('canvas-wrap');
    cw.addEventListener('dragover', e => e.preventDefault());
    cw.addEventListener('drop', handleDrop);
  },

  /* Walk a FileSystemEntry tree recursively, pushing DXF Files into `files` */
  _walkEntry(entry, files) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(async (f) => {
          if (/\.zip$/i.test(f.name)) {
            // Zip inside drop — extract it
            try {
              const extracted = await this._extractZip(f);
              files.push(...extracted);
            } catch(e) { console.warn('ZIP extract failed:', e); }
          } else if (/\.(dxf|svg)$/i.test(f.name)) {
            files.push(f);
          }
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = (acc) => {
          reader.readEntries(async (entries) => {
            if (!entries.length) {
              // Recurse into all collected
              for (const e of acc) await this._walkEntry(e, files);
              resolve();
              return;
            }
            readAll(acc.concat(entries));
          });
        };
        readAll([]);
      } else { resolve(); }
    });
  },

  /* Extract DXF entries from a ZIP File object — returns array of File objects */
  async _extractZip(zipFile) {
    if (typeof JSZip === 'undefined') {
      alert('ZIP support unavailable (JSZip failed to load).');
      return [];
    }
    const zip = await JSZip.loadAsync(zipFile);
    const out = [];
    const tasks = [];
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      if (!/\.(dxf|svg)$/i.test(path)) return;
      tasks.push(entry.async('blob').then(blob => {
        // Use just the basename (no folder path) for sheet naming
        const basename = path.split('/').pop();
        const isSvg = /\.svg$/i.test(basename);
        out.push(new File([blob], basename, { type: isSvg ? 'image/svg+xml' : 'application/dxf' }));
      }));
    });
    await Promise.all(tasks);
    return out;
  },

  /* Common dropped-files ingestion — filters for DXF/SVG, handles ZIP results */
  async _ingestDropped(files) {
    const accepted = files.filter(f => /\.(dxf|svg)$/i.test(f.name));
    if (!accepted.length) {
      alert('No DXF or SVG files found in dropped content.');
      return;
    }
    this.loadFiles(accepted);
  },

  openFolder() { document.getElementById('folder-input').click(); },
  openZip()    { document.getElementById('zip-input').click(); },

  openFiles() {
    document.getElementById('file-input').click();
  },

  // ── Import queue: process one file at a time through the modal ──────────
  _importQueue: [],
  _pendingFiles: null, // files waiting for sheet-choice decision

  async loadFiles(files) {
    if (!files || !files.length) return;
    document.getElementById('nest-status').textContent = `Parsing ${files.length} file(s)…`;
    // Parse all files first. Dispatch to the right parser based on
    // file extension — DXF and SVG produce the same shape format
    // ({type, pts, layer, closed}) so downstream import flow works for both.
    const parsed = [];
    for (const file of files) {
      const text = await file.text();
      const isSvg = /\.svg$/i.test(file.name);
      let shapes;
      try {
        shapes = isSvg ? SVGParser.parse(text) : DXFParser.parse(text);
      } catch (e) {
        console.error(`[NestForge] ${isSvg ? 'SVG' : 'DXF'} parse failed for ${file.name}:`, e);
        continue;
      }
      if (!shapes.length) { console.warn(`[NestForge] No shapes in ${file.name}`); continue; }
      const byType = {};
      shapes.forEach(s => { byType[s.type] = (byType[s.type]||0)+1; });
      console.log(`[NestForge] ${file.name} (${isSvg ? 'SVG' : 'DXF'}): ${shapes.length} shapes`, byType);
      parsed.push({ shapes, name: file.name });
    }
    document.getElementById('nest-status').textContent = 'Ready';
    if (!parsed.length) { alert('No valid shapes found in the imported file(s).'); return; }

    // Decide what to prompt
    const currentHasParts = this.parts.length > 0;
    const multiFile = parsed.length > 1;

    if (!currentHasParts && !multiFile) {
      // Single file, empty current sheet → direct import
      this._importQueue = parsed;
      this._processNextImport();
      return;
    }

    // Store pending, show modal with appropriate options
    this._pendingFiles = parsed;
    this._showSheetChoiceModal(currentHasParts, multiFile);
  },

  _showSheetChoiceModal(currentHasParts, multiFile) {
    const ws = this._worksheets[this._activeWS];
    const body = document.getElementById('sc-body');
    const hdr = document.getElementById('sc-hdr');
    const n = this._pendingFiles.length;

    hdr.textContent = multiFile
      ? `📄 Import ${n} Files`
      : '📄 Import Destination';

    body.innerHTML = '';

    const mkBtn = (icon, label, desc, action) => {
      const btn = document.createElement('div');
      btn.className = 'sc-btn';
      btn.innerHTML = `
        <div class="sc-icon">${icon}</div>
        <div>
          <div class="sc-label">${label}</div>
          <div class="sc-desc">${desc}</div>
        </div>`;
      btn.addEventListener('click', () => this._chooseSheet(action));
      body.appendChild(btn);
    };

    if (currentHasParts) {
      mkBtn('📌', 'Add to Current Sheet',
        multiFile
          ? `Merge all ${n} files into <b>${ws.name}</b> (with existing parts)`
          : `Merge with existing parts on <b>${ws.name}</b>`,
        'current');
    }

    if (multiFile) {
      mkBtn('🗂', 'Separate Sheet Per File',
        `Create ${n} new independent sheets, named from each filename`,
        'separate');
      mkBtn('✨', 'One New Sheet (All Together)',
        `Put all ${n} files on a single new sheet`,
        'new-single');
    } else {
      mkBtn('✨', 'Create New Sheet',
        'Start a fresh independent sheet for this file',
        'new');
    }

    document.getElementById('sheet-choice-modal').classList.add('active');
  },

  _cancelSheetChoice() {
    document.getElementById('sheet-choice-modal').classList.remove('active');
    this._pendingFiles = null;
  },

  _chooseSheet(choice) {
    document.getElementById('sheet-choice-modal').classList.remove('active');
    const files = this._pendingFiles;
    this._pendingFiles = null;
    if (!files || !files.length) return;

    if (choice === 'current') {
      // Import all files into the current active sheet
      this._importQueue = files;
      this._processNextImport();
    } else if (choice === 'new') {
      // Single file → one new sheet
      this.addWorksheet();
      this._importQueue = files;
      this._processNextImport();
    } else if (choice === 'new-single') {
      // Multi-file → all on ONE new sheet
      this.addWorksheet();
      this._importQueue = files;
      this._processNextImport();
    } else if (choice === 'separate') {
      // Multi-file → one sheet per file, named after each file
      this._saveCurrentWS();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const sheetName = f.name.replace(/\.(dxf|svg)$/i, '');
        this._wsCounter++;
        this._worksheets.push({
          id: this._wsCounter,
          name: sheetName,
          parts: [], nestResult: null, colorIdx: 0,
          _pendingImportFile: f
        });
      }
      // Process each pending sheet sequentially
      this._processSeparateSheetImports();
    }
  },

  async _processSeparateSheetImports() {
    // Find all sheets with _pendingImportFile
    for (let i = 0; i < this._worksheets.length; i++) {
      const ws = this._worksheets[i];
      if (!ws._pendingImportFile) continue;
      // Switch to that sheet
      this._loadWS(i);
      this._renderWSTabs();
      // Queue this single file and process it
      this._importQueue = [ws._pendingImportFile];
      delete ws._pendingImportFile;
      await new Promise(resolve => {
        this._separateImportResolver = resolve;
        this._processNextImport();
      });
    }
    this._separateImportResolver = null;
  },

  _processNextImport() {
    if (!this._importQueue.length) {
      // All files done — refresh UI and save to worksheet
      this.updatePartsUI(); this.updateUI();
      Renderer.parts = this.parts; Renderer.nestResult = null;
      document.getElementById('empty-canvas').style.display = this.parts.length ? 'none' : 'flex';
      this._saveCurrentWS();
      this._renderWSTabs();
      if (this.parts.length) Renderer.fitView();
      else Renderer.draw();
      // If a separate-import batch is waiting for this queue to finish, resolve it
      if (this._separateImportResolver) {
        const r = this._separateImportResolver;
        this._separateImportResolver = null;
        r();
      }
      return;
    }
    const { shapes, name } = this._importQueue[0];
    this._showImportModal(shapes, name);
  },

  /* _classifyShapes — separates boundary polygon from inner marking lines.
     Returns { boundary, boundaries, otherShapes, layerGroups }.
     boundary   = largest closed polygon used as nesting outline.
     otherShapes= all other shapes (seam lines, stitch lines, notches…). */
  _classifyShapes(shapes) {
    const LAYER_COLORS = ['#3b82f6','#22c55e','#ec4899','#a855f7','#06b6d4','#eab308','#f43f5e','#84cc16','#fb923c'];
    const all = [];
    for (const s of shapes) {
      if (s.pts.length < 2) continue;
      const f = s.pts[0], l = s.pts[s.pts.length-1];
      const dist = Math.hypot(l[0]-f[0], l[1]-f[1]);
      const isClosed = s.closed || dist < 0.5 || s.type==='CIRCLE' || s.type==='ELLIPSE';
      all.push({ ...s, isClosed, area: isClosed && s.pts.length>=3 ? polyArea(s.pts) : 0, bbox: polyBBox(s.pts) });
    }

    // Sort closed polygons by area (largest first)
    const closed = all.filter(s => s.isClosed && s.pts.length >= 3).sort((a,b) => b.area-a.area);
    if (closed.length === 0) {
      return { boundary: null, boundaries: [], otherShapes: all, layerGroups: new Map() };
    }

    // Boundary detection — collect all polygons that look like top-level parts.
    // A polygon is a boundary iff:
    //   • Area ≥ 40% of the largest closed polygon (filters out small markings), AND
    //   • Its bbox does NOT sit inside any already-selected boundary's bbox
    //     (prevents nested sub-panels and seam-allowance lines from becoming
    //      duplicate "copies" of the same vamp).
    const boundaries = [];
    const maxArea = closed[0].area;
    const bboxContains = (outer, inner) => {
      const pad = Math.max(outer.w, outer.h) * 0.02;
      return inner.x >= outer.x - pad && inner.y >= outer.y - pad &&
             (inner.x + inner.w) <= (outer.x + outer.w) + pad &&
             (inner.y + inner.h) <= (outer.y + outer.h) + pad;
    };
    for (const s of closed) {
      if (s.area < maxArea * 0.40) break; // too small to be another part
      // Is this polygon inside any already-picked boundary? → not a separate part
      const containedIn = boundaries.some(b => bboxContains(b.bbox, s.bbox));
      if (containedIn) continue;
      boundaries.push(s);
    }
    const boundary = boundaries[0] || null;

    // All other shapes = inner marking lines
    const boundarySet = new Set(boundaries);
    const otherShapes = all.filter(s => !boundarySet.has(s));

    // Group by layer, assign colors
    const layerGroups = new Map();
    let ci = 0;
    for (const s of otherShapes) {
      const lk = s.layer || '0';
      if (!layerGroups.has(lk)) {
        layerGroups.set(lk, { shapes:[], color: LAYER_COLORS[ci++ % LAYER_COLORS.length] });
      }
      const g = layerGroups.get(lk);
      s._layerColor = g.color; s._layerKey = lk;
      g.shapes.push(s);
    }
    return { boundary, boundaries, otherShapes, layerGroups };
  },

  _showImportModal(shapes, filename) {
    const classified = this._classifyShapes(shapes);
    this._pendingImport = { classified, filename };

    document.getElementById('import-filename').textContent = filename;
    const listEl = document.getElementById('import-layers-list');
    listEl.innerHTML = '';

    // ── BOUNDARY section ────────────────────────────────────────────
    if (classified.boundary) {
      const b = classified.boundary;
      const bbox = polyBBox(b.pts);
      listEl.innerHTML += `
        <div class="il-section-hdr">Nesting Boundary (always included)</div>
        <div class="il-row">
          <div class="il-dot" style="background:var(--accent)"></div>
          <div class="il-info">
            <div class="il-name">Layer ${b.layer || '0'} — Outer outline</div>
            <div class="il-meta">${b.pts.length} pts · ${bbox.w.toFixed(1)}×${bbox.h.toFixed(1)}mm · ${polyArea(b.pts).toFixed(0)}mm²</div>
          </div>
          <span class="il-badge boundary">BOUNDARY</span>
        </div>`;
    }

    // ── MARKING LINES section ────────────────────────────────────────
    if (classified.layerGroups.size > 0) {
      listEl.innerHTML += `<div class="il-section-hdr">Marking Lines (select to include)</div>`;
      let idx = 0;
      for (const [layerKey, group] of classified.layerGroups) {
        const shapeCount = group.shapes.length;
        const totalPts = group.shapes.reduce((s,sh) => s+sh.pts.length, 0);
        const typeNames = [...new Set(group.shapes.map(s=>s.type))].join(', ');
        const row = document.createElement('div');
        row.className = 'il-row';
        row.innerHTML = `
          <input type="checkbox" id="layer-cb-${idx}" data-layer="${layerKey}" data-idx="${idx}"
            checked style="accent-color:${group.color};width:14px;height:14px;flex-shrink:0"
            onchange="App._updateImportPreview()">
          <div class="il-dot" style="background:${group.color}"></div>
          <label class="il-info" for="layer-cb-${idx}" style="cursor:pointer">
            <div class="il-name">Layer ${layerKey}</div>
            <div class="il-meta">${shapeCount} path${shapeCount>1?'s':''} · ${totalPts} pts · ${typeNames}</div>
          </label>`;
        listEl.appendChild(row);
        idx++;
      }
    } else {
      listEl.innerHTML += `<div style="padding:16px;font-size:12px;color:var(--text3)">No inner lines detected in this file.</div>`;
    }

    document.getElementById('import-modal').style.display = 'flex';
    this._updateImportPreview();
  },

  _updateImportPreview() {
    if (!this._pendingImport) return;
    const { classified } = this._pendingImport;
    const canvas = document.getElementById('import-preview-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Collect all pts for scale computation
    const allPts = [];
    if (classified.boundary) allPts.push(...classified.boundary.pts);
    for (const s of classified.otherShapes) allPts.push(...s.pts);
    if (!allPts.length) return;

    const bbox = polyBBox(allPts);
    if (bbox.w < 0.1 || bbox.h < 0.1) return;
    const pad = 14;
    const scale = Math.min((W-pad*2)/bbox.w, (H-pad*2)/bbox.h);
    const ox = pad + ((W-pad*2) - bbox.w*scale)/2 - bbox.x*scale;
    const oy = pad + ((H-pad*2) - bbox.h*scale)/2 - bbox.y*scale;
    const tx = p => p.map(([x,y]) => [x*scale+ox, y*scale+oy]);

    // White background
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

    // Draw boundary fill + outline
    if (classified.boundary) {
      const pts = tx(classified.boundary.pts);
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(249,115,22,0.12)'; ctx.fill();
      ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Draw selected inner lines
    let idx = 0;
    for (const [layerKey, group] of classified.layerGroups) {
      const cb = document.getElementById(`layer-cb-${idx}`);
      if (cb && cb.checked) {
        ctx.strokeStyle = group.color; ctx.lineWidth = 1;
        for (const s of group.shapes) {
          const pts = tx(s.pts);
          ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
          if (s.isClosed) ctx.closePath();
          ctx.stroke();
        }
      }
      idx++;
    }

    // Info text
    const b = classified.boundary;
    if (b) {
      const bboxB = polyBBox(b.pts);
      document.getElementById('import-preview-info').textContent =
        `${bboxB.w.toFixed(0)}×${bboxB.h.toFixed(0)}mm`;
    }
  },

  confirmImport() {
    if (!this._pendingImport) return;
    const { classified, filename } = this._pendingImport;
    if (!classified.boundary) { alert('No boundary polygon found.'); this.cancelImport(); return; }

    // Collect selected inner lines (raw DXF coords — will be normalized below)
    const innerLinesDxf = [];
    let idx = 0;
    for (const [layerKey, group] of classified.layerGroups) {
      const cb = document.getElementById(`layer-cb-${idx}`);
      if (cb && cb.checked) {
        for (const s of group.shapes) {
          innerLinesDxf.push({ pts: s.pts, layer: layerKey, color: group.color, closed: !!s.isClosed });
        }
      }
      idx++;
    }

    // Add part(s) — one per boundary
    // KEY: normalize ALL coords so outer boundary bbox starts at (0,0).
    // This guarantees inner lines are always correctly positioned relative
    // to the boundary regardless of DXF world-coordinate origin.
    classified.boundaries.forEach((b, i) => {
      const rawBbox = polyBBox(b.pts);
      const bx = rawBbox.x, by = rawBbox.y;
      const bxMax = rawBbox.x + rawBbox.w, byMax = rawBbox.y + rawBbox.h;
      // Small tolerance so notches/ticks just outside the outline still count
      const tol = Math.max(rawBbox.w, rawBbox.h) * 0.02;

      // Filter: drop any inner line whose centroid falls OUTSIDE the boundary's
      // bbox. This prevents stray geometry (e.g. a duplicate outer polygon at
      // a different DXF position) from being drawn as "inner lines" outside
      // the nested part, which would appear outside the sheet after nesting.
      const relevantInner = innerLinesDxf.filter(il => {
        if (!il.pts || il.pts.length < 2) return false;
        const ibb = polyBBox(il.pts);
        const cx = ibb.x + ibb.w / 2, cy = ibb.y + ibb.h / 2;
        return cx >= bx - tol && cx <= bxMax + tol &&
               cy >= by - tol && cy <= byMax + tol;
      });
      const droppedCount = innerLinesDxf.length - relevantInner.length;

      // Normalize: shift all coords so boundary min-corner lands at (0,0).
      const pts = b.pts.map(([px, py]) => [px - bx, py - by]);
      const innerLines = relevantInner.map(il => ({
        pts:   il.pts.map(([px, py]) => [px - bx, py - by]),
        layer: il.layer,
        color: il.color,
        closed: il.closed
      }));
      console.log('[NestForge] Norm: bx='+bx.toFixed(2)+' by='+by.toFixed(2)+
        ' → bounds [0,'+rawBbox.w.toFixed(1)+']×[0,'+rawBbox.h.toFixed(1)+
        '] | kept '+innerLines.length+' inner'+(droppedCount?' (dropped '+droppedCount+' outside boundary)':''));

      const id   = Date.now() + '_' + Math.random().toString(36).slice(2);
      const name = filename.replace(/\.(dxf|svg)$/i, '') +
                   (classified.boundaries.length > 1 ? '_' + (i+1) : '');

      this.parts.push({ id, name, pts, color: nextColor(), qty: 1,
        area: polyArea(pts), bbox: polyBBox(pts), innerLines });
    });

    this.nestResult = null;
    this._resetRulesMode && this._resetRulesMode();
    document.getElementById('import-modal').style.display = 'none';
    this._pendingImport = null;
    this._importQueue.shift();
    this._processNextImport();
  },

  cancelImport() {
    document.getElementById('import-modal').style.display = 'none';
    this._pendingImport = null;
    this._importQueue.shift();
    this._processNextImport();
  },

  extractClosedPolygons(shapes) {
    // Prefer closed shapes (outline boundary) — layer 1 style or dist==0
    const closed = [], open = [];
    for (const shape of shapes) {
      const pts = shape.pts;
      if (pts.length < 3) continue;
      const first = pts[0], last = pts[pts.length-1];
      const dist  = Math.hypot(last[0]-first[0], last[1]-first[1]);
      const isClosed = shape.closed || dist < 0.5
        || shape.type === 'CIRCLE' || shape.type === 'ELLIPSE';
      if (isClosed) {
        const clean = dist < 0.01 ? pts.slice(0,-1) : pts;
        if (clean.length >= 3) closed.push({ pts: clean, area: polyArea(clean) });
      } else {
        open.push({ pts });
      }
    }
    if (closed.length > 0) {
      closed.sort((a,b) => b.area - a.area);
      // Filter out tiny shapes (notch circles, holes) that are < 2% of largest area.
      // These are notch/drill marks embedded in the pattern — not separate nesting parts.
      const maxArea = closed[0].area;
      // Keep only shapes ≥ 30% of the largest area.
      // Seam-allowance lines and internal reference loops are typically
      // 5–15% of the outline area; multiple distinct pattern pieces are ≥ 50%.
      const significant = closed.filter(s => s.area >= maxArea * 0.30);
      return significant.map(s => s.pts);
    }
    // Snap open polylines into closed loops
    const snapped = this._snapOpenToLoops(open.map(s=>s.pts));
    if (snapped.length) return snapped;
    // Last resort - return longest open polyline
    open.sort((a,b) => b.pts.length - a.pts.length);
    return open.slice(0,1).map(s => s.pts);
  },

  _snapOpenToLoops(polylines, tol=1.0) {
    if (!polylines.length) return [];
    const chains = polylines.map(p => [...p]);
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < chains.length; i++) {
        for (let j = i+1; j < chains.length; j++) {
          const a = chains[i], b = chains[j];
          const ae = a[a.length-1], bs = b[0];
          if (Math.hypot(ae[0]-bs[0],ae[1]-bs[1]) < tol) {
            chains[i] = [...a, ...b.slice(1)]; chains.splice(j,1); merged=true; break outer;
          }
          const be = b[b.length-1], as_ = a[0];
          if (Math.hypot(be[0]-as_[0],be[1]-as_[1]) < tol) {
            chains[i] = [...b, ...a.slice(1)]; chains.splice(j,1); merged=true; break outer;
          }
          if (Math.hypot(ae[0]-b[b.length-1][0],ae[1]-b[b.length-1][1]) < tol) {
            chains[i] = [...a, ...[...b].reverse().slice(1)]; chains.splice(j,1); merged=true; break outer;
          }
        }
      }
    }
    return chains.filter(c => {
      const f=c[0],l=c[c.length-1];
      return c.length >= 3 && Math.hypot(f[0]-l[0],f[1]-l[1]) < tol*2;
    });
  },
};



