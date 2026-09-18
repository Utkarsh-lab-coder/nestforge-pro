/*
 * NestForge Pro — DXF Parser — handles AC1004–AC1032, BLOCKS+ENTITIES
 *
 * Original location: lines 1277..1996 of nestforge-pro.html (720 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const DXFParser = {

  parse(text) {
    const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
    const tokens = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      if (!isNaN(code)) tokens.push({ code, val: lines[i+1].trim() });
    }
    // Parse BLOCKS and ENTITIES sections
    const blocks   = this._extractSection(tokens, 'BLOCKS');
    const entities = this._extractSection(tokens, 'ENTITIES');

    // Build block dictionary: name → [rawEntityToken arrays]
    const blockMap = this._parseBlocks(blocks);

    // Resolve entities (expanding INSERT references into blockMap)
    const resolved = this._resolveEntities(entities, blockMap);

    // Convert raw entity records → shapes (point arrays)
    return this._buildShapes(resolved);
  },

  /* ── tokenised section extraction ─────────────────────────── */
  _extractSection(tokens, name) {
    const out = [];
    let capture = false;
    for (let i = 0; i < tokens.length; i++) {
      const { code, val } = tokens[i];
      if (code === 0 && val === 'SECTION') { capture = false; continue; }
      if (code === 2 && val === name)      { capture = true;  continue; }
      if (code === 0 && val === 'ENDSEC')  { if (capture) { capture = false; } continue; }
      if (capture) out.push(tokens[i]);
    }
    return out;
  },

  /* ── BLOCKS section → Map<blockName, rawEntity[]> ──────────── */
  /* ── BLOCKS section → Map<blockName, {baseX,baseY,entities[]}> ─ */
  _parseBlocks(tokens) {
    const map = new Map();
    let blockName = null, baseX = 0, baseY = 0, current = null, inBlock = false;
    const entities = [];

    for (let i = 0; i < tokens.length; i++) {
      const { code, val } = tokens[i];
      if (code === 0 && val === 'BLOCK') {
        inBlock = true; blockName = null; baseX = 0; baseY = 0; continue;
      }
      if (code === 2 && inBlock && blockName === null) { blockName = val; continue; }
      // Block base point — stored BEFORE any entity (no current yet)
      if (code === 10 && inBlock && !current) { baseX = parseFloat(val); continue; }
      if (code === 20 && inBlock && !current) { baseY = parseFloat(val); continue; }
      if (code === 0 && val === 'ENDBLK') {
        if (current) entities.push(current);
        if (blockName) map.set(blockName, { baseX, baseY, entities: [...entities] });
        entities.length = 0; blockName = null; inBlock = false; current = null; continue;
      }
      if (!inBlock) continue;
      if (code === 0) {
        if (current) entities.push(current);
        current = { type: val, data: [] };
      } else if (current) {
        current.data.push({ code, val });
      }
    }
    return map;
  },

  /* ── ENTITIES section tokens → rawEntity[] ─────────────────── */
  _parseEntityList(tokens) {
    const out = [];
    let current = null;
    for (const { code, val } of tokens) {
      if (code === 0) {
        if (current) out.push(current);
        current = { type: val, data: [] };
      } else if (current) {
        current.data.push({ code, val });
      }
    }
    if (current) out.push(current);
    return out;
  },

  /* ── resolve INSERT entities by inlining block geometry ──────── */
  _resolveEntities(tokens, blockMap, tx=0, ty=0, sx=1, sy=1, rot=0) {
    const raw = this._parseEntityList(tokens);
    const out = [];

    for (const e of raw) {
      if (e.type === 'INSERT') {
        const bname  = this._gv(e.data, 2, '');
        const ix     = this._gf(e.data, 10, 0);
        const iy     = this._gf(e.data, 20, 0);
        const isx    = this._gf(e.data, 41, 1);
        const isy    = this._gf(e.data, 42, 1);
        const irot   = this._gf(e.data, 50, 0);
        const block  = blockMap.get(bname);
        if (block) {
          // block.entities are already-parsed {type,data} objects — use directly.
          // Net transform: INSERT_pos - BLOCK_base_point (block coords are relative to base).
          const netX = ix - block.baseX * isx;
          const netY = iy - block.baseY * isy;
          for (const sub of block.entities) {
            out.push({
              ...sub,
              _tx:  netX + tx,
              _ty:  netY + ty,
              _sx:  isx * sx,
              _sy:  isy * sy,
              _rot: irot + rot
            });
          }
        }
        continue;
      }
      // Direct entity — already in world coords
      out.push({ ...e, _tx: tx, _ty: ty, _sx: sx, _sy: sy, _rot: rot });
    }
    return out;
  },

  /* ── POLYLINE + VERTEX / SEQEND (old DXF format AC1004–AC1015) */
  _resolvePolylineVertices(entities) {
    // Group VERTEX entities into their parent POLYLINE by stream order
    const out = [];
    let poly = null;
    for (const e of entities) {
      if (e.type === 'POLYLINE') {
        poly = { ...e, _vertices: [] };
        out.push(poly);
      } else if (e.type === 'VERTEX' && poly) {
        poly._vertices.push(e);
      } else if (e.type === 'SEQEND') {
        poly = null;
      } else {
        out.push(e);
      }
    }
    return out;
  },

  /* ── split a pts array into sub-paths wherever steps exceed gapMm ── */
  _splitPathAtGaps(pts, gapMm) {
    if (pts.length < 2) return [pts];
    const subs = [], gapSq = gapMm * gapMm;
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0]-pts[i-1][0], dy = pts[i][1]-pts[i-1][1];
      if (dx*dx + dy*dy > gapSq) {
        if (cur.length >= 2) subs.push(cur);
        cur = [pts[i]];
      } else {
        cur.push(pts[i]);
      }
    }
    if (cur.length >= 2) subs.push(cur);
    return subs.length ? subs : [pts];
  },

  /* ── convert resolved entities → shape point arrays ─────────── */
  _buildShapes(entities) {
    const withVerts = this._resolvePolylineVertices(entities);
    const shapes = [];

    for (const e of withVerts) {
      let pts = null;
      const d = e.data;
      switch (e.type) {
        case 'LWPOLYLINE': pts = this._parseLWPolyline(d); break;
        case 'POLYLINE':   pts = this._parseOldPolyline(e); break;
        case 'LINE':       pts = this._parseLine(d); break;
        case 'ARC':        pts = this._parseArc(d); break;
        case 'CIRCLE':     pts = this._parseCircle(d); break;
        case 'SPLINE':     pts = this._parseSpline(d); break;
        case 'ELLIPSE':    pts = this._parseEllipse(d); break;
      }
      if (!pts || pts.length < 2) continue;

      // Apply INSERT transform if any field is set
      const tx = e._tx||0, ty = e._ty||0, sx = e._sx||1, sy = e._sy||1, rot = e._rot||0;
      if (tx !== 0 || ty !== 0 || sx !== 1 || sy !== 1 || rot !== 0) {
        pts = this._applyTransform(pts, tx, ty, sx, sy, rot);
      }

      const layer = this._gv(d, 8, '0');
      const closed = this._isClosedPts(pts);
      shapes.push({ type: e.type, pts, layer, closed });
    }

    // Chain individual LINE and ARC segments that share endpoints into
    // continuous polylines. Many CAD exporters write outlines as hundreds
    // of separate LINE entities instead of a single LWPOLYLINE.
    return this._chainLineSegments(shapes);
  },

  /* ── Chain LINE/ARC segments sharing endpoints into polylines ──────
     Groups by layer, then greedily chains segments whose start/end
     points are within `tol` mm of each other. Produces longer polylines
     that _classifyShapes can then correctly identify as boundaries or
     continuous inner marking lines. Non-LINE shapes pass through as-is.
  ───────────────────────────────────────────────────────────────────── */
  _chainLineSegments(shapes, tol = 1.0) {
    const nonLine = [];
    const linesByLayer = new Map(); // layer → [{pts, type, layer}]

    for (const s of shapes) {
      // Only chain short/open segments — LINE, ARC, SPLINE (open)
      // LWPOLYLINEs and POLYLINEs are already continuous.
      if ((s.type === 'LINE' || s.type === 'ARC' || s.type === 'SPLINE') && !s.closed) {
        const lk = s.layer || '0';
        if (!linesByLayer.has(lk)) linesByLayer.set(lk, []);
        linesByLayer.get(lk).push(s);
      } else {
        nonLine.push(s);
      }
    }

    // If no LINE/ARC segments to chain, return as-is
    if (linesByLayer.size === 0) return shapes;

    const tolSq = tol * tol;
    const dist2 = (a, b) => { const dx=a[0]-b[0], dy=a[1]-b[1]; return dx*dx+dy*dy; };
    // Spatial hash: snap coords to grid cells of size `tol`, look up neighboring cells
    const hashKey = (x, y) => Math.round(x/tol) + ',' + Math.round(y/tol);
    const neighborKeys = (x, y) => {
      const gx = Math.round(x/tol), gy = Math.round(y/tol);
      const out = [];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          out.push((gx+dx)+','+(gy+dy));
      return out;
    };

    for (const [layer, segs] of linesByLayer) {
      // Build chains: each chain has pts[], and we track its head/tail endpoints
      const chains = segs.map((s, i) => ({ id: i, pts: [...s.pts] }));
      const alive = new Set(chains.map(c => c.id)); // set of active chain IDs

      // Spatial index: gridKey → Set<{chainId, end:'s'|'e'}>
      // 's' = start endpoint, 'e' = end endpoint
      const grid = new Map();
      const addToGrid = (chainId, pt, end) => {
        const k = hashKey(pt[0], pt[1]);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ chainId, end });
      };
      const removeFromGrid = (chainId) => {
        for (const [k, arr] of grid) {
          for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].chainId === chainId) arr.splice(i, 1);
          }
        }
      };

      // Initialize grid
      for (const c of chains) {
        addToGrid(c.id, c.pts[0], 's');
        addToGrid(c.id, c.pts[c.pts.length - 1], 'e');
      }

      // Greedy merge pass — check both endpoints of each chain
      let changed = true;
      let safetyLimit = segs.length * 2; // prevent infinite loop
      while (changed && safetyLimit-- > 0) {
        changed = false;
        for (const aId of alive) {
          const a = chains[aId];
          let foundMatch = false;

          // --- Try to grow from a's END ---
          const aEnd = a.pts[a.pts.length - 1];
          const endKeys = neighborKeys(aEnd[0], aEnd[1]);
          for (const nk of endKeys) {
            const bucket = grid.get(nk);
            if (!bucket) continue;
            for (const entry of bucket) {
              if (entry.chainId === aId || !alive.has(entry.chainId)) continue;
              const b = chains[entry.chainId];
              const bStart = b.pts[0], bEnd = b.pts[b.pts.length - 1];

              if (entry.end === 's' && dist2(aEnd, bStart) < tolSq) {
                a.pts.push(...b.pts.slice(1));
                removeFromGrid(entry.chainId); removeFromGrid(aId);
                alive.delete(entry.chainId);
                addToGrid(aId, a.pts[0], 's');
                addToGrid(aId, a.pts[a.pts.length - 1], 'e');
                changed = true; foundMatch = true; break;
              }
              if (entry.end === 'e' && dist2(aEnd, bEnd) < tolSq) {
                a.pts.push(...[...b.pts].reverse().slice(1));
                removeFromGrid(entry.chainId); removeFromGrid(aId);
                alive.delete(entry.chainId);
                addToGrid(aId, a.pts[0], 's');
                addToGrid(aId, a.pts[a.pts.length - 1], 'e');
                changed = true; foundMatch = true; break;
              }
            }
            if (foundMatch) break;
          }
          if (foundMatch) break;

          // --- Try to grow from a's START ---
          const aStart = a.pts[0];
          const startKeys = neighborKeys(aStart[0], aStart[1]);
          for (const nk of startKeys) {
            const bucket = grid.get(nk);
            if (!bucket) continue;
            for (const entry of bucket) {
              if (entry.chainId === aId || !alive.has(entry.chainId)) continue;
              const b = chains[entry.chainId];
              const bStart = b.pts[0], bEnd = b.pts[b.pts.length - 1];

              if (entry.end === 'e' && dist2(aStart, bEnd) < tolSq) {
                // b_end → a_start: prepend b to a
                a.pts = [...b.pts, ...a.pts.slice(1)];
                removeFromGrid(entry.chainId); removeFromGrid(aId);
                alive.delete(entry.chainId);
                addToGrid(aId, a.pts[0], 's');
                addToGrid(aId, a.pts[a.pts.length - 1], 'e');
                changed = true; foundMatch = true; break;
              }
              if (entry.end === 's' && dist2(aStart, bStart) < tolSq) {
                // reverse(b) → a: prepend reversed b to a
                a.pts = [...[...b.pts].reverse(), ...a.pts.slice(1)];
                removeFromGrid(entry.chainId); removeFromGrid(aId);
                alive.delete(entry.chainId);
                addToGrid(aId, a.pts[0], 's');
                addToGrid(aId, a.pts[a.pts.length - 1], 'e');
                changed = true; foundMatch = true; break;
              }
            }
            if (foundMatch) break;
          }
          if (foundMatch) break;
        }
      }

      // Emit chained results
      for (const cId of alive) {
        const c = chains[cId];
        const closed = this._isClosedPts(c.pts);
        nonLine.push({ type: 'CHAINED_LINE', pts: c.pts, layer, closed });
      }
    }

    console.log(`[NestForge] Line chaining: ${shapes.length} shapes → ${nonLine.length} (chained LINE/ARC segments by layer)`);
    return nonLine;
  },

  _isClosedPts(pts) {
    if (pts.length < 3) return false;
    const f = pts[0], l = pts[pts.length-1];
    return Math.hypot(f[0]-l[0], f[1]-l[1]) < 1.0; // 1mm tolerance — consistent with _parseOldPolyline
  },

  _applyTransform(pts, tx, ty, sx, sy, rotDeg) {
    if (rotDeg === 0 && sx === 1 && sy === 1) return pts.map(([x,y]) => [x+tx, y+ty]);
    const rad = rotDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return pts.map(([x,y]) => {
      const nx = x*sx, ny = y*sy;
      return [tx + nx*cos - ny*sin, ty + nx*sin + ny*cos];
    });
  },

  /* ── LWPOLYLINE (modern, single entity, group 10/20/42) ─────── */
  _parseLWPolyline(data) {
    const closed = (this._gi(data, 70, 0) & 1) !== 0;
    const verts = [];
    let cx = null, cy = null, bulge = 0;
    for (const { code, val } of data) {
      if (code === 10) { if (cx !== null) verts.push([cx, cy, bulge]); cx = parseFloat(val); bulge = 0; }
      else if (code === 20) cy = parseFloat(val);
      else if (code === 42) bulge = parseFloat(val);
    }
    if (cx !== null) verts.push([cx, cy, bulge]);
    if (verts.length < 2) return null;
    return this._vertsToPoints(verts, closed);
  },

  /* ── POLYLINE/VERTEX/SEQEND (old format) ─────────────────────── */
  _parseOldPolyline(e) {
    const flags  = this._gi(e.data, 70, 0);
    const closed = (flags & 1) !== 0;
    const verts  = (e._vertices || []).map(ve => {
      const vd = ve.data;
      const x = this._gf(vd, 10, 0);
      const y = this._gf(vd, 20, 0);
      const b = this._gf(vd, 42, 0);
      return [x, y, b];
    });
    if (verts.length < 2) return null;

    const firstV = verts[0], lastV = verts[verts.length-1];
    const endDist = Math.hypot(firstV[0]-lastV[0], firstV[1]-lastV[1]);

    // Treat as closed if flag is set OR if last vertex is within 1.0mm of first.
    // (Some CAD exporters write the closing vertex slightly offset, e.g. 0.0173mm.)
    const selfClosed = closed || endDist < 1.0;

    // Drop last vertex only if it is an EXACT duplicate (endDist < 0.01mm).
    // Near-duplicates (0.01–1.0mm) are kept; the closing segment is effectively
    // invisible and the gap-split step will handle any visible artefacts.
    const workVerts = endDist < 0.01 ? verts.slice(0, -1) : verts;

    return this._vertsToPoints(workVerts, selfClosed);
  },

  /* ── expand bulge segments into arc approximations ──────────── */
  _vertsToPoints(verts, closed) {
    const pts = [];
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1, bulge] = verts[i];
      pts.push([x1, y1]);
      const ni = (i + 1) % n;
      if (ni === 0 && !closed) continue;
      const [x2, y2] = verts[ni];
      if (Math.abs(bulge) > 1e-10) {
        const arcPts = bulgeToArcPoints(x1, y1, x2, y2, bulge);
        // push all but last (it becomes next vertex push or closing push)
        for (let k = 0; k < arcPts.length - 1; k++) pts.push(arcPts[k]);
      }
    }
    if (closed && pts.length > 0) pts.push(pts[0].slice());
    return pts;
  },

  _parseLine(data) {
    const xs = data.filter(d=>d.code===10).map(d=>parseFloat(d.val));
    const ys = data.filter(d=>d.code===20).map(d=>parseFloat(d.val));
    const xe = data.filter(d=>d.code===11).map(d=>parseFloat(d.val));
    const ye = data.filter(d=>d.code===21).map(d=>parseFloat(d.val));
    if (!xs.length || !xe.length) return null;
    return [[xs[0], ys[0]||0], [xe[0], ye[0]||0]];
  },

  _parseArc(data) {
    const cx    = this._gf(data, 10, 0);
    const cy    = this._gf(data, 20, 0);
    const r     = this._gf(data, 40, 1);
    const start = this._gf(data, 50, 0);
    const end   = this._gf(data, 51, 360);
    return arcToPoints(cx, cy, r, start * Math.PI/180, end * Math.PI/180);
  },

  _parseCircle(data) {
    const cx = this._gf(data, 10, 0);
    const cy = this._gf(data, 20, 0);
    const r  = this._gf(data, 40, 1);
    // Let arcToPoints pick segment count based on radius (adaptive tolerance)
    return arcToPoints(cx, cy, r, 0, 2*Math.PI);
  },

  /* DXF SPLINE is a NURBS B-spline: control points + knot vector + degree.
     Control points do NOT lie on the curve — they pull it. Correct evaluation
     uses De Boor's recursion.
     Fit points (codes 11/21), if present, are interpolation waypoints the
     curve should pass through; we fall back to a Catmull-Rom interpolation
     for those since DXF doesn't specify the interpolation algorithm. */
  _parseSpline(data) {
    const flags   = this._gi(data, 70, 0);
    const closed  = (flags & 1) !== 0 || (flags & 2) !== 0; // closed OR periodic
    const degree  = this._gi(data, 71, 3);

    // Collect knots (code 40), control points (10/20), fit points (11/21)
    const knots = [], cp = [], fit = [];
    let curCx = null, curCy = null, curFx = null, curFy = null;
    for (const { code, val } of data) {
      if (code === 40) knots.push(parseFloat(val));
      else if (code === 10) { if (curCx !== null) cp.push([curCx, curCy||0]); curCx = parseFloat(val); curCy = 0; }
      else if (code === 20) curCy = parseFloat(val);
      else if (code === 11) { if (curFx !== null) fit.push([curFx, curFy||0]); curFx = parseFloat(val); curFy = 0; }
      else if (code === 21) curFy = parseFloat(val);
    }
    if (curCx !== null) cp.push([curCx, curCy||0]);
    if (curFx !== null) fit.push([curFx, curFy||0]);

    // ── Proper B-spline evaluation when we have control points + knots ──
    if (cp.length >= degree + 1 && knots.length >= cp.length + degree + 1) {
      return _tessellateBSpline(cp, knots, degree, closed);
    }

    // ── Fall back: if only fit points, use Catmull-Rom interpolation ──
    if (fit.length >= 2) return catmullRom(fit, closed);

    // ── Last resort: treat control points as fit points ──
    if (cp.length >= 2) return catmullRom(cp, closed);
    return null;
  },

  _parseEllipse(data) {
    const cx  = this._gf(data, 10, 0), cy  = this._gf(data, 20, 0);
    const mjx = this._gf(data, 11, 1), mjy = this._gf(data, 21, 0);
    const rat = this._gf(data, 40, 1);
    const sa  = this._gf(data, 41, 0), ea  = this._gf(data, 42, Math.PI*2);
    const rx  = Math.sqrt(mjx*mjx + mjy*mjy);
    const ry  = rx * rat;
    const ang = Math.atan2(mjy, mjx);
    // Adaptive step count — use the larger radius to ensure smooth curves.
    const steps = _arcSegments(Math.max(rx, ry), Math.abs(ea - sa), 0.1);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = sa + (i/steps)*(ea-sa);
      pts.push([
        cx + rx*Math.cos(t)*Math.cos(ang) - ry*Math.sin(t)*Math.sin(ang),
        cy + rx*Math.cos(t)*Math.sin(ang) + ry*Math.sin(t)*Math.cos(ang)
      ]);
    }
    return pts;
  },

  /* ── helpers ─────────────────────────────────────────────────── */
  _gv(data, code, def=null) { const t=data.find(d=>d.code===code); return t?t.val:def; },
  _gf(data, code, def=0)   { const v=this._gv(data,code,null); return v!==null?parseFloat(v):def; },
  _gi(data, code, def=0)   { const v=this._gv(data,code,null); return v!==null?parseInt(v,10):def; },

  // Keep old aliases for backward-compat calls elsewhere
  getVal(d,c,def){ return this._gv(d,c,def); },
  getFloat(d,c,def){ return this._gf(d,c,def); },
  getInt(d,c,def){ return this._gi(d,c,def); },
  parseLWPolyline(d){ return this._parseLWPolyline(d); },
  parseCircle(d){ return this._parseCircle(d); },
  parseArc(d){ return this._parseArc(d); },
  parseSpline(d){ return this._parseSpline(d); },
  parseEllipse(d){ return this._parseEllipse(d); },
};


