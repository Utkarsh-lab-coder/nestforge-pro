/*
 * NestForge Pro — NFP / IFP computation — Minkowski difference for nesting
 *
 * Original location: lines 11512..11600 of nestforge-pro.html (89 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const NFP = {

  /* Compute NFP(A, B) = Minkowski sum of A with −B.
     The result is the set of positions where B's reference point
     (its own origin) can be such that B touches but does not overlap A.
     Returns {outer, holes} — outer boundary(s) where B can orbit around A,
     holes where B fits INSIDE a concavity of A (important for interlocking).
  */
  compute(aPoly, bPoly) {
    const aCL = PU.toCL(PU.ensureCCW(aPoly));
    const negB = PU.negate(bPoly);
    const negBCL = PU.toCL(negB);

    // Clipper.MinkowskiSum(pattern, path, pathIsClosed)
    // Docs: Minkowski sum = union of all translations of `pattern` by each
    // vertex of `path`. With path = negB (closed), this gives A ⊕ (-B).
    const result = ClipperLib.Clipper.MinkowskiSum(aCL, negBCL, true);

    const outer = [], holes = [];
    for (const path of result) {
      const areaSigned = ClipperLib.Clipper.Area(path); // CL integer area
      const poly = PU.fromCL(path);
      if (areaSigned > 0) outer.push(poly);      // CCW = outer
      else if (areaSigned < 0) holes.push(poly); // CW = hole
    }
    return { outer, holes };
  },

  /* Compute IFP — where B's reference point can go so B is ENTIRELY inside
     the sheet rectangle [0, sheetW] × [0, sheetH].
     For a rectangular sheet, IFP is just the sheet shrunk by the part's
     bounding box offsets. We compute it exactly here.
  */
  computeIFP(sheetW, sheetH, bPoly) {
    const bb = PU.bbox(bPoly);
    // If part's bbox is [minX, minY, maxX, maxY] and ref point is origin,
    // then for part+ref to stay in [0,W]×[0,H]:
    //   −minX ≤ refX ≤ W − maxX
    //   −minY ≤ refY ≤ H − maxY
    const x0 = -bb.minX, x1 = sheetW - bb.maxX;
    const y0 = -bb.minY, y1 = sheetH - bb.maxY;
    if (x1 < x0 || y1 < y0) return null; // part too big for sheet
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  },

  /* NFP with gap enforcement. The "gap" = spacing between cut parts.
     We achieve this by offsetting A outward by gap/2 AND B outward by gap/2
     before computing NFP. Net effect: final placed parts have at least
     `gap` between their edges.
     For simplicity we pre-offset the A polygon (the placed part) by `gap`
     — single-side offset is equivalent numerically and cheaper.

     PERFORMANCE: Minkowski sum is O(n*m) where n,m = vertex counts.
     A 50-vertex × 50-vertex pair = 2500 sub-sums. Heavy for complex shapes.
     We aggressively simplify both polys before NFP — the resulting NFP
     boundary is approximate (within ~1mm), which translates to ~1mm
     placement imprecision. For leather/shoe parts (200mm scale) that's
     under 0.5% error — well within material tolerance.
  */
  computeWithGap(aPoly, bPoly, gap) {
    if (gap > 0) {
      // Square offset — clean gap enforcement without miter spikes, and
      // far fewer vertices than round (which subdivides corners into ~50
      // arc segments, blowing up NFP cost).
      const aOff = PU.offsetSingle(aPoly, gap, 'square');
      if (aOff) aPoly = aOff;
    }
    // Simplify both polys to reduce Minkowski sum cost (O(n*m)).
    // CRITICAL: simplification tolerance MUST be smaller than the gap,
    // otherwise simplification noise can eat into the gap and cause
    // parts to touch/overlap. We cap at gap/3 to guarantee the actual
    // minimum gap is at least 2*gap/3 of requested. For gap=2mm, tol
    // becomes 0.66mm. When no gap specified (gap=0), use 0.5mm minimum
    // for tight nesting without overlaps.
    const gapBasedMax = gap > 0 ? gap / 3 : 0.5;
    let aSimp = aPoly, bSimp = bPoly;
    if (aPoly.length > 16) {
      const aBB = PU.bbox(aPoly);
      const aTol = Math.max(0.3, Math.min(gapBasedMax, Math.max(aBB.w, aBB.h) * 0.008));
      aSimp = PU.simplifyDP(aPoly, aTol);
    }
    if (bPoly.length > 16) {
      const bBB = PU.bbox(bPoly);
      const bTol = Math.max(0.3, Math.min(gapBasedMax, Math.max(bBB.w, bBB.h) * 0.008));
      bSimp = PU.simplifyDP(bPoly, bTol);
    }
    return NFP.compute(aSimp, bSimp);
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION C: POLY-NEST ENGINE
══════════════════════════════════════════════════════════════════════════════ */

