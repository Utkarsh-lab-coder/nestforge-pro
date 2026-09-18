/*
 * NestForge Pro — PolyUtils (PU) — Clipper-based polygon operations
 *
 * Original location: lines 10732..10964 of nestforge-pro.html (233 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const PU = {  // PolyUtils

  // Point array [[x,y],...] → Clipper IntPoint array
  toCL(pts) {
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      out[i] = { X: Math.round(pts[i][0] * CLIPPER_SCALE),
                 Y: Math.round(pts[i][1] * CLIPPER_SCALE) };
    }
    return out;
  },

  // Clipper IntPoint array → point array
  fromCL(path) {
    const out = new Array(path.length);
    for (let i = 0; i < path.length; i++) {
      out[i] = [path[i].X / CLIPPER_SCALE, path[i].Y / CLIPPER_SCALE];
    }
    return out;
  },

  // Array of point-arrays → array of Clipper paths
  toCLPaths(polys) { return polys.map(p => PU.toCL(p)); },
  fromCLPaths(paths) { return paths.map(p => PU.fromCL(p)); },

  // Signed area in world units (positive = CCW)
  signedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const j = (i + 1) % n;
      a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    return a * 0.5;
  },

  area(pts) { return Math.abs(PU.signedArea(pts)); },

  bbox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    // Return both naming conventions to be compatible with callers using
    // either `bb.minX/maxX` or `bb.x/bb.y` (the latter matches polyBBox()
    // from geo-utils.js). Mismatched naming caused undefined arithmetic
    // → NaN propagation → broken bound checks in Phase 4.
    return { minX, minY, maxX, maxY, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  },

  translate(pts, dx, dy) {
    return pts.map(([x, y]) => [x + dx, y + dy]);
  },

  rotate(pts, deg, cx = 0, cy = 0) {
    const r = deg * Math.PI / 180;
    const c = Math.cos(r), s = Math.sin(r);
    return pts.map(([x, y]) => {
      const dx = x - cx, dy = y - cy;
      return [cx + dx * c - dy * s, cy + dx * s + dy * c];
    });
  },

  mirror(pts, axis) {
    if (axis === 'x') return pts.map(([x, y]) => [x, -y]);
    if (axis === 'y') return pts.map(([x, y]) => [-x, y]);
    return pts.slice();
  },

  negate(pts) { return pts.map(([x, y]) => [-x, -y]); },

  // Ensure CCW winding (outer polygon convention for Clipper)
  ensureCCW(pts) {
    return PU.signedArea(pts) < 0 ? pts.slice().reverse() : pts;
  },

  // Ensure CW winding (hole convention)
  ensureCW(pts) {
    return PU.signedArea(pts) > 0 ? pts.slice().reverse() : pts;
  },

  // Clean: remove duplicate/colinear points and close gaps
  clean(pts, epsilon = 0.001) {
    if (pts.length < 3) return pts;
    const cl = PU.toCL(pts);
    const cleaned = ClipperLib.Clipper.CleanPolygon(cl, epsilon * CLIPPER_SCALE);
    if (cleaned.length < 3) return pts; // cleaning would destroy it
    return PU.fromCL(cleaned);
  },

  // Douglas-Peucker simplification — reduce vertex count while preserving shape.
  // tol = maximum allowed deviation in world units (mm). Critical for NFP perf:
  // Minkowski sum is O(n*m) in vertex counts, so simplifying a 60-vert vamp
  // down to 20 verts is a 9× speedup on every NFP call.
  simplifyDP(pts, tol) {
    if (pts.length < 4) return pts.slice();
    const n = pts.length;
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n-1] = 1;

    const perpDist = (p, a, b) => {
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const len2 = dx*dx + dy*dy;
      if (len2 < 1e-12) {
        const ex = p[0]-a[0], ey = p[1]-a[1];
        return Math.sqrt(ex*ex + ey*ey);
      }
      const t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / len2;
      const px = a[0] + t*dx, py = a[1] + t*dy;
      const ex = p[0]-px, ey = p[1]-py;
      return Math.sqrt(ex*ex + ey*ey);
    };

    const stack = [[0, n-1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      let maxD = 0, maxI = -1;
      for (let i = lo+1; i < hi; i++) {
        const d = perpDist(pts[i], pts[lo], pts[hi]);
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > tol && maxI > 0) {
        keep[maxI] = 1;
        stack.push([lo, maxI], [maxI, hi]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    // For closed polygon: handle wrap (simplify the last->first edge too)
    // If result is already small, leave it
    return out.length >= 3 ? out : pts.slice();
  },

  // Simplify self-intersecting poly into union of simple polys
  simplify(pts) {
    const cl = PU.toCL(pts);
    const result = ClipperLib.Clipper.SimplifyPolygon(cl, ClipperLib.PolyFillType.pftNonZero);
    return PU.fromCLPaths(result);
  },

  // Offset a polygon (positive = grow, negative = shrink). Returns array of polys.
  offset(pts, dist, joinType = 'miter') {
    const co = new ClipperLib.ClipperOffset(2.0, 0.25);
    const jt = joinType === 'round' ? ClipperLib.JoinType.jtRound
             : joinType === 'square' ? ClipperLib.JoinType.jtSquare
             : ClipperLib.JoinType.jtMiter;
    co.AddPath(PU.toCL(pts), jt, ClipperLib.EndType.etClosedPolygon);
    const result = new ClipperLib.Paths();
    co.Execute(result, dist * CLIPPER_SCALE);
    return PU.fromCLPaths(result);
  },

  // Offset the first path only, returning a single polygon (or null)
  offsetSingle(pts, dist, joinType = 'miter') {
    const result = PU.offset(pts, dist, joinType);
    if (!result.length) return null;
    // Return the largest (by area)
    let best = result[0], ba = PU.area(best);
    for (let i = 1; i < result.length; i++) {
      const a = PU.area(result[i]);
      if (a > ba) { best = result[i]; ba = a; }
    }
    return best;
  },

  // Boolean ops
  union(polys) {
    if (!polys.length) return [];
    const c = new ClipperLib.Clipper();
    c.AddPaths(PU.toCLPaths(polys), ClipperLib.PolyType.ptSubject, true);
    const result = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, result,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return PU.fromCLPaths(result);
  },

  difference(subjects, clips) {
    if (!subjects.length) return [];
    if (!clips.length) return subjects.slice();
    const c = new ClipperLib.Clipper();
    c.AddPaths(PU.toCLPaths(subjects), ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(PU.toCLPaths(clips), ClipperLib.PolyType.ptClip, true);
    const result = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctDifference, result,
      ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftNonZero);
    return PU.fromCLPaths(result);
  },

  intersection(subjects, clips) {
    const c = new ClipperLib.Clipper();
    c.AddPaths(PU.toCLPaths(subjects), ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(PU.toCLPaths(clips), ClipperLib.PolyType.ptClip, true);
    const result = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctIntersection, result,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return PU.fromCLPaths(result);
  },

  // True if point is inside poly (uses Clipper's robust PointInPolygon)
  contains(poly, pt) {
    const cp = PU.toCL(poly);
    const ip = { X: Math.round(pt[0] * CLIPPER_SCALE), Y: Math.round(pt[1] * CLIPPER_SCALE) };
    const r = ClipperLib.Clipper.PointInPolygon(ip, cp);
    return r !== 0; // 0 = outside, 1 = inside, -1 = on edge
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   LEATHER SHEET MODULE
   ─────────────────────────────────────────────────────────────────────
   Generates realistic leather hide shapes and auto-populates defect
   zones based on industry-standard grade classifications.

   Industry knowledge encoded here:
   • Bovine hide ~45-55 sq ft full, ~22-28 sq ft per side
   • Shoulder: upper ~20% of side (neck area)
   • Belly: lower ~25% (flanks, more defects)
   • Bend: middle butt area (~55%, cleanest leather)
   • Grades: A=2-3% defect area, B=5%, C=10%, D=18%, E=28%
   • Defects concentrate on belly/flank, rare on butt
══════════════════════════════════════════════════════════════════════════════ */
/* Segment-segment intersection test. Returns true if [p1,p2] crosses [p3,p4].
   Used by LeatherSheet defect overlap check. */
function _segSegIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// ════════ Auto-generated from user-supplied HIDE.svg ════════
// Hide outline + zone boundaries + labels, all normalized to [0,1]²
// relative to the hide's native bounding box.
// Native bbox: 14993 × 19403 SVG units
// Aspect ratio (H/W): 1.294117