/* ═══════════════════════════════════════════════════════════════════
   SECTION 2: GEOMETRY UTILITIES
═══════════════════════════════════════════════════════════════════ */

/* Adaptive arc tessellation — pick N so chord-height error stays below
   `tolMm` (sagitta tolerance). Larger radius/arc ⇒ more segments.
   Formula: sagitta h = r (1 − cos(θ/(2N))).  Solve for N given h ≤ tol:
     θ/(2N) ≤ acos(1 − tol/r)   ⇒   N ≥ θ / (2 · acos(1 − tol/r))
   Default tol = 0.1 mm — smooth at typical zoom on screen and for cutting. */
function _arcSegments(r, angleRad, tolMm) {
  r = Math.abs(r);
  angleRad = Math.abs(angleRad);
  if (r < 0.05 || angleRad < 1e-4) return 4;
  const tol = tolMm === undefined ? 0.1 : tolMm;
  const ratio = Math.max(0, Math.min(1, tol / r));
  const maxStepAng = 2 * Math.acos(1 - ratio);
  if (!isFinite(maxStepAng) || maxStepAng <= 1e-6) return 256;
  return Math.max(8, Math.min(512, Math.ceil(angleRad / maxStepAng)));
}

function arcToPoints(cx, cy, r, startAngle, endAngle, n) {
  let range = endAngle - startAngle;
  if (range < 0) range += 2 * Math.PI;
  if (n === undefined) n = _arcSegments(r, range, 0.1);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = startAngle + (i / n) * range;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function bulgeToArcPoints(x1, y1, x2, y2, bulge, n) {
  if (Math.abs(bulge) < 1e-10) return [[x2, y2]];
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-10) return [[x2, y2]];
  const alpha = 2 * Math.atan(Math.abs(bulge));
  const r = d / (2 * Math.sin(alpha));
  const h = d / (2 * Math.tan(alpha));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const perpX = -dy / d, perpY = dx / d;
  const sign = bulge > 0 ? 1 : -1;
  const acx = mx + sign * h * perpX;
  const acy = my + sign * h * perpY;
  const startA = Math.atan2(y1 - acy, x1 - acx);
  const endA   = Math.atan2(y2 - acy, x2 - acx);
  let totalA;
  if (bulge > 0) totalA = endA < startA ? endA - startA + 2*Math.PI : endA - startA;
  else           totalA = endA > startA ? endA - startA - 2*Math.PI : endA - startA;
  const segs = n || _arcSegments(r, totalA, 0.1);
  const pts = [];
  for (let i = 1; i <= segs; i++) {
    const a = startA + (i / segs) * totalA;
    pts.push([acx + r * Math.cos(a), acy + r * Math.sin(a)]);
  }
  return pts;
}

