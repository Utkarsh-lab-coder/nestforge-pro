
const ClipperLib = window.ClipperLib;


/* ═══════════════════════════════════════════════════════════════════════════
   POLY-NEST ENGINE  —  Polygon No-Fit Polygon (NFP) based nester
   ═══════════════════════════════════════════════════════════════════════════
   Replaces the raster/skyline engine with a Minkowski-difference NFP
   approach using Angus Johnson's Clipper library (bundled inline above).

   ── ALGORITHM OVERVIEW ────────────────────────────────────────────────────
   For each part we want to place:
     1. Compute Inner-Fit Polygon (IFP) = feasible ref-point positions inside
        the sheet boundary.
     2. For each already-placed part, compute NFP(placed, newPart) =
        MinkowskiSum(placed, -newPart). Translate to world coords.
     3. Feasible region = IFP \ union(NFPs)  (Clipper Difference).
     4. Pick bottom-left vertex of the feasible region by a lexicographic
        cost (lowest Y, then lowest X, with tight-to-existing-parts bonus).
     5. Try all allowed rotations/mirrors; keep the variant with best cost.
     6. Place there; repeat.

   ── WHY THIS BEATS RASTER ────────────────────────────────────────────────
   • Exact polygon contact — no 1–2mm cell rounding error
   • True concave interlocking — NFP naturally captures spoon-fit geometry
   • Gap is an exact offset (ClipperOffset) not a pixel dilation
   • Works at any scale — 1200mm sheet or 4000mm sheet, same precision

   ── TRADE-OFFS ───────────────────────────────────────────────────────────
   • Slower per placement (~10–100ms vs raster's ~1ms)
   • Failure modes are geometric (self-intersection, numerical) rather
     than algorithmic. Mitigated by: polygon cleaning before NFP, integer
     arithmetic via CLIPPER_SCALE, validation asserts.
   • Won't handle truly broken input — requires closed simple polygons.
══════════════════════════════════════════════════════════════════════════════ */


