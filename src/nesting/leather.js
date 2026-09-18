/*
 * NestForge Pro — LeatherSheet — generate hide / cut shapes from HIDE_NORM data, defect helpers
 *
 * Original location: lines 11119..11511 of nestforge-pro.html (393 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const LeatherSheet = {
  /* Grade definitions — industry-standard defect percentages.
     defectCount = approximate # of defect spots (scaled by hide size).
     bellyBias = how strongly defects cluster toward belly edge (0-1). */
  GRADES: {
    'A': { name: 'A (Premium)',     defectPct: 0.025, defectCount: 4,  bellyBias: 0.9, color: '#2ecc71' },
    'B': { name: 'B (Select)',      defectPct: 0.05,  defectCount: 8,  bellyBias: 0.85, color: '#3498db' },
    'C': { name: 'C (Standard)',    defectPct: 0.10,  defectCount: 15, bellyBias: 0.75, color: '#f39c12' },
    'D': { name: 'D (Commercial)',  defectPct: 0.18,  defectCount: 25, bellyBias: 0.65, color: '#e67e22' },
    'E': { name: 'E (Utility)',     defectPct: 0.28,  defectCount: 40, bellyBias: 0.55, color: '#e74c3c' },
  },

  /* Sheet type templates with typical dimensions in mm.
     Dimensions reflect average bovine leather (cow hide, ~45 sq ft full). */
  TYPES: {
    'rectangle':  { name: 'Rectangle (Sheet)',   defaultW: 1200, defaultH: 600 },
    'full-hide':  { name: 'Full Hide',           defaultW: 1700, defaultH: Math.round(1700 * HIDE_NATIVE_ASPECT) },
    // Side = left half of hide cut along spine; natural aspect H/W ≈ 2.59 (tall + narrow)
    'side':       { name: 'Side (Half Hide)',    defaultW: 850,  defaultH: Math.round(850 * 2.588) },
    // Shoulder = top portion of hide; natural aspect H/W ≈ 0.60 (wide + short)
    'shoulder':   { name: 'Shoulder',            defaultW: 1700, defaultH: Math.round(1700 * 0.595) },
    // Belly = middle band containing butt + belly strips; aspect H/W ≈ 0.63
    'belly':      { name: 'Belly',               defaultW: 1700, defaultH: Math.round(1700 * 0.634) },
    // Bend = same region as belly per user preference
    'bend':       { name: 'Bend (Butt)',         defaultW: 1700, defaultH: Math.round(1700 * 0.634) },
    'custom':     { name: 'Custom (Imported)',   defaultW: 1200, defaultH: 800 },
  },

  /* Generate the outline polygon for a given sheet type.
     Returns { pts: [[x,y],...], bbox: {w, h} } with points in mm,
     origin at top-left corner of bounding box. */
  generateShape(type, W, H) {
    switch (type) {
      case 'rectangle': return this._rectangle(W, H);
      case 'full-hide': return this._fullHide(W, H);
      case 'side':      return this._side(W, H);
      case 'shoulder':  return this._shoulder(W, H);
      case 'belly':     return this._belly(W, H);
      case 'bend':      return this._bend(W, H);
      case 'custom':    return null; // caller supplies shape
      default:          return this._rectangle(W, H);
    }
  },

  _rectangle(W, H) {
    return { pts: [[0,0],[W,0],[W,H],[0,H]], bbox: {w: W, h: H} };
  },

  /* Full cow hide — silhouette traced directly from industry reference image
     (Shutterstock #1568513101 style "Quality Area of Hide" diagram).
     67 vertices forming a natural anatomical outline with:
       • Pointed neck at top
       • Shoulder widening out
       • Fore flanks extending fully to left/right edges
       • Wide butt and bellies in middle
       • Hind flanks with legs protruding
       • Narrow tail at bottom
     This is not parametric — it's the actual shape of a real hide diagram. */
  _fullHide(W, H) {
    // Uses the user-supplied HIDE.svg outline (imported at file top via
    // HIDE_OUTLINE_NORM, HIDE_ZONE_CURVES_NORM, HIDE_ZONE_LABELS_NORM).
    // All data is in normalized [0..1]² space relative to the hide's native
    // bbox. Here we scale uniformly to user-specified W×H dimensions.
    //
    // Note: the caller (App._makeSheet) should maintain the native aspect
    // ratio (HIDE_NATIVE_ASPECT) when computing H from W (or vice versa)
    // so the hide shape isn't distorted.
    const pts = HIDE_OUTLINE_NORM.map(([nx, ny]) => [nx * W, ny * H]);
    // Scale zone curves + labels to match
    const zoneCurves = HIDE_ZONE_CURVES_NORM.map(curve =>
      curve.map(([nx, ny]) => [nx * W, ny * H])
    );
    const zoneLabels = HIDE_ZONE_LABELS_NORM.map(lbl => ({
      x: lbl.nx * W,
      y: lbl.ny * H,
      text: lbl.text,
      rot: lbl.rot,
    }));
    return {
      pts,
      bbox: { w: W, h: H },
      zoneCurves,    // array of polylines (in mm)
      zoneLabels,    // array of { x, y, text, rot }
      nativeAspect: HIDE_NATIVE_ASPECT,  // H/W for the original design
    };
  },

  /* ═══════════════════════════════════════════════════════════════
     All sub-hide cuts below are DERIVED from the user's HIDE.svg by
     clipping the full hide outline against anatomical boundary lines.
     This guarantees all shapes are consistent with the master design.

     Key boundary fractions (based on the label positions / zone curves
     in the user's SVG):
       NECK top:            ny ≈ 0.08 (top of hide)
       Shoulder/Butt line:  ny ≈ 0.46 (horizontal curve 4+9)
       Butt/HindFlank line: ny ≈ 0.75
       Belly inner edges:   nx ≈ 0.22 (left), nx ≈ 0.78 (right)
       Spine:               nx = 0.50 (center)
  ═══════════════════════════════════════════════════════════════ */

  /* Clip the full hide outline against a rectangle in normalized space,
     then scale result. If preserveAspect is true, scale uniformly to fit
     within W×H (keeping the shape's natural proportions). Otherwise
     scale non-uniformly to exactly W×H.
     Returns { pts, bbox, zoneCurves, zoneLabels } just like _fullHide. */
  _cutFromHide(W, H, normClipRect, preserveAspect = true) {
    const nativeW = 1000;
    const nativeH = nativeW * HIDE_NATIVE_ASPECT;
    const hideNative = HIDE_OUTLINE_NORM.map(([nx, ny]) => [nx * nativeW, ny * nativeH]);
    const { x0, y0, x1, y1 } = normClipRect;
    const clipBoxNative = [
      [x0 * nativeW, y0 * nativeH],
      [x1 * nativeW, y0 * nativeH],
      [x1 * nativeW, y1 * nativeH],
      [x0 * nativeW, y1 * nativeH],
    ];
    let clipped = null;
    try {
      const result = PU.intersection([hideNative], [clipBoxNative]);
      if (result && result.length) {
        let best = result[0], bestArea = Math.abs(polyArea(best));
        for (let i = 1; i < result.length; i++) {
          const a = Math.abs(polyArea(result[i]));
          if (a > bestArea) { best = result[i]; bestArea = a; }
        }
        clipped = best;
      }
    } catch (e) { clipped = clipBoxNative; }
    if (!clipped || clipped.length < 3) {
      return this._rectangle(W, H);
    }
    const bb = polyBBox(clipped);

    // Scale factors — uniform (preserving aspect) or independent
    let scaleX, scaleY, finalW, finalH;
    if (preserveAspect) {
      // Use a single uniform scale so the shape doesn't distort.
      // Choose the scale that makes the cut fit within W×H.
      const sx = W / bb.w, sy = H / bb.h;
      const s = Math.min(sx, sy);
      scaleX = scaleY = s;
      finalW = bb.w * s;
      finalH = bb.h * s;
    } else {
      scaleX = W / bb.w;
      scaleY = H / bb.h;
      finalW = W;
      finalH = H;
    }

    const pts = clipped.map(([x, y]) => [(x - bb.x) * scaleX, (y - bb.y) * scaleY]);
    // Scale zone curves + labels with same factors
    const zoneCurves = [];
    for (const curve of HIDE_ZONE_CURVES_NORM) {
      const curveNative = curve.map(([nx, ny]) => [nx * nativeW, ny * nativeH]);
      const kept = curveNative.filter(([x, y]) =>
        x >= clipBoxNative[0][0] && x <= clipBoxNative[2][0] &&
        y >= clipBoxNative[0][1] && y <= clipBoxNative[2][1]
      );
      if (kept.length >= 2) {
        zoneCurves.push(kept.map(([x, y]) => [(x - bb.x) * scaleX, (y - bb.y) * scaleY]));
      }
    }
    const zoneLabels = [];
    for (const lbl of HIDE_ZONE_LABELS_NORM) {
      const lx = lbl.nx * nativeW, ly = lbl.ny * nativeH;
      if (lx >= clipBoxNative[0][0] && lx <= clipBoxNative[2][0] &&
          ly >= clipBoxNative[0][1] && ly <= clipBoxNative[2][1]) {
        zoneLabels.push({
          x: (lx - bb.x) * scaleX,
          y: (ly - bb.y) * scaleY,
          text: lbl.text,
          rot: lbl.rot,
        });
      }
    }
    return { pts, bbox: { w: finalW, h: finalH }, zoneCurves, zoneLabels };
  },

  /* Side = left half of the hide cut along the spine (x=0.50).
     Straight spine edge on the right, natural hide curve on the left.
     Preserves aspect ratio (tall narrow shape) like a real side leather. */
  _side(W, H) {
    return this._cutFromHide(W, H, { x0: 0.00, y0: 0.00, x1: 0.50, y1: 1.00 }, true);
  },

  /* Shoulder = top portion of hide (above the shoulder/butt line).
     Includes neck, shoulder, and fore flank areas. */
  _shoulder(W, H) {
    return this._cutFromHide(W, H, { x0: 0.00, y0: 0.00, x1: 1.00, y1: 0.46 });
  },

  /* Belly = the full middle band of the hide — includes BUTT + both
     BELLY strips together (matching user's SVG layout). This represents
     the portion cut between the shoulder and hind flank regions. */
  _belly(W, H) {
    return this._cutFromHide(W, H, { x0: 0.00, y0: 0.46, x1: 1.00, y1: 0.95 });
  },

  /* Bend = same region as Belly (per user's SVG — the bend and belly
     together form the middle band of the hide). Kept as separate option
     in dropdown so users can pick whichever term their supplier uses. */
  _bend(W, H) {
    return this._cutFromHide(W, H, { x0: 0.00, y0: 0.46, x1: 1.00, y1: 0.95 });
  },


  /* Generate auto-defects based on grade and hide geometry.
     Returns [{ x, y, r, type, shape }, ...]  where shape is an irregular
     polygon approximating the defect outline (scar, hole, mark).
     Defects cluster near edges (especially belly/flank) since real hide
     defects (insect bites, brands, scars, barbed wire) are most common
     at these locations. */
  generateDefects(sheetType, W, H, grade, seed = 12345) {
    const g = this.GRADES[grade] || this.GRADES['C'];
    let s = seed;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

    const defects = [];
    const totalArea = W * H;
    const targetArea = totalArea * g.defectPct;
    const avgArea = targetArea / g.defectCount;
    const avgRadius = Math.sqrt(avgArea / Math.PI);

    for (let i = 0; i < g.defectCount; i++) {
      const r = avgRadius * (0.5 + rnd() * 1.3);

      // Position: bias toward belly/flank for realism
      let x, y;
      if (sheetType === 'full-hide' || sheetType === 'side' || sheetType === 'belly') {
        const bias = g.bellyBias;
        if (rnd() < bias) {
          x = W * (0.1 + rnd() * 0.8);
          y = H * (0.6 + rnd() * 0.35);
        } else {
          x = W * (0.05 + rnd() * 0.9);
          y = H * (0.05 + rnd() * 0.9);
        }
      } else {
        x = W * (0.05 + rnd() * 0.9);
        y = H * (0.05 + rnd() * 0.9);
      }

      const types = ['scar', 'hole', 'mark', 'scratch'];
      const type = types[Math.floor(rnd() * types.length)];

      // Generate an IRREGULAR BLOB shape for this defect — not a perfect
      // circle. Real scars/bites have uneven outlines. We vary the radius
      // around the center with pseudo-random noise at different angles.
      const shape = [];
      const numPts = 12 + Math.floor(rnd() * 8);  // 12-19 vertices
      // Two layers of noise — low-frequency gives overall lobe shape,
      // high-frequency gives rough edges
      const seed1 = rnd() * 100;
      const seed2 = rnd() * 100;
      const elong = 0.7 + rnd() * 0.6;   // 0.7-1.3 elongation ratio
      const elongAngle = rnd() * Math.PI; // random orientation of elongation
      for (let p = 0; p < numPts; p++) {
        const ang = (p / numPts) * Math.PI * 2;
        // Low-freq: 2-3 big lobes
        const lowFreq = Math.sin(ang * 2 + seed1) * 0.15 + Math.sin(ang * 3 + seed1 * 1.7) * 0.08;
        // High-freq: small bumps
        const highFreq = Math.sin(ang * 7 + seed2) * 0.06 + Math.sin(ang * 11 + seed2 * 0.3) * 0.04;
        const radiusFactor = 1.0 + lowFreq + highFreq;
        // Apply elongation: stretch along elongAngle direction
        const localR = r * radiusFactor;
        // Transform: rotate point by -elongAngle, stretch, rotate back
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const ea = elongAngle;
        // Direct calculation of ellipse-like radius at this angle
        const da = ang - ea;
        const stretchFactor = Math.sqrt(
          Math.pow(Math.cos(da) * elong, 2) +
          Math.pow(Math.sin(da), 2)
        );
        const rr = localR * stretchFactor;
        shape.push([x + rr * ca, y + rr * sa]);
      }

      defects.push({ x, y, r, type, shape, id: 'def_' + i + '_' + seed });
    }
    return defects;
  },

  /* Convert a defect (circle) to a polygon for use as a "forbidden zone" in
     the nester. We represent defects as small polygons so they can be
     unioned with NFPs to exclude those areas from placement. */
  defectToPolygon(defect, resolution = 16) {
    const pts = [];
    for (let i = 0; i < resolution; i++) {
      const t = i / resolution;
      const ang = t * Math.PI * 2;
      pts.push([defect.x + defect.r * Math.cos(ang), defect.y + defect.r * Math.sin(ang)]);
    }
    return pts;
  },

  /* Check if a placed part polygon overlaps any defect. Returns true if so.
     Uses the defect's irregular shape polygon if present, otherwise falls
     back to the circle radius. */
  overlapsDefects(partPoly, defects) {
    if (!defects || !defects.length) return false;
    const bb = PU.bbox(partPoly);
    for (const d of defects) {
      // Quick bbox check first — use r+shape padding as conservative bbox
      if (d.x + d.r < bb.minX || d.x - d.r > bb.maxX) continue;
      if (d.y + d.r < bb.minY || d.y - d.r > bb.maxY) continue;

      if (d.shape && d.shape.length >= 3) {
        // Fast ray-cast PIP (avoid Clipper overhead)
        const pip = (poly, px, py) => {
          const n = poly.length;
          let inside = false;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = poly[i][0], yi = poly[i][1];
            const xj = poly[j][0], yj = poly[j][1];
            if ((yi > py) !== (yj > py)) {
              const xIntersect = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
              if (px < xIntersect) inside = !inside;
            }
          }
          return inside;
        };
        // (1) Any defect vertex inside part polygon → overlap
        for (let k = 0; k < d.shape.length; k++) {
          if (pip(partPoly, d.shape[k][0], d.shape[k][1])) return true;
        }
        // (2) Any part vertex inside defect polygon → overlap
        for (let k = 0; k < partPoly.length; k++) {
          if (pip(d.shape, partPoly[k][0], partPoly[k][1])) return true;
        }
        // (3) Edge intersection (vertex test misses pure edge crossings)
        for (let i = 0; i < partPoly.length; i++) {
          const [pax, pay] = partPoly[i];
          const [pbx, pby] = partPoly[(i+1) % partPoly.length];
          for (let j = 0; j < d.shape.length; j++) {
            const [dax, day] = d.shape[j];
            const [dbx, dby] = d.shape[(j+1) % d.shape.length];
            if (_segSegIntersect(pax, pay, pbx, pby, dax, day, dbx, dby)) return true;
          }
        }
      } else {
        // Fallback: circle-based check (legacy defects without .shape)
        if (PU.contains(partPoly, [d.x, d.y])) return true;
        for (const [x, y] of partPoly) {
          const dx = x - d.x, dy = y - d.y;
          if (dx*dx + dy*dy < d.r*d.r) return true;
        }
        for (let i = 0; i < partPoly.length; i++) {
          const [ax, ay] = partPoly[i];
          const [bx, by] = partPoly[(i+1) % partPoly.length];
          const vx = bx - ax, vy = by - ay;
          const wx = d.x - ax, wy = d.y - ay;
          const len2 = vx*vx + vy*vy;
          if (len2 < 1e-9) continue;
          let t = (wx*vx + wy*vy) / len2;
          t = Math.max(0, Math.min(1, t));
          const px = ax + t*vx, py = ay + t*vy;
          const ddx = px - d.x, ddy = py - d.y;
          if (ddx*ddx + ddy*ddy < d.r*d.r) return true;
        }
      }
    }
    return false;
  },

  /* Check if a placed part polygon is fully inside the sheet outline.
     Uses fast ray-casting point-in-polygon (no Clipper allocations). */
  insideSheet(partPoly, sheetOutline) {
    if (!sheetOutline || !sheetOutline.length) return true;
    const n = sheetOutline.length;
    for (let p = 0; p < partPoly.length; p++) {
      const px = partPoly[p][0], py = partPoly[p][1];
      // Ray-casting test — count edge crossings to the right of (px, py)
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = sheetOutline[i][0], yi = sheetOutline[i][1];
        const xj = sheetOutline[j][0], yj = sheetOutline[j][1];
        if ((yi > py) !== (yj > py)) {
          const xIntersect = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
          if (px < xIntersect) inside = !inside;
        }
      }
      if (!inside) return false;
    }
    return true;
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION B: NFP / IFP COMPUTATION
══════════════════════════════════════════════════════════════════════════════ */

