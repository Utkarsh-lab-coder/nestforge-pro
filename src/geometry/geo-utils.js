/*
 * NestForge Pro — Basic geometry helpers (polyBBox, polyArea, translatePts, rotatePts, mirrorPts, normalizePoly, perim, sleep)
 *
 * Original location: lines 1997..2044 of nestforge-pro.html (48 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

function polyBBox(pts) {
  let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
  for (const [x,y] of pts) { if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
  return { x: x0, y: y0, w: x1-x0, h: y1-y0, cx: (x0+x1)/2, cy: (y0+y1)/2 };
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i+1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(a) / 2;
}

function translatePts(pts, dx, dy) { return pts.map(([x,y]) => [x+dx, y+dy]); }
function scalePts(pts, sx, sy, ox=0, oy=0) { return pts.map(([x,y]) => [ox+(x-ox)*sx, oy+(y-oy)*sy]); }

function rotatePts(pts, angleDeg, cx=0, cy=0) {
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return pts.map(([x,y]) => {
    const rx = x - cx, ry = y - cy;
    return [cx + rx*cos - ry*sin, cy + rx*sin + ry*cos];
  });
}

function mirrorPts(pts, axis) {
  if (axis === 'x') return pts.map(([x,y]) => [x, -y]);
  if (axis === 'y') return pts.map(([x,y]) => [-x, y]);
  return pts;
}

function normalizePoly(pts) {
  const bbox = polyBBox(pts);
  return { pts: translatePts(pts, -bbox.x, -bbox.y), bbox };
}

/* Shared helpers used by both raster + polygon engines. */
function perim(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i+1) % pts.length;
    p += Math.hypot(pts[j][0]-pts[i][0], pts[j][1]-pts[i][1]);
  }
  return p;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