/* ── B-SPLINE (NURBS) EVALUATION ────────────────────────────────────
   De Boor's algorithm — standard cubic/higher B-spline evaluation.
   `cp`  = control points [[x,y], …]
   `knots` = non-decreasing knot vector, length ≥ cp.length + degree + 1
   `t`   = parameter value in [knots[degree], knots[knots.length-1-degree]]
   Control points do NOT lie on the curve — the curve is PULLED toward them.
   This is the mathematically correct evaluation required for DXF SPLINE. */
function _evalBSpline(cp, knots, degree, t) {
  const n = cp.length;
  // Find knot span: largest k such that knots[k] ≤ t < knots[k+1]
  let k = degree;
  while (k < n - 1 && knots[k + 1] <= t) k++;

  // Local copy of the (degree+1) active control points
  const d = new Array(degree + 1);
  for (let j = 0; j <= degree; j++) {
    const idx = Math.max(0, Math.min(n - 1, k - degree + j));
    d[j] = [cp[idx][0], cp[idx][1]];
  }

  // De Boor recursion — lerp between neighbouring points using knot distances
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const a = denom === 0 ? 0 : (t - knots[i]) / denom;
      d[j][0] = (1 - a) * d[j-1][0] + a * d[j][0];
      d[j][1] = (1 - a) * d[j-1][1] + a * d[j][1];
    }
  }
  return d[degree];
}

