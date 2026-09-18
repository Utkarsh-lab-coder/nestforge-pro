/*
 * NestForge Pro — NestEngine wrapper — picks raster vs polygon based on window.__useRasterEngine
 *
 * Original location: lines 13254..13268 of nestforge-pro.html (15 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const NestEngine = {
  nest(...args) {
    const E = window.__useRasterEngine ? NestEngineRaster : PolyNestEngine;
    return E.nest.apply(E, args);
  },
  flowNest(...args) {
    const E = window.__useRasterEngine ? NestEngineRaster : PolyNestEngine;
    return E.flowNest.apply(E, args);
  },
};


/* ═══════════════════════════════════════════════════════════════════
   SECTION 5: CANVAS RENDERER
═══════════════════════════════════════════════════════════════════ */

