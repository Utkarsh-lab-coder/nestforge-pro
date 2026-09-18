/* NestForge Pro — SVG Parser
 * ──────────────────────────────────────────────────────────────────────
 * Parses SVG XML into the same `shapes[]` format produced by DXFParser:
 *   [{ type, pts: [[x,y], ...], layer, closed }, ...]
 *
 * Handles: <polygon>, <polyline>, <path> (M/L/C/Q/A/Z subset),
 * <rect>, <circle>, <ellipse>, <line>. Walks <g> groups and applies
 * `transform=` attributes (translate, scale, rotate, matrix).
 *
 * COORDINATE SYSTEM: SVG y-axis points DOWN. DXF/NestForge y-axis
 * points UP. We flip y here so the imported part renders right-side up
 * in the app. We also detect viewBox/transform sizing units (mm/in/etc)
 * via the SVG width="...mm" attribute when present.
 *
 * Layer assignment: SVG doesn't have layers. We use either:
 *   - The class= attribute if present
 *   - The stroke color converted to a layer name (e.g. "stroke_ff0000")
 *   - "default" otherwise
 *
 * Closed detection: <polygon>, <rect>, <circle>, <ellipse> are closed
 * by definition. <path> is closed if it ends with Z/z. <polyline>,
 * <line> are open. We also auto-detect when first ≈ last point.
 */