/* Tessellate a B-spline. We walk through the DISTINCT knot spans inside
   [knots[degree], knots[n+1]] and take enough samples per span for each
   sub-segment to be visually smooth (≤ ~0.3 mm chord error for typical
   control-polygon sizes). */
function _tessellateBSpline(cp, knots, degree, closed) {
  if (!cp || cp.length < degree + 1) return null;
  const n = cp.length;
  const tMin = knots[degree];
  const tMax = knots[n]; // last valid parameter = knots[n + 1 - 1] = knots[n]

  // Collect distinct knot values within the valid domain
  const distinct = [tMin];
  for (let i = degree + 1; i <= n; i++) {
    if (knots[i] > distinct[distinct.length - 1] + 1e-9) distinct.push(knots[i]);
  }

  const pts = [];
  const pushPt = (t) => {
    const p = _evalBSpline(cp, knots, degree, t);
    // Skip near-duplicates of the previous point (keeps output clean)
    const last = pts[pts.length - 1];
    if (!last || Math.abs(p[0]-last[0]) > 1e-6 || Math.abs(p[1]-last[1]) > 1e-6) {
      pts.push([p[0], p[1]]);
    }
  };

  // Per span: pick segment count based on control-polygon chord length so
  // long smooth spans get proportionally more samples.
  for (let s = 0; s < distinct.length - 1; s++) {
    const t0 = distinct[s], t1 = distinct[s + 1];
    // Estimate span "size" via control-polygon span near this parameter
    const kIdx = Math.min(n - 1, Math.floor((t0 + t1) / 2 / tMax * (n - 1)));
    let chord = 0;
    for (let j = Math.max(0, kIdx - degree); j < Math.min(n - 1, kIdx + degree); j++) {
      chord += Math.hypot(cp[j+1][0] - cp[j][0], cp[j+1][1] - cp[j][1]);
    }
    const samples = Math.max(6, Math.min(40, Math.ceil(chord * 0.5)));
    for (let i = 0; i < samples; i++) {
      pushPt(t0 + (i / samples) * (t1 - t0));
    }
  }
  pushPt(tMax - 1e-9);

  // Close the loop with the starting point if the spline is flagged closed.
  if (closed && pts.length > 0) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.hypot(f[0]-l[0], f[1]-l[1]) > 0.5) pts.push([f[0], f[1]]);
  }
  return pts;
}

