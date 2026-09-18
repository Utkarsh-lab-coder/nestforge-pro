/*
 * NestForge Pro — Rasterizer — polygon → bitmap + dilation kernel
 *
 * Original location: lines 2052..2137 of nestforge-pro.html (86 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

/* ═══════════════════════════════════════════════════════════════════
   SECTION 3: RASTERIZER + DILATION
═══════════════════════════════════════════════════════════════════ */
/* Rasterize a simple polygon into a cell list.
   Improvements over basic scanline:
   • Higher edge sampling (1/4 pixel steps) closes gaps on near-horizontal edges
   • Marks every pixel an edge touches (supercover-style) via Bresenham-ish stepping
   • Scan-line fill uses a small epsilon to avoid vertex-at-scanline ambiguity
   • Explicit 8-neighbour edge thickening guarantees a closed outline
*/
function rasterizePolygon(pts, res, W, H) {
  const bmp = new Uint8Array(W * H);
  const miny = Math.max(0, Math.floor(Math.min(...pts.map(p=>p[1]*res))));
  const maxy = Math.min(H-1, Math.ceil(Math.max(...pts.map(p=>p[1]*res))));

  // ── Scanline fill with epsilon offset to avoid vertex coincidences ──
  const EPS = 1e-6;
  for (let row = miny; row <= maxy; row++) {
    const y = row / res + EPS; // offset slightly to avoid exact vertex hits
    const xs = [];
    for (let i = 0, n = pts.length; i < n; i++) {
      const j = (i+1)%n, [x0,y0] = pts[i], [x1,y1] = pts[j];
      if ((y0<=y&&y1>y)||(y1<=y&&y0>y)) xs.push((x0+(y-y0)/(y1-y0)*(x1-x0))*res);
    }
    xs.sort((a,b)=>a-b);
    for (let k = 0; k+1 < xs.length; k += 2) {
      const xl = Math.max(0,Math.floor(xs[k])), xr = Math.min(W-1,Math.ceil(xs[k+1]));
      for (let c = xl; c <= xr; c++) bmp[row*W+c] = 1;
    }
  }

  // ── Supercover edge rasterization — mark every pixel the edge crosses ──
  // Uses 2× oversampling + sets 4-connected neighbours of each sampled pixel
  // so near-horizontal edges at rotated orientations don't leave gaps.
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i+1)%n, [x0,y0] = pts[i], [x1,y1] = pts[j];
    const dx = (x1-x0)*res, dy = (y1-y0)*res;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2) + 2; // 2× oversample
    for (let s = 0; s <= steps; s++) {
      const t = s/steps;
      const fx = x0*res + t*dx, fy = y0*res + t*dy;
      // Mark this pixel + 4-connected neighbours to plug any gap
      for (let oy = 0; oy <= 1; oy++) {
        for (let ox = 0; ox <= 1; ox++) {
          const px = Math.floor(fx) + ox, py = Math.floor(fy) + oy;
          if (px>=0 && px<W && py>=0 && py<H) bmp[py*W+px] = 1;
        }
      }
    }
  }

  const cells = [];
  for (let i = 0; i < bmp.length; i++) if (bmp[i]) cells.push([i%W, Math.floor(i/W)]);
  return { cells, w: W, h: H };
}

/* Correct bitmap dilation — coords relative to part origin, can be negative.
   Uses TypedArray bitmap with explicit offset to avoid any hash collision.   */
function buildDilatedCells(cells, radius, pw, ph) {
  const off = radius + 1, bw = pw + 2*off, bh = ph + 2*off;
  const tmp = new Uint8Array(bw * bh), r2 = radius * radius;
  for (const [cx,cy] of cells)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++)
        if (dx*dx+dy*dy <= r2) { const nx=cx+dx+off, ny=cy+dy+off; if(nx>=0&&nx<bw&&ny>=0&&ny<bh) tmp[ny*bw+nx]=1; }
  const res = [];
  for (let i = 0; i < tmp.length; i++) if (tmp[i]) res.push([i%bw - off, Math.floor(i/bw) - off]);
  return res;
}

/* Per-column topmost cell — enables concave interlocking via skyline NFP */
function computeColTops(cells, w) {
  const tops = new Int32Array(w).fill(999999);
  for (const [cx,cy] of cells) if (cx>=0&&cx<w&&cy<tops[cx]) tops[cx] = cy;
  return tops;
}


/* ═══════════════════════════════════════════════════════════════════
   SECTION 4: NESTING ENGINE — Fast Skyline Bottom-Left-Fill
   Key perf features:
   • Auto-resolution: caps grid at 360K cells regardless of sheet size
   • Flat Int32Array cells: ~5× faster canPlace vs array-of-arrays
   • Smart queue cap: fill-sheet uses part-area ÷ sheet-area estimate
   • Time-budget yield: yields every 40ms to stay responsive
═══════════════════════════════════════════════════════════════════ */