const SVGParser = {

  parse(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'image/svg+xml');
    const errNode = doc.querySelector('parsererror');
    if (errNode) {
      console.warn('[SVGParser] XML parse error:', errNode.textContent.slice(0, 200));
      return [];
    }
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') {
      console.warn('[SVGParser] Root element is not <svg>, got:', root && root.nodeName);
      return [];
    }

    // Determine unit scale from width="...mm" / height="...mm" / viewBox.
    // SVG default unit is 'pixels' (1px = 1 user unit). If width is in mm
    // we multiply through; else we leave coordinates as-is (user must
    // ensure their SVG was authored at 1 unit = 1mm, which is what DXF
    // exporters from CAD tools typically produce).
    const unitScale = this._inferUnitScale(root);

    const shapes = [];
    this._walk(root, this._identityMatrix(), shapes);

    // Apply unit scale + Y-flip to all collected shapes.
    // We flip Y around the centroid of all points so the result lands
    // in positive coordinates rather than going negative — mirroring what
    // `dxf-parser.js` does after parsing.
    if (shapes.length) {
      // Find global Y range
      let yMin = Infinity, yMax = -Infinity;
      for (const s of shapes) for (const p of s.pts) {
        if (p[1] < yMin) yMin = p[1];
        if (p[1] > yMax) yMax = p[1];
      }
      // Flip y around midpoint (keeps shape size identical, just mirror)
      // and apply unitScale to both axes
      for (const s of shapes) {
        s.pts = s.pts.map(p => [p[0] * unitScale, (yMax + yMin - p[1]) * unitScale]);
      }
    }

    // Auto-detect closed polylines (first ≈ last point)
    for (const s of shapes) {
      if (!s.closed && s.pts.length >= 4) {
        const dx = s.pts[0][0] - s.pts[s.pts.length - 1][0];
        const dy = s.pts[0][1] - s.pts[s.pts.length - 1][1];
        if (Math.hypot(dx, dy) < 0.5) {
          s.closed = true;
          s.pts.pop();  // drop duplicate closing point
        }
      }
    }

    return shapes;
  },

  /* ── Unit scale inference ─────────────────────────────────────────
     If width="..mm", return mm-per-user-unit ratio (using viewBox).
     If width="..in", convert to mm.
     If only viewBox is set, assume 1 user unit = 1 mm.
     If width is in px without viewBox, assume 1 user unit = 1 mm. */
  _inferUnitScale(root) {
    const widthAttr = root.getAttribute('width') || '';
    const heightAttr = root.getAttribute('height') || '';
    const viewBox = root.getAttribute('viewBox') || '';
    // Match number+unit, e.g. "338.03mm", "12in", "100"
    const m = widthAttr.match(/^([0-9.+-eE]+)\s*(mm|cm|m|in|pt|pc|px)?\s*$/);
    if (!m) return 1;
    const numWidth = parseFloat(m[1]);
    const unit = (m[2] || 'px').toLowerCase();
    if (!isFinite(numWidth) || numWidth === 0) return 1;
    // Viewbox: "minX minY width height"
    let vbWidth = numWidth;
    if (viewBox) {
      const vb = viewBox.split(/[\s,]+/).map(Number);
      if (vb.length === 4 && isFinite(vb[2]) && vb[2] > 0) {
        vbWidth = vb[2];
      }
    }
    // Convert physical width to mm
    let mmWidth = numWidth;
    if (unit === 'cm') mmWidth = numWidth * 10;
    else if (unit === 'm') mmWidth = numWidth * 1000;
    else if (unit === 'in') mmWidth = numWidth * 25.4;
    else if (unit === 'pt') mmWidth = numWidth * 0.3528;  // 1pt = 1/72in
    else if (unit === 'pc') mmWidth = numWidth * 4.2333;  // 1pc = 12pt
    else if (unit === 'px') mmWidth = numWidth * 0.2646;  // 96dpi → 1px ≈ 0.2646mm
    // mm per user unit
    return mmWidth / vbWidth;
  },

  /* ── Tree walk ─────────────────────────────────────────────────────
     Recursive walk through SVG DOM. Each <g> may have a transform=
     attribute that composes with the parent transform. */
  _walk(node, parentMatrix, shapes) {
    if (!node) return;
    const tag = node.nodeName ? node.nodeName.toLowerCase() : '';
    let matrix = parentMatrix;
    const tAttr = node.getAttribute && node.getAttribute('transform');
    if (tAttr) {
      const m = this._parseTransform(tAttr);
      matrix = this._mulMatrix(parentMatrix, m);
    }

    const layer = this._inferLayer(node);

    if (tag === 'svg' || tag === 'g' || tag === 'symbol') {
      // Container — recurse children
      for (const child of node.childNodes) this._walk(child, matrix, shapes);
      return;
    }
    if (tag === 'defs' || tag === 'style' || tag === 'title' ||
        tag === 'desc' || tag === 'metadata' || tag === '#text' ||
        tag === '#comment') {
      return;  // ignore
    }

    if (tag === 'polygon') {
      const pts = this._parsePoints(node.getAttribute('points'));
      if (pts.length >= 3) {
        shapes.push({
          type: 'POLYGON', layer, closed: true,
          pts: this._applyMatrix(pts, matrix),
        });
      }
    } else if (tag === 'polyline') {
      const pts = this._parsePoints(node.getAttribute('points'));
      if (pts.length >= 2) {
        shapes.push({
          type: 'POLYLINE', layer, closed: false,
          pts: this._applyMatrix(pts, matrix),
        });
      }
    } else if (tag === 'line') {
      const x1 = parseFloat(node.getAttribute('x1')) || 0;
      const y1 = parseFloat(node.getAttribute('y1')) || 0;
      const x2 = parseFloat(node.getAttribute('x2')) || 0;
      const y2 = parseFloat(node.getAttribute('y2')) || 0;
      shapes.push({
        type: 'LINE', layer, closed: false,
        pts: this._applyMatrix([[x1, y1], [x2, y2]], matrix),
      });
    } else if (tag === 'rect') {
      const x = parseFloat(node.getAttribute('x')) || 0;
      const y = parseFloat(node.getAttribute('y')) || 0;
      const w = parseFloat(node.getAttribute('width')) || 0;
      const h = parseFloat(node.getAttribute('height')) || 0;
      if (w > 0 && h > 0) {
        const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        shapes.push({
          type: 'RECT', layer, closed: true,
          pts: this._applyMatrix(pts, matrix),
        });
      }
    } else if (tag === 'circle') {
      const cx = parseFloat(node.getAttribute('cx')) || 0;
      const cy = parseFloat(node.getAttribute('cy')) || 0;
      const r = parseFloat(node.getAttribute('r')) || 0;
      if (r > 0) {
        const segs = 64;
        const pts = [];
        for (let i = 0; i < segs; i++) {
          const a = (i / segs) * 2 * Math.PI;
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        shapes.push({
          type: 'CIRCLE', layer, closed: true,
          pts: this._applyMatrix(pts, matrix),
        });
      }
    } else if (tag === 'ellipse') {
      const cx = parseFloat(node.getAttribute('cx')) || 0;
      const cy = parseFloat(node.getAttribute('cy')) || 0;
      const rx = parseFloat(node.getAttribute('rx')) || 0;
      const ry = parseFloat(node.getAttribute('ry')) || 0;
      if (rx > 0 && ry > 0) {
        const segs = 64;
        const pts = [];
        for (let i = 0; i < segs; i++) {
          const a = (i / segs) * 2 * Math.PI;
          pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
        }
        shapes.push({
          type: 'ELLIPSE', layer, closed: true,
          pts: this._applyMatrix(pts, matrix),
        });
      }
    } else if (tag === 'path') {
      const d = node.getAttribute('d');
      if (d) {
        const subPaths = this._parsePathD(d);
        for (const sub of subPaths) {
          if (sub.pts.length >= 2) {
            shapes.push({
              type: 'PATH', layer, closed: sub.closed,
              pts: this._applyMatrix(sub.pts, matrix),
            });
          }
        }
      }
    } else if (tag === 'use' || tag === 'image' || tag === 'text') {
      // Not supported — would require resolving xlink:href or rendering text
      // to outlines. Skip silently.
      return;
    } else {
      // Unknown tag — recurse children just in case (some SVGs nest groups
      // inside non-standard wrappers)
      if (node.childNodes && node.childNodes.length) {
        for (const child of node.childNodes) this._walk(child, matrix, shapes);
      }
    }
  },

  /* ── Layer inference from class/stroke ─────────────────────────────
     Use the `class` attribute if present (treat first class name as
     layer). Otherwise use the stroke color as a stable layer key.
     This lets users color-code layers in their SVG editor (e.g.
     red strokes for inner cuts, black for outline) and have the
     app preserve that grouping. */
  _inferLayer(node) {
    if (!node || !node.getAttribute) return '0';
    const cls = node.getAttribute('class');
    if (cls) return cls.trim().split(/\s+/)[0];
    const stroke = node.getAttribute('stroke');
    if (stroke && stroke !== 'none') {
      // Normalize "#1f77b4" / "rgb(31,119,180)" / "blue" to a stable token
      return 'stroke_' + stroke.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 12);
    }
    return '0';
  },

  /* ── Parse "points" attribute ──────────────────────────────────────
     SVG point lists are space- or comma-separated x,y pairs:
       "10,20 30,40 50,60"  or  "10 20 30 40 50 60"
     Both are valid. We tokenize on any non-digit/non-period/non-minus
     and pair up. */
  _parsePoints(str) {
    if (!str) return [];
    const nums = (str.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      pts.push([nums[i], nums[i + 1]]);
    }
    return pts;
  },

  /* ── Path 'd' attribute parser ─────────────────────────────────────
     SVG path mini-language. Subset supported:
       M/m  moveto (absolute/relative)
       L/l  lineto
       H/h  horizontal line
       V/v  vertical line
       C/c  cubic Bezier (sampled into 16 line segments)
       S/s  smooth cubic (reflection of previous control point)
       Q/q  quadratic Bezier (sampled into 12 line segments)
       T/t  smooth quadratic
       A/a  elliptical arc (approximated as line segments)
       Z/z  close path
     Returns: array of {pts, closed} sub-paths. Each M starts a new
     sub-path; Z closes it.
     */
  _parsePathD(d) {
    const tokens = this._tokenizePathD(d);
    const subPaths = [];
    let cur = { pts: [], closed: false };
    let cx = 0, cy = 0;          // current point
    let sx = 0, sy = 0;          // sub-path start point
    let lastCubicCtrl = null;    // for S smooth-cubic reflection
    let lastQuadCtrl = null;     // for T smooth-quad reflection

    const startSub = () => {
      if (cur.pts.length) subPaths.push(cur);
      cur = { pts: [], closed: false };
    };

    let i = 0;
    let lastCmd = '';
    while (i < tokens.length) {
      const t = tokens[i];
      if (typeof t === 'string') {
        lastCmd = t;
        i++;
      } else {
        // Repeat last command for implicit continuation
        if (!lastCmd) { i++; continue; }
      }
      const cmd = lastCmd;
      const upper = cmd.toUpperCase();
      const rel = (cmd !== upper);

      const num = () => (i < tokens.length && typeof tokens[i] === 'number') ? tokens[i++] : 0;

      if (upper === 'M') {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        startSub();
        cur.pts.push([x, y]);
        cx = sx = x; cy = sy = y;
        lastCubicCtrl = null; lastQuadCtrl = null;
        // Subsequent number pairs after M become implicit L
        while (i < tokens.length && typeof tokens[i] === 'number') {
          let x2 = num(), y2 = num();
          if (rel) { x2 += cx; y2 += cy; }
          cur.pts.push([x2, y2]);
          cx = x2; cy = y2;
        }
      } else if (upper === 'L') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          let x = num(), y = num();
          if (rel) { x += cx; y += cy; }
          cur.pts.push([x, y]);
          cx = x; cy = y;
        }
        lastCubicCtrl = null; lastQuadCtrl = null;
      } else if (upper === 'H') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          let x = num();
          if (rel) x += cx;
          cur.pts.push([x, cy]);
          cx = x;
        }
        lastCubicCtrl = null; lastQuadCtrl = null;
      } else if (upper === 'V') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          let y = num();
          if (rel) y += cy;
          cur.pts.push([cx, y]);
          cy = y;
        }
        lastCubicCtrl = null; lastQuadCtrl = null;
      } else if (upper === 'C') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
          if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
          this._sampleCubic(cur.pts, cx, cy, x1, y1, x2, y2, x, y);
          cx = x; cy = y;
          lastCubicCtrl = [x2, y2]; lastQuadCtrl = null;
        }
      } else if (upper === 'S') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          // Reflection of last cubic control through current point
          const x1 = lastCubicCtrl ? 2*cx - lastCubicCtrl[0] : cx;
          const y1 = lastCubicCtrl ? 2*cy - lastCubicCtrl[1] : cy;
          let x2 = num(), y2 = num(), x = num(), y = num();
          if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
          this._sampleCubic(cur.pts, cx, cy, x1, y1, x2, y2, x, y);
          cx = x; cy = y;
          lastCubicCtrl = [x2, y2]; lastQuadCtrl = null;
        }
      } else if (upper === 'Q') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          let x1 = num(), y1 = num(), x = num(), y = num();
          if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
          this._sampleQuad(cur.pts, cx, cy, x1, y1, x, y);
          cx = x; cy = y;
          lastQuadCtrl = [x1, y1]; lastCubicCtrl = null;
        }
      } else if (upper === 'T') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          const x1 = lastQuadCtrl ? 2*cx - lastQuadCtrl[0] : cx;
          const y1 = lastQuadCtrl ? 2*cy - lastQuadCtrl[1] : cy;
          let x = num(), y = num();
          if (rel) { x += cx; y += cy; }
          this._sampleQuad(cur.pts, cx, cy, x1, y1, x, y);
          cx = x; cy = y;
          lastQuadCtrl = [x1, y1]; lastCubicCtrl = null;
        }
      } else if (upper === 'A') {
        while (i < tokens.length && typeof tokens[i] === 'number') {
          const rx = num(), ry = num();
          const xRot = num();
          const largeArc = num() ? 1 : 0;
          const sweep = num() ? 1 : 0;
          let x = num(), y = num();
          if (rel) { x += cx; y += cy; }
          this._sampleArc(cur.pts, cx, cy, x, y, rx, ry, xRot, largeArc, sweep);
          cx = x; cy = y;
          lastCubicCtrl = null; lastQuadCtrl = null;
        }
      } else if (upper === 'Z') {
        // Close path: line back to sub-path start, mark closed
        if (cur.pts.length >= 1) {
          // Avoid duplicating start point
          const last = cur.pts[cur.pts.length - 1];
          if (Math.hypot(last[0] - sx, last[1] - sy) > 1e-6) {
            cur.pts.push([sx, sy]);
          }
          cur.closed = true;
        }
        cx = sx; cy = sy;
        lastCubicCtrl = null; lastQuadCtrl = null;
      } else {
        // Unknown command — skip token
        if (typeof tokens[i] !== 'string') i++;
      }
    }
    if (cur.pts.length) subPaths.push(cur);
    return subPaths;
  },

  _tokenizePathD(d) {
    const tokens = [];
    const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let m;
    while ((m = re.exec(d)) !== null) {
      if (m[1]) tokens.push(m[1]);
      else tokens.push(parseFloat(m[2]));
    }
    return tokens;
  },

  /* ── Bezier sampling ──────────────────────────────────────────────
     Cubic Bezier sampled into 16 segments — adequate for smooth shapes
     at typical pattern resolution (vamp curves are 50-300mm so 16
     segments give 3-20mm chord error). Quadratic into 12 (simpler curve). */
  _sampleCubic(out, x0, y0, x1, y1, x2, y2, x3, y3) {
    const segs = 16;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const u = 1 - t;
      const x = u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3;
      const y = u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3;
      out.push([x, y]);
    }
  },
  _sampleQuad(out, x0, y0, x1, y1, x2, y2) {
    const segs = 12;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const u = 1 - t;
      const x = u*u*x0 + 2*u*t*x1 + t*t*x2;
      const y = u*u*y0 + 2*u*t*y1 + t*t*y2;
      out.push([x, y]);
    }
  },
  /* SVG elliptical arc — implementation via parametric form per W3C
     spec. For shoe patterns, arcs are common in rounded corners. */
  _sampleArc(out, x1, y1, x2, y2, rx, ry, xRot, largeArc, sweep) {
    if (rx === 0 || ry === 0) {
      out.push([x2, y2]);
      return;
    }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = xRot * Math.PI / 180;
    const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
    // Step 1: compute (x1', y1')
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p =  cosPhi*dx + sinPhi*dy;
    const y1p = -sinPhi*dx + cosPhi*dy;
    // Step 2: ensure radii are large enough
    let lambda = (x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry);
    if (lambda > 1) {
      const s = Math.sqrt(lambda);
      rx *= s; ry *= s;
    }
    // Step 3: compute (cx', cy')
    let factor = ((rx*rx)*(ry*ry) - (rx*rx)*(y1p*y1p) - (ry*ry)*(x1p*x1p)) /
                 ((rx*rx)*(y1p*y1p) + (ry*ry)*(x1p*x1p));
    factor = Math.max(0, factor);
    let coef = Math.sqrt(factor);
    if (largeArc === sweep) coef = -coef;
    const cxp =  coef * (rx*y1p)/ry;
    const cyp = -coef * (ry*x1p)/rx;
    // Step 4: compute (cx, cy)
    const cx = cosPhi*cxp - sinPhi*cyp + (x1+x2)/2;
    const cy = sinPhi*cxp + cosPhi*cyp + (y1+y2)/2;
    // Step 5: compute angles
    const ang = (ux, uy, vx, vy) => {
      const dot = ux*vx + uy*vy;
      const mag = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
      let a = Math.acos(Math.max(-1, Math.min(1, dot/mag)));
      if (ux*vy - uy*vx < 0) a = -a;
      return a;
    };
    const startAng = ang(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry);
    let deltaAng = ang((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
    if (!sweep && deltaAng > 0) deltaAng -= 2*Math.PI;
    if (sweep && deltaAng < 0) deltaAng += 2*Math.PI;
    // Sample
    const segs = Math.max(8, Math.ceil(Math.abs(deltaAng) / (Math.PI / 16)));
    for (let i = 1; i <= segs; i++) {
      const a = startAng + deltaAng * i / segs;
      const x = cosPhi*rx*Math.cos(a) - sinPhi*ry*Math.sin(a) + cx;
      const y = sinPhi*rx*Math.cos(a) + cosPhi*ry*Math.sin(a) + cy;
      out.push([x, y]);
    }
  },

  /* ── Transform parsing & matrix math ──────────────────────────────
     2D affine matrix: [a, b, c, d, e, f]
       x' = a*x + c*y + e
       y' = b*x + d*y + f
     Per CSS / SVG transform spec. */
  _identityMatrix() { return [1, 0, 0, 1, 0, 0]; },
  _mulMatrix(m1, m2) {
    return [
      m1[0]*m2[0] + m1[2]*m2[1],          // a
      m1[1]*m2[0] + m1[3]*m2[1],          // b
      m1[0]*m2[2] + m1[2]*m2[3],          // c
      m1[1]*m2[2] + m1[3]*m2[3],          // d
      m1[0]*m2[4] + m1[2]*m2[5] + m1[4],  // e
      m1[1]*m2[4] + m1[3]*m2[5] + m1[5],  // f
    ];
  },
  _applyMatrix(pts, m) {
    return pts.map(p => [
      m[0]*p[0] + m[2]*p[1] + m[4],
      m[1]*p[0] + m[3]*p[1] + m[5],
    ]);
  },
  _parseTransform(str) {
    let m = this._identityMatrix();
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*([^)]*)\s*\)/g;
    let match;
    while ((match = re.exec(str)) !== null) {
      const op = match[1];
      const args = (match[2].match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []).map(Number);
      let t;
      if (op === 'matrix' && args.length === 6) {
        t = args;
      } else if (op === 'translate') {
        const tx = args[0] || 0, ty = args[1] || 0;
        t = [1, 0, 0, 1, tx, ty];
      } else if (op === 'scale') {
        const sx = args[0] || 1, sy = args.length > 1 ? args[1] : sx;
        t = [sx, 0, 0, sy, 0, 0];
      } else if (op === 'rotate') {
        const a = (args[0] || 0) * Math.PI / 180;
        const cx = args[1] || 0, cy = args[2] || 0;
        const ca = Math.cos(a), sa = Math.sin(a);
        if (cx || cy) {
          // rotate around (cx, cy) = T(cx,cy) · R(a) · T(-cx,-cy)
          t = [ca, sa, -sa, ca,
               cx - cx*ca + cy*sa,
               cy - cx*sa - cy*ca];
        } else {
          t = [ca, sa, -sa, ca, 0, 0];
        }
      } else if (op === 'skewX') {
        const a = (args[0] || 0) * Math.PI / 180;
        t = [1, 0, Math.tan(a), 1, 0, 0];
      } else if (op === 'skewY') {
        const a = (args[0] || 0) * Math.PI / 180;
        t = [1, Math.tan(a), 0, 1, 0, 0];
      } else continue;
      m = this._mulMatrix(m, t);
    }
    return m;
  },
};