/* ── B-SPLINE END ───────────────────────────────────────────────────── */

/* Catmull-Rom fallback — used when a SPLINE has only fit points, or when
   no proper B-spline data is available. Each span gets enough sub-segments
   that each sub-step is ≤ ~0.5 mm, so long curves render as smoothly as
   tight ones. */
function catmullRom(pts, closed = false, tension = 0.5) {
  if (pts.length < 2) return pts;
  const result = [];
  const n = pts.length;
  const pext = closed ? [pts[n-1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[n-1]];
  for (let i = 1; i < pext.length - 2; i++) {
    const p0=pext[i-1], p1=pext[i], p2=pext[i+1], p3=pext[i+2];
    // Segment count proportional to chord length between p1 and p2.
    // ~2 segments per mm gives 0.5mm max step — smooth at normal zoom.
    const chord = Math.hypot(p2[0]-p1[0], p2[1]-p1[1]);
    const segs = Math.max(16, Math.min(96, Math.ceil(chord * 2)));
    for (let j = 0; j < segs; j++) {
      const t = j / segs;
      const t2=t*t, t3=t2*t;
      result.push([
        0.5*((2*p1[0])+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
        0.5*((2*p1[1])+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
      ]);
    }
  }
  result.push(pext[pext.length-2]);
  return result;
}

function splitPathAtGaps(pts, gapMm) {
  if (!pts || pts.length < 2) return pts ? [pts] : [];
  const gapSq = gapMm * gapMm;
  const subs = [], cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0]-pts[i-1][0], dy = pts[i][1]-pts[i-1][1];
    if (dx*dx + dy*dy > gapSq) {
      if (cur.length >= 2) subs.push([...cur]);
      cur.length = 0;
    }
    cur.push(pts[i]);
  }
  if (cur.length >= 2) subs.push(cur);
  return subs.length ? subs : [pts];
}


