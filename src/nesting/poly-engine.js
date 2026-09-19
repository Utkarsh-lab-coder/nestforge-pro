/*
 * NestForge Pro — PolyNestEngine — main polygon nester with zones, rotation pairing, bottom-up sweep
 *
 * Original location: lines 11601..13253 of nestforge-pro.html (1653 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const PolyNestEngine = {

  /* Public API — same shape as the raster NestEngine:
     async nest(partDefs, settings, onProgress, isCancelled)
       partDefs: [{id, name, color, pts:[[x,y],...], qty, innerLines:[...]}]
       settings: {sheetW, sheetH, margin, gap, rotations:[0,90,...],
                  mirrorMode, sortBy, copies, fillSheet, resolution}
       onProgress(pct, msg)
       isCancelled() -> bool
     Returns {placements, sheets, placed, unplaced, sheetCount, usableW,
              usableH, effRes}
  */
  async nest(partDefs, settings, onProgress, isCancelled, onPlacement) {
    const _emit = onPlacement || (() => {});
    const { sheetW, sheetH, margin, gap, rotations, mirrorMode,
            sortBy, copies, fillSheet, multiSheet } = settings;

    const usW = sheetW - 2 * margin, usH = sheetH - 2 * margin;

    onProgress(0, `Polygon NFP engine — sheet ${usW}×${usH}mm, gap ${gap}mm`);
    await sleep(0);

    // ── Build variants (rotations × mirrors, each a cleaned polygon) ──
    const mirrors = this.getMirrors(mirrorMode);
    const variantsByPart = new Map();
    const shapeHashByPart = new Map();  // partId → shape hash for NFP cache
    let totalVariants = 0;
    for (const p of partDefs) {
      const pRots = p._rotations || rotations;
      const pMirrors = p._mirrorMode ? this.getMirrors(p._mirrorMode) : mirrors;
      const vs = this.buildVariants(p.pts, pRots, pMirrors);
      variantsByPart.set(p.id, vs);
      totalVariants += vs.length;
      // Compute a stable shape hash — all parts with the same vertex
      // sequence get the same hash, so NFP cache lookups hit for
      // repeated copies of the same part. This is the key optimization
      // for "copies=N" scenarios where N copies of 1 DXF would otherwise
      // compute the same NFP N² times.
      shapeHashByPart.set(p.id, this._shapeHash(p.pts));
    }

    // ── Build placement queue ──
    // maxPerPart = how many copies of EACH partDef to queue.
    // 
    // fillSheet (Fill Entire Sheet button) INFLATES the queue to fill one
    // sheet maximally — historically used for "I have 1 vamp DXF, fit as
    // many as possible." But when user has uploaded N DISTINCT components
    // and just wants each placed once with overflow to new sheets, we
    // should NOT inflate — that turns 65 distinct parts into 2015 copies
    // and engine fills sheet 1 with overlapping copies + reports 0 unplaced.
    //
    // Heuristic: if user has ≥5 distinct components AND copies=1, they
    // clearly want "place each once," not "fill with copies of one."
    // In that case, ignore fillSheet's inflation — use copies=1.
    let maxPerPart;
    const distinctComponents = partDefs.length;
    const userWantsOverflow = (multiSheet && copies === 1 && distinctComponents >= 5);
    if (fillSheet && !userWantsOverflow) {
      const totalPartArea = partDefs.reduce((s, p) => s + PU.area(p.pts), 0) || 1;
      // AUTO-EXPAND override: when caller sets _autoExpandQueueCap, use
      // that as the limit instead of calculating from sheet area. This
      // makes auto-expand mode pack exactly N copies tightly across the
      // full width, ignoring the huge 50000mm sheet height.
      if (settings._autoExpandQueueCap) {
        maxPerPart = settings._autoExpandQueueCap;
        console.log(`[NestForge queue] auto-expand cap: ${distinctComponents} parts × ${maxPerPart} copies = ${distinctComponents * maxPerPart} queue`);
      } else {
        maxPerPart = Math.min(5000, Math.ceil((usW * usH) / totalPartArea) + 30);
        console.log(`[NestForge queue] fillSheet inflation: ${distinctComponents} parts × ${maxPerPart} copies = ${distinctComponents * maxPerPart} queue`);
      }
    } else {
      maxPerPart = copies;
      if (fillSheet && userWantsOverflow) {
        console.log(`[NestForge queue] fillSheet+multiSheet+${distinctComponents}_distinct_components → using overflow mode (copies=${copies}, NOT inflating)`);
      }
    }

    // ── Set-mode detection (same as raster) ──────────────────────
    const setCounts = new Map();
    if (settings.componentRules) {
      for (const [key, rule] of settings.componentRules) {
        if (rule && rule.setCount > 0) setCounts.set(key, rule.setCount);
      }
    }
    // ── Copies = complete sets ─────────────────────────────────────
    // "3 copies" of several parts means 3 complete sets: every part three
    // times, never 13 of one and 0 of another (1 copy: one of each first). On a sheet that is filled
    // (Fill button, hide) or fixed (multi-sheet) the queue is therefore
    // built set by set: set 1 of every part, then set 2, ... and only after
    // the last set any extras to top up the leftover space (Fill mode).
    // Plain Run Nesting on a growing sheet already ends with every copy
    // placed, so it keeps its biggest-first queue. A "Per Set" rule in the
    // component rules keeps its own, explicit set logic below.
    const derivedSets = setCounts.size === 0 && copies >= 1 && partDefs.length >= 2
                        && (fillSheet || multiSheet) && !settings._autoExpandQueueCap
                        && settings.setsFirst !== false;
    const setMode = setCounts.size > 0 || derivedSets;
    const nSetsWanted = derivedSets ? copies : 0;
    // How many complete sets a list of placements holds: the smallest count
    // of any part. This is the "N of each" the user asked for.
    const placedPerPart = (placements) => {
      const byId = new Map();
      for (const p of partDefs) byId.set(p.id, 0);
      for (const pl of placements) if (byId.has(pl.partId)) byId.set(pl.partId, byId.get(pl.partId) + 1);
      return partDefs.map(p => ({ id: p.id, name: p.name + (p._mustPairTag === 'mir' ? ' (mirrored)' : ''), placed: byId.get(p.id) }));
    };
    const countSets = (placements) => {
      let m = Infinity;
      for (const r of placedPerPart(placements)) if (r.placed < m) m = r.placed;
      return m === Infinity ? 0 : m;
    };

    // ── Zone centers (for polygon zone check) ──────────────────────
    // Pre-compute zone centers once; _zoneCheck is set per-part before placeBest
    this._zoneCenters = null;
    if (settings.sheetLabels && settings.sheetLabels.length) {
      this._zoneCenters = this._getZoneCenters(settings.sheetLabels);
    }
    // ── ZONE MASK: precompute classification at every grid cell ─────
    // Voronoi-by-labels is wrong near boundaries because label positions
    // don't match actual drawn boundary curves. The accurate classification
    // is: nearest zone center NOT separated from the point by any boundary
    // curve. But doing that at every _zoneCheck call is too slow
    // (O(centers × curves) per call).
    // Solution: precompute a 2D grid (resolution ~10mm) where each cell
    // stores its correctly-classified zone name. Runtime _zoneCheck becomes
    // a single array lookup — O(1).
    this._zoneMask = null;
    this._zoneMaskMeta = null;
    if (this._zoneCenters && settings.sheetZoneCurves && settings.sheetOutline) {
      const curves = [];
      for (const curve of settings.sheetZoneCurves) {
        for (let i = 1; i < curve.length; i++) {
          curves.push([curve[i-1][0], curve[i-1][1], curve[i][0], curve[i][1]]);
        }
      }
      const segSegIntersect = (x1,y1,x2,y2, x3,y3,x4,y4) => {
        const d = (x2-x1)*(y4-y3) - (y2-y1)*(x4-x3);
        if (Math.abs(d) < 1e-12) return false;
        const t = ((x3-x1)*(y4-y3) - (y3-y1)*(x4-x3)) / d;
        const u = ((x3-x1)*(y2-y1) - (y3-y1)*(x2-x1)) / d;
        return t >= 0 && t <= 1 && u >= 0 && u <= 1;
      };
      // Grid covers the sheet outline's bbox at ~10mm resolution.
      const obb = PU.bbox(settings.sheetOutline);
      const CELL = 10;  // mm per grid cell
      const gw = Math.ceil(obb.w / CELL) + 1;
      const gh = Math.ceil(obb.h / CELL) + 1;
      const mask = new Array(gw * gh).fill(null);
      const centers = this._zoneCenters;
      for (let iy = 0; iy < gh; iy++) {
        for (let ix = 0; ix < gw; ix++) {
          const x = obb.minX + ix * CELL;
          const y = obb.minY + iy * CELL;
          // Boundary-aware nearest-center classification
          let nearest = null, nd2 = Infinity;
          for (let z = 0; z < centers.length; z++) {
            const c = centers[z];
            const dx = x - c[1], dy = y - c[2];
            const d2 = dx*dx + dy*dy;
            if (d2 >= nd2) continue;
            let crosses = false;
            for (let k = 0; k < curves.length; k++) {
              const s = curves[k];
              if (segSegIntersect(x, y, c[1], c[2], s[0], s[1], s[2], s[3])) { crosses = true; break; }
            }
            if (crosses) continue;
            nd2 = d2; nearest = c[0];
          }
          mask[iy * gw + ix] = nearest;
        }
      }
      this._zoneMask = mask;
      this._zoneMaskMeta = { minX: obb.minX, minY: obb.minY, cell: CELL, gw, gh };

      // ── Zone bbox bounds (for directional bottom-up sweep) ──────────
      // For each zone name, find its max-Y (bottom edge) by scanning the
      // mask. When a part is placed in a zone, we want to prefer positions
      // close to that zone's bottom edge. This produces a clean upward-
      // sweep fill instead of random placement.
      const zoneBounds = {};  // { zoneName: { minX, maxX, minY, maxY } }
      for (let iy = 0; iy < gh; iy++) {
        for (let ix = 0; ix < gw; ix++) {
          const z = mask[iy * gw + ix];
          if (!z) continue;
          const x = obb.minX + ix * CELL;
          const y = obb.minY + iy * CELL;
          if (!zoneBounds[z]) zoneBounds[z] = { minX: x, maxX: x, minY: y, maxY: y };
          else {
            const b = zoneBounds[z];
            if (x < b.minX) b.minX = x;
            if (x > b.maxX) b.maxX = x;
            if (y < b.minY) b.minY = y;
            if (y > b.maxY) b.maxY = y;
          }
        }
      }
      this._zoneBounds = zoneBounds;
    }
    this._zoneCheck = null;

    // ── Track last rotation per component (for rotation diversity) ──
    // Encourages interlocking: if vamp #1 was placed at 0°, vamp #2 at
    // 180° gets a small cost bonus, promoting alternation that nests the
    // concave U-shapes into each other.
    this._lastRotByComp = new Map();
    this._lastCentroidByComp = new Map();

    // ── RESERVED ZONES ──
    // If component A is restricted to zones [BUTT, SHOULDER], then those zones
    // are "reserved" for A. Any OTHER component without restrictions should
    // avoid those reserved zones (leave them free for the restricted component).
    // The union of all rule.allowedZones across components = "reserved zones set".
    // Unrestricted parts get a _zoneCheck that rejects cells in that set.
    this._reservedZones = new Set();
    // Diversity seed for stochastic tiebreaker in placeBest cost. 0 means
    // deterministic (production main run). Improve passes set this to a
    // random non-zero value so each click explores a different micro-layout.
    this._diversitySeed = settings._diversitySeed || 0;
    if (this._diversitySeed) {
      console.log(`[NestForge engine] Diversity seed=${this._diversitySeed.toString(16)} active`);
    }
    // Growing in width (app auto-expand with an effectively infinite width):
    // pack height-first so the fixed height fills before the layout
    // extends to the right, mirroring the usual width-first fill.
    this._growAxisX = settings._growAxis === 'x';
    if (settings.componentRules && this._zoneCenters) {
      for (const rule of settings.componentRules.values()) {
        if (rule && rule.allowedZones && rule.allowedZones.size) {
          for (const z of rule.allowedZones) this._reservedZones.add(z);
        }
      }
    }

    const baseQueue = [];
    let _uid = 0;
    if (derivedSets) {
      // Every part once per set, biggest component first inside a set.
      // Must-mirror pairs (orig + mir share a component key) stay adjacent
      // so a set holds a left and a right.
      const compKeyOf = (p) => p._componentKey || String(p.id);
      const compArea = new Map();
      for (const p of partDefs) {
        const k = compKeyOf(p), a = PU.area(p.pts);
        if (!compArea.has(k) || compArea.get(k) < a) compArea.set(k, a);
      }
      const setOrder = partDefs.slice().sort((a, b) => {
        const ka = compKeyOf(a), kb = compKeyOf(b);
        if (ka !== kb) return (compArea.get(kb) - compArea.get(ka)) || (ka < kb ? -1 : 1);
        if (a._mustPairTag !== b._mustPairTag) return a._mustPairTag === 'orig' ? -1 : 1;
        return (PU.area(b.pts) - PU.area(a.pts)) || (String(a.id) < String(b.id) ? -1 : 1);
      });
      for (let s = 0; s < nSetsWanted; s++) {
        for (const p of setOrder) baseQueue.push({ ...p, _q: s, _uid: _uid++, _inSet: true, _setIdx: s });
      }
      // Fill mode: extras after the last set, round by round (one more of
      // every part per round) so the leftover space is topped up evenly.
      // maxPerPart is the area-based inflation the plain fill queue uses.
      if (fillSheet) {
        for (let s = nSetsWanted; s < maxPerPart; s++) {
          for (const p of setOrder) baseQueue.push({ ...p, _q: s, _uid: _uid++, _inSet: false, _exhaustFill: true });
        }
      }
      console.log(`[NestForge queue] ${nSetsWanted} complete sets of ${partDefs.length} parts` +
        (fillSheet ? ` + ${baseQueue.length - nSetsWanted * partDefs.length} extras to fill` : '') +
        ` = ${baseQueue.length} queue`);
    } else if (setMode) {
      const byKey = new Map();
      for (const p of partDefs) {
        const k = p._componentKey || p.id;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(p);
      }
      // ── Realistic nSets cap (don't bloat queue for fillSheet mode) ──
      let nSets;
      if (fillSheet) {
        let setArea = 0;
        for (const [key, parts] of byKey) {
          const perSet = setCounts.get(key) || 0;
          if (perSet > 0) setArea += PU.area(parts[0].pts) * perSet;
        }
        if (setArea > 0) {
          nSets = Math.min(50, Math.ceil((usW * usH * 0.85) / setArea));
        } else {
          nSets = 10;
        }
      } else {
        nSets = maxPerPart;
      }
      // Build a sort comparator based on the requested strategy
      const strat = settings._queueStrategy || 'restricted-area';
      const sortedKeys = Array.from(byKey.keys()).filter(k => setCounts.has(k))
        .sort((a, b) => {
          const ra = (settings.componentRules && settings.componentRules.get(a)) || {};
          const rb = (settings.componentRules && settings.componentRules.get(b)) || {};
          const aHasZone = ra.allowedZones && ra.allowedZones.size > 0;
          const bHasZone = rb.allowedZones && rb.allowedZones.size > 0;
          const aA = PU.area(byKey.get(a)[0].pts);
          const bA = PU.area(byKey.get(b)[0].pts);
          const aBB = PU.bbox(byKey.get(a)[0].pts);
          const bBB = PU.bbox(byKey.get(b)[0].pts);
          if (strat === 'area-desc') return bA - aA;
          if (strat === 'height-desc') return bBB.h - aBB.h;
          if (aHasZone && !bHasZone) return -1;
          if (!aHasZone && bHasZone) return 1;
          return bA - aA;
        });

      // ── ZONE-SATURATION QUEUE (new strategy) ──
      // Instead of interleaving (set 1: vamp+quarters, set 2: vamp+quarters...),
      // fill RESTRICTED-ZONE parts FIRST to saturation, THEN unrestricted parts.
      // Rationale: if vamps are restricted to BUTT+SHOULDER, pack ALL vamps
      // that fit in BUTT/SHOULDER before placing any quarters. Otherwise
      // quarters might block future vamp placements. The setCount rule only
      // matters for the FINAL complete-set count; placement order should
      // maximize total utilization by saturating constrained zones first.
      // (Unless strategy explicitly requests interleaved — used by strategy B.)
      const useZoneSaturation = (strat !== 'interleaved');
      if (useZoneSaturation) {
        // Phase 1: For each restricted component, queue MANY copies to saturate
        // their allowed zone. Use nSets × perSet × saturation_factor copies.
        const SATURATION_FACTOR = 2.0;  // queue up to 2× the set-count target
        for (const key of sortedKeys) {
          const rule = (settings.componentRules && settings.componentRules.get(key)) || {};
          const hasZone = rule.allowedZones && rule.allowedZones.size > 0;
          if (!hasZone) continue;  // skip unrestricted in Phase 1
          const parts = byKey.get(key);
          const perSet = setCounts.get(key);
          const targetCopies = Math.ceil(nSets * perSet * SATURATION_FACTOR);
          for (let q = 0; q < targetCopies; q++) {
            const p = parts[q % parts.length];
            baseQueue.push({ ...p, _q: q, _uid: _uid++, _inSet: false, _phase: 1 });
          }
        }
        // Phase 2: Unrestricted components fill remaining zones.
        for (const key of sortedKeys) {
          const rule = (settings.componentRules && settings.componentRules.get(key)) || {};
          const hasZone = rule.allowedZones && rule.allowedZones.size > 0;
          if (hasZone) continue;  // restricted already queued in Phase 1
          const parts = byKey.get(key);
          const perSet = setCounts.get(key);
          const targetCopies = Math.ceil(nSets * perSet * SATURATION_FACTOR);
          for (let q = 0; q < targetCopies; q++) {
            const p = parts[q % parts.length];
            baseQueue.push({ ...p, _q: q, _uid: _uid++, _inSet: false, _phase: 2 });
          }
        }
      } else {
        // Original set-interleaved queue (strategy B uses this as alternative)
        for (let s = 0; s < nSets; s++) {
          for (const key of sortedKeys) {
            const parts = byKey.get(key);
            const perSet = setCounts.get(key);
            for (let i = 0; i < perSet; i++) {
              const p = parts[i % parts.length];
              baseQueue.push({ ...p, _q: s * perSet + i, _uid: _uid++, _inSet: true, _setIdx: s });
            }
          }
        }
      }
      // ── EXHAUST FILL phase — capped at realistic count
      const exhaustCopies = Math.min(30, nSets * 2);
      for (const key of sortedKeys) {
        const parts = byKey.get(key);
        for (let q = 0; q < exhaustCopies; q++) {
          const p = parts[q % parts.length];
          baseQueue.push({ ...p, _q: 10000 + q, _uid: _uid++, _inSet: false, _exhaustFill: true });
        }
      }
      // Non-set components (no setCount)
      for (const [key, parts] of byKey) {
        if (setCounts.has(key)) continue;
        for (const p of parts) {
          for (let q = 0; q < maxPerPart; q++) baseQueue.push({ ...p, _q: q, _uid: _uid++, _inSet: false });
        }
      }
    } else {
      // ── Pair-aware interleaved queue for mirror-must variants ──
      //
      // When user has must-mirror, app pre-expands one component into TWO
      // partDefs sharing the same _componentKey: original (_mustPairTag='orig')
      // and flipped (_mustPairTag='mir'). To get true alternating chirality
      // (left, right, left, right…) we interleave them in queue order:
      // [orig0, mir0, orig1, mir1, …]. Engine then places in the order
      // imposed by the active sort, which preserves alternation because
      // (1) they share _componentKey so they stay grouped together and
      // (2) the secondary tiebreaker uses _q index (then pair tag) which
      // keeps orig and mir at same _q adjacent.
      //
      // Non-paired parts keep contiguous ordering as before.
      const pairs = new Map();
      const unpaired = [];
      for (const p of partDefs) {
        if (p._mustPairTag) {
          const key = p._componentKey;
          if (!pairs.has(key)) pairs.set(key, {});
          if (p._mustPairTag === 'orig') pairs.get(key).orig = p;
          else pairs.get(key).mir = p;
        } else {
          unpaired.push(p);
        }
      }
      for (const p of unpaired) {
        for (let q = 0; q < maxPerPart; q++) baseQueue.push({ ...p, _q: q, _uid: _uid++ });
      }
      for (const pair of pairs.values()) {
        if (pair.orig && pair.mir) {
          // Interleave: orig0, mir0, orig1, mir1, ... (same _q means a pair)
          for (let q = 0; q < maxPerPart; q++) {
            baseQueue.push({ ...pair.orig, _q: q, _uid: _uid++ });
            baseQueue.push({ ...pair.mir, _q: q, _uid: _uid++ });
          }
        } else {
          const p = pair.orig || pair.mir;
          for (let q = 0; q < maxPerPart; q++) baseQueue.push({ ...p, _q: q, _uid: _uid++ });
        }
      }
    }

    // ── Try multiple orderings ──
    // Each ordering keeps same-component parts CONTIGUOUS (primary key) and
    // breaks ties within a component by area/height/width (secondary key).
    // This gives the proximity bonus inside placeBest a chance to actually
    // cluster placements: when vamp 1 places, vamp 2 immediately follows in
    // the queue, so the proximity bonus can pull it next to vamp 1. Without
    // contiguity, the queue might do vamp1 → quarter → vamp2 → quarter,
    // and "last vamp centroid" tracking becomes useless because vamp2 is
    // chosen long after vamp1 settled.
    //
    // Components themselves are ordered by their LARGEST part's area DESC,
    // so vamps (bigger) go before quarters — preserving the existing
    // "biggest first" packing efficiency at the component level.
    const compKey = (p) => p._componentKey || String(p.partId || p.id || p.name || '');
    // Pre-compute max area per component for stable component ordering
    const compMaxArea = new Map();
    for (const p of baseQueue) {
      const k = compKey(p);
      const a = PU.area(p.pts);
      if (!compMaxArea.has(k) || compMaxArea.get(k) < a) compMaxArea.set(k, a);
    }
    const compOrder = (a, b) => {
      const ka = compKey(a), kb = compKey(b);
      if (ka === kb) return 0;
      const aMax = compMaxArea.get(ka) || 0;
      const bMax = compMaxArea.get(kb) || 0;
      if (aMax !== bMax) return bMax - aMax;
      return ka < kb ? -1 : 1;
    };
    // For must-pair groups (orig + mir share _componentKey), preserve the
    // interleaved order by sorting by _q first, then pair tag (orig before
    // mir at same _q). This keeps left/right chirality alternating instead
    // of degenerating to all-orig-then-all-mir which destroys the pair
    // intent and hurts packing.
    const pairAwareSecondary = (a, b) => {
      // Both within same _componentKey group at this point (compOrder == 0)
      if (a._mustPairTag && b._mustPairTag) {
        if (a._q !== b._q) return a._q - b._q;
        // Same _q: orig first, then mir
        return a._mustPairTag === 'orig' ? -1 : 1;
      }
      return 0;
    };
    const withCompPrimary = (sortFn) => (a, b) => {
      const c = compOrder(a, b);
      if (c !== 0) return c;
      // Pair-aware secondary (no-op if not a pair group)
      const pa = pairAwareSecondary(a, b);
      if (pa !== 0) return pa;
      return sortFn(a, b);
    };
    const orderingFns = [
      withCompPrimary((a, b) => PU.area(b.pts) - PU.area(a.pts)),
      withCompPrimary((a, b) => PU.bbox(b.pts).h - PU.bbox(a.pts).h),
      withCompPrimary((a, b) => PU.bbox(b.pts).w - PU.bbox(a.pts).w),
      withCompPrimary((a, b) => Math.max(PU.bbox(b.pts).w, PU.bbox(b.pts).h)
                              - Math.max(PU.bbox(a.pts).w, PU.bbox(a.pts).h)),
    ];
    if (sortBy === 'width') orderingFns.unshift(withCompPrimary((a, b) => PU.bbox(b.pts).w - PU.bbox(a.pts).w));
    else if (sortBy === 'height') orderingFns.unshift(withCompPrimary((a, b) => PU.bbox(b.pts).h - PU.bbox(a.pts).h));
    else orderingFns.unshift(withCompPrimary((a, b) => PU.area(b.pts) - PU.area(a.pts)));
    // In set mode, preserve interleaved queue order — identity sort only.
    // The queue is already carefully built with Phase 1 (restricted parts)
    // then Phase 2 (unrestricted) per-set, plus inter-set ordering. Any
    // re-sort breaks that careful structure and DROPS placed count.
    // Tested: identity-only setMode gave 52 placements; introducing
    // multi-orderings dropped to 43. Keep identity.
    //
    // Copies-as-sets keeps the set structure (set 1, set 2, ..., extras)
    // and only varies the order INSIDE a set: area, height or width
    // descending, the user's sort first. Pairs and ties stay stable.
    const setRank = (p) => p._inSet ? p._setIdx : 1e6 + (p._q || 0);
    const withSetPrimary = (sortFn) => (a, b) => {
      const ra = setRank(a), rb = setRank(b);
      if (ra !== rb) return ra - rb;
      const d = sortFn(a, b);
      if (d !== 0) return d;
      const ka = compKey(a), kb = compKey(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const pa = pairAwareSecondary(a, b);
      if (pa !== 0) return pa;
      return a._uid - b._uid;
    };
    const setOrderingFns = {
      area:   withSetPrimary((a, b) => PU.area(b.pts) - PU.area(a.pts)),
      height: withSetPrimary((a, b) => PU.bbox(b.pts).h - PU.bbox(a.pts).h),
      width:  withSetPrimary((a, b) => PU.bbox(b.pts).w - PU.bbox(a.pts).w),
    };
    const setOrderNames = sortBy === 'width' ? ['width', 'area', 'height']
                        : sortBy === 'height' ? ['height', 'area', 'width']
                        : ['area', 'height', 'width'];
    const orderings = derivedSets
      ? setOrderNames.map(n => setOrderingFns[n])
      : setMode
        ? [(a, b) => 0]
        : orderingFns.slice(0, 3);

    // Shared NFP cache across ALL passes (orderings × cavity modes).
    // Key: `placedPartId|vKey||thisPartId|vKey|gap` — fully determined by the
    // two variants and gap, so it's valid to reuse between orderings and
    // between cavity/BL passes on the same sheet. Previously this cache was
    // local to runPass(), causing the same NFPs to be recomputed 6× on each
    // sheet. Hoisting here cuts polygon nesting time by roughly 5×.
    const nfpCache = new Map();

    const runPass = async (queue, onPassProgress, cavityAware) => {
      const placed = [];
      const unplacedItems = [];  // queue items that didn't fit — return for next sheet
      let curMaxX = 0, curMaxY = 0;
      let lastYield = performance.now();

      // Reset rotation tracker per-pass. The tracker drives rotation
      // diversity across placements of the same component. Passes are
      // independent attempts — each should start fresh without inheriting
      // rotations from a prior pass's winning sequence.
      this._lastRotByComp = new Map();

      // Reset cluster-tracking per-pass. For directional/cluster nesting:
      // remember the centroid of the LAST placed part of each component,
      // so subsequent placements can prefer nearby positions (cluster
      // growth instead of scattered placement).
      this._lastCentroidByComp = new Map();

      // Set-mode abandonment tracking (same logic as raster engine)
      let _abandonSets = false;
      let _currentFailedSetIdx = -1;
      // Copies-as-sets: a part of a set that does not fit is simply
      // unplaced (the retry passes get another go at it); the rest of its
      // set still runs, since the smaller parts may well fit. Later sets
      // are still abandoned. An extra of a part that already failed is not
      // tried again in this loop: the sheet only gets fuller.
      const failedExtraIds = new Set();

      for (let pi = 0; pi < queue.length; pi++) {
        if (isCancelled && isCancelled()) break;
        const now = performance.now();
        if (now - lastYield > 40) {
          onPassProgress(pi / queue.length, `Placed: ${placed.length}`);
          await sleep(0);
          lastYield = performance.now();
        }

        const part = queue[pi];

        // Skip abandoned set parts
        if (_abandonSets && part._inSet) {
          unplacedItems.push(part);
          continue;
        }
        if (_currentFailedSetIdx >= 0 && part._setIdx === _currentFailedSetIdx) {
          unplacedItems.push(part);
          continue;
        }
        if (part._inSet && part._setIdx !== _currentFailedSetIdx) {
          _currentFailedSetIdx = -1;
        }
        if (part._exhaustFill && derivedSets && failedExtraIds.has(part.id)) {
          unplacedItems.push(part);
          continue;
        }

        const variants = variantsByPart.get(part.id);

        // Set per-part zone check (used inside placeBest)
        this._zoneCheck = null;
        if (this._zoneCenters && settings.componentRules) {
          const compKey = part._componentKey;
          const rule = compKey ? settings.componentRules.get(compKey) : null;
          const centers = this._zoneCenters;
          const mask = this._zoneMask;
          const meta = this._zoneMaskMeta;
          // Classify point via mask (if available — boundary-aware O(1))
          // or fall back to plain Voronoi (label-based, approximate).
          const classify = mask && meta
            ? (cx, cy) => {
                const ix = Math.round((cx - meta.minX) / meta.cell);
                const iy = Math.round((cy - meta.minY) / meta.cell);
                if (ix < 0 || ix >= meta.gw || iy < 0 || iy >= meta.gh) return null;
                return mask[iy * meta.gw + ix];
              }
            : (cx, cy) => {
                let nearest = null, nd2 = Infinity;
                for (let z = 0; z < centers.length; z++) {
                  const c = centers[z];
                  const dx = cx - c[1], dy = cy - c[2];
                  const d2 = dx*dx + dy*dy;
                  if (d2 < nd2) { nd2 = d2; nearest = c[0]; }
                }
                return nearest;
              };
          if (rule && rule.allowedZones && rule.allowedZones.size) {
            const allowed = rule.allowedZones;
            this._zoneCheck = (cx, cy) => {
              const n = classify(cx, cy);
              return n && allowed.has(n);
            };
          } else if (this._reservedZones && this._reservedZones.size) {
            const reserved = this._reservedZones;
            this._zoneCheck = (cx, cy) => {
              const n = classify(cx, cy);
              return n && !reserved.has(n);
            };
          }
        }

        const denseMode = fillSheet || multiSheet;
        this._currentCompKey = part._componentKey || null;
        this._currentRule = (this._currentCompKey && settings.componentRules)
          ? settings.componentRules.get(this._currentCompKey) : null;
        const pl = await this.placeBest(variants, placed, usW, usH, gap,
                                  curMaxX, curMaxY, part.id, nfpCache,
                                  denseMode, cavityAware,
                                  settings.sheetOutline, settings.defects,
                                  shapeHashByPart, isCancelled);

        if (pl !== null) {
          const v = variants[pl.vi];
          const worldPoly = PU.translate(v.pts, pl.x, pl.y);

          let rPts = v.mirror ? PU.mirror(part.pts, v.mirror) : part.pts;
          rPts = PU.rotate(rPts, v.rotation);
          const innerLines = (part.innerLines || []).map(il => {
            let lp = v.mirror ? PU.mirror(il.pts, v.mirror) : il.pts;
            return { pts: PU.rotate(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
          });

          const placement = {
            partId: part.id, partName: part.name, color: part.color,
            shapeHash: shapeHashByPart.get(part.id),  // NFP cache key across copies
            _uid: part._uid,
            pts: rPts, worldPoly,
            localPoly: v.pts,
            variantKey: v.key,
            x: margin + pl.x, y: margin + pl.y,
            nfpX: pl.x, nfpY: pl.y,
            rotation: v.rotation, mirror: v.mirror, sheet: 0, innerLines
          };
          placed.push(placement);
          try { _emit({ placement, totalPlaced: placed.length, sheetIdx: 0 }); } catch(_){}
          // Track rotation for diversity bonus on next placement of same component
          if (part._componentKey && v.rotation !== undefined) {
            this._lastRotByComp.set(part._componentKey, v.rotation);
          }
          // Track centroid for cluster proximity bonus
          if (part._componentKey) {
            const wb = PU.bbox(worldPoly);
            this._lastCentroidByComp.set(part._componentKey, [
              (wb.minX + wb.maxX) / 2, (wb.minY + wb.maxY) / 2
            ]);
          }

          const bb = PU.bbox(worldPoly);
          if (bb.maxX > curMaxX) curMaxX = bb.maxX;
          if (bb.maxY > curMaxY) curMaxY = bb.maxY;
        } else {
          // Part failed to fit on this sheet.
          // In set mode: abandon this set and all future sets (they won't fit).
          if (part._inSet) {
            if (!derivedSets) _currentFailedSetIdx = part._setIdx;
            _abandonSets = true;
          }
          if (part._exhaustFill && derivedSets) failedExtraIds.add(part.id);
          unplacedItems.push(part);
        }
      }

      // ── SECOND-CHANCE PASS for unplaced items ──────────────────────────
      // This is EXPENSIVE (cavity-aware mode = ALL candidate positions).
      // Retry all unplaced items — both large parts that might fit in cavities
      // created by later placements, AND small parts that slip into gaps.
      // Capped at 20 attempts with a 3s time budget.
      if (unplacedItems.length > 0 && !cavityAware) {
        const smallPartArea = (p) => {
          const bb = p.bbox || PU.bbox(p.pts);
          return bb.w * bb.h;
        };
        // Sort by area DESCENDING — try the LARGEST unplaced first.
        // Cap at 50 attempts. Each attempt is bounded by RETRY_BUDGET_MS.
        // Copies-as-sets: the missing set parts come first (earliest set
        // first), extras after them.
        const retryQueue = unplacedItems
          .slice()
          .sort((a, b) => (derivedSets && setRank(a) !== setRank(b))
            ? setRank(a) - setRank(b)
            : smallPartArea(b) - smallPartArea(a))
          .slice(0, 50);
        const stillUnplaced = [];
        let placedThisRetry = 0;
        const retryFailedIds = new Set();   // copies-as-sets: one try per part for extras
        // Bounded by the 50-attempt cap above, not by a clock: a wall-clock
        // limit here made the layout vary from run to run (measured: the old
        // 5 s limit stopped the loop at 44-49 attempts, differently each time).
        for (const part of retryQueue) {
          if (isCancelled && isCancelled()) break;
          if (derivedSets && part._exhaustFill && retryFailedIds.has(part.id)) { stillUnplaced.push(part); continue; }
          const variants = variantsByPart.get(part.id);
          // Set per-part zone check (used inside placeBest)
          // RETRY PASS: Zone rules remain STRICT. Unrestricted parts still
          // avoid reserved zones. This prevents quarters from leaking into
          // BUTT/SHOULDER as a "last resort" — user expects hard separation.
          this._zoneCheck = null;
          if (this._zoneCenters && settings.componentRules) {
            const compKey = part._componentKey;
            const rule = compKey ? settings.componentRules.get(compKey) : null;
            const centers = this._zoneCenters;
            const mask = this._zoneMask;
            const meta = this._zoneMaskMeta;
            const classify = mask && meta
              ? (cx, cy) => {
                  const ix = Math.round((cx - meta.minX) / meta.cell);
                  const iy = Math.round((cy - meta.minY) / meta.cell);
                  if (ix < 0 || ix >= meta.gw || iy < 0 || iy >= meta.gh) return null;
                  return mask[iy * meta.gw + ix];
                }
              : (cx, cy) => {
                  let nearest = null, nd2 = Infinity;
                  for (let z = 0; z < centers.length; z++) {
                    const c = centers[z];
                    const dx = cx - c[1], dy = cy - c[2];
                    const d2 = dx*dx + dy*dy;
                    if (d2 < nd2) { nd2 = d2; nearest = c[0]; }
                  }
                  return nearest;
                };
            if (rule && rule.allowedZones && rule.allowedZones.size) {
              const allowed = rule.allowedZones;
              this._zoneCheck = (cx, cy) => {
                const n = classify(cx, cy);
                return n && allowed.has(n);
              };
            } else if (this._reservedZones && this._reservedZones.size) {
              const reserved = this._reservedZones;
              this._zoneCheck = (cx, cy) => {
                const n = classify(cx, cy);
                return n && !reserved.has(n);
              };
            }
          }
          // Use cavityAware=true so placeBest tries ALL candidate positions
          // for this part, not just the BL of each polygon. This is the
          // expensive case but only runs for parts that failed the fast pass.
          this._currentCompKey = part._componentKey || null;
          this._currentRule = (this._currentCompKey && settings.componentRules)
            ? settings.componentRules.get(this._currentCompKey) : null;
          const pl = await this.placeBest(variants, placed, usW, usH, gap,
                                    curMaxX, curMaxY, part.id, nfpCache,
                                    fillSheet || multiSheet, true,
                                    settings.sheetOutline, settings.defects,
                                    shapeHashByPart, isCancelled);
          if (pl !== null) {
            const v = variants[pl.vi];
            const worldPoly = PU.translate(v.pts, pl.x, pl.y);
            let rPts = v.mirror ? PU.mirror(part.pts, v.mirror) : part.pts;
            rPts = PU.rotate(rPts, v.rotation);
            const innerLines = (part.innerLines || []).map(il => {
              let lp = v.mirror ? PU.mirror(il.pts, v.mirror) : il.pts;
              return { pts: PU.rotate(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
            });
            const placement = {
              partId: part.id, partName: part.name, color: part.color,
              shapeHash: shapeHashByPart.get(part.id),
              _uid: part._uid, pts: rPts, worldPoly, localPoly: v.pts,
              variantKey: v.key,
              x: margin + pl.x, y: margin + pl.y,
              nfpX: pl.x, nfpY: pl.y,
              rotation: v.rotation, mirror: v.mirror, sheet: 0, innerLines
            };
            placed.push(placement);
            try { _emit({ placement, totalPlaced: placed.length, sheetIdx: 0 }); } catch(_){}
            if (part._componentKey && v.rotation !== undefined) {
              this._lastRotByComp.set(part._componentKey, v.rotation);
            }
            if (part._componentKey) {
              const wb = PU.bbox(worldPoly);
              this._lastCentroidByComp.set(part._componentKey, [
                (wb.minX + wb.maxX) / 2, (wb.minY + wb.maxY) / 2
              ]);
            }
            const bb = PU.bbox(worldPoly);
            if (bb.maxX > curMaxX) curMaxX = bb.maxX;
            if (bb.maxY > curMaxY) curMaxY = bb.maxY;
            placedThisRetry++;
          } else {
            if (derivedSets && part._exhaustFill) retryFailedIds.add(part.id);
            stillUnplaced.push(part);
          }
        }
        // Include items we didn't try (too-large parts we skipped) in stillUnplaced
        const retriedSet = new Set(retryQueue.map(p => p._uid));
        for (const p of unplacedItems) {
          if (!retriedSet.has(p._uid)) stillUnplaced.push(p);
        }
        // Replace unplacedItems with what's STILL unplaced after retry
        unplacedItems.length = 0;
        for (const p of stillUnplaced) unplacedItems.push(p);
      }

      // ── PHASE 3: CROSS-COMPONENT ZONE OVERFLOW (one-direction) ─────────
      // Unrestricted parts spill into reserved zones IF the owning restricted
      // component(s) have no more parts wanting placement (all queued copies
      // placed, or none ever queued in this sheet).
      // Restricted parts STAY strict — they NEVER spill into other reserved
      // zones. This preserves the user's intent: "vamp must be in BUTT" means
      // vamp is locked to BUTT regardless. But if BUTT has empty space and
      // a quarter (unrestricted) fits, the quarter goes in.
      //
      // RELEASE LOGIC: by the time we reach Phase 3, ALL restricted parts have
      // already been attempted in main pass + second-chance pass with cavity
      // awareness. Any restricted part still in unplacedItems means: in the
      // current placed-state, no spot exists in its allowed zones large enough
      // for it. So a Phase 3 quarter going into a small leftover cavity does
      // NOT displace any vamp that "would have fit" — that vamp already failed.
      // Therefore Phase 3 ALWAYS releases ALL reserved zones for unrestricted
      // retry. This matches user intent: "fill BUTT gaps with quarters once
      // all vamps that fit have been placed."
      if (unplacedItems.length > 0
          && this._reservedZones && this._reservedZones.size > 0
          && settings.componentRules) {
        const releasedZones = new Set(this._reservedZones);
        if (releasedZones.size > 0) {
          // Filter to UNRESTRICTED unplaced items only (restricted stay strict)
          const phase3Queue = unplacedItems.filter(p => {
            const k = p._componentKey;
            const rule = k && settings.componentRules.get(k);
            return !rule || !rule.allowedZones || !rule.allowedZones.size;
          });

          if (phase3Queue.length > 0) {
            console.log(`[NestForge Phase 3] ${phase3Queue.length} unrestricted parts retry into ALL reserved zones [${[...releasedZones].join(',')}] (restricted parts already attempted)`);
            // A count, not a clock, so the result does not depend on machine
            // speed. Generous: the old 3 s allowed far fewer attempts than this.
            const PHASE3_MAX_ATTEMPTS = 200;
            let phase3Attempts = 0;
            const phase3Tried = new Set();
            const phase3Placed = [];

            // Build relaxed zone-check: allow non-reserved OR released zones
            const reserved = this._reservedZones;
            const releasedSet = releasedZones;
            const mask = this._zoneMask;
            const meta = this._zoneMaskMeta;
            const centers = this._zoneCenters;
            const classify = (mask && meta)
              ? (cx, cy) => {
                  const ix = Math.round((cx - meta.minX) / meta.cell);
                  const iy = Math.round((cy - meta.minY) / meta.cell);
                  if (ix < 0 || ix >= meta.gw || iy < 0 || iy >= meta.gh) return null;
                  return mask[iy * meta.gw + ix];
                }
              : (cx, cy) => {
                  if (!centers) return null;
                  let nearest = null, nd2 = Infinity;
                  for (let z = 0; z < centers.length; z++) {
                    const c = centers[z];
                    const dx = cx - c[1], dy = cy - c[2];
                    const d2 = dx*dx + dy*dy;
                    if (d2 < nd2) { nd2 = d2; nearest = c[0]; }
                  }
                  return nearest;
                };

            // Largest-first for better packing
            const phase3Sorted = phase3Queue.slice().sort((a, b) => PU.area(b.pts) - PU.area(a.pts));

            for (const part of phase3Sorted) {
              if (isCancelled && isCancelled()) break;
              if (++phase3Attempts > PHASE3_MAX_ATTEMPTS) break;
              phase3Tried.add(part._uid);
              const variants = variantsByPart.get(part.id);
              // Relaxed zone check: allow non-reserved OR released zones
              this._zoneCheck = (cx, cy) => {
                const n = classify(cx, cy);
                if (!n) return true; // outside zone map = no constraint
                return !reserved.has(n) || releasedSet.has(n);
              };
              this._currentCompKey = part._componentKey || null;
              this._currentRule = (this._currentCompKey && settings.componentRules)
                ? settings.componentRules.get(this._currentCompKey) : null;
              const pl = await this.placeBest(variants, placed, usW, usH, gap,
                                        curMaxX, curMaxY, part.id, nfpCache,
                                        true, true,
                                        settings.sheetOutline, settings.defects,
                                        shapeHashByPart, isCancelled);
              if (pl !== null) {
                const v = variants[pl.vi];
                const worldPoly = PU.translate(v.pts, pl.x, pl.y);
                let rPts = v.mirror ? PU.mirror(part.pts, v.mirror) : part.pts;
                rPts = PU.rotate(rPts, v.rotation);
                const innerLines = (part.innerLines || []).map(il => {
                  let lp = v.mirror ? PU.mirror(il.pts, v.mirror) : il.pts;
                  return { pts: PU.rotate(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
                });
                const placement = {
                  partId: part.id, partName: part.name, color: part.color,
                  shapeHash: shapeHashByPart.get(part.id),
                  _uid: part._uid, pts: rPts, worldPoly, localPoly: v.pts,
                  variantKey: v.key,
                  x: margin + pl.x, y: margin + pl.y,
                  nfpX: pl.x, nfpY: pl.y,
                  rotation: v.rotation, mirror: v.mirror, sheet: 0, innerLines,
                  _phase3: true,
                };
                placed.push(placement);
                phase3Placed.push(part._uid);
                try { _emit({ placement, totalPlaced: placed.length, sheetIdx: 0 }); } catch(_){}
                const bb = PU.bbox(worldPoly);
                if (bb.maxX > curMaxX) curMaxX = bb.maxX;
                if (bb.maxY > curMaxY) curMaxY = bb.maxY;
              }
            }
            // Reset zone check (cleanliness — runPass returns next anyway)
            this._zoneCheck = null;

            // Remove successfully placed items from unplacedItems
            const placedSet = new Set(phase3Placed);
            const filtered = unplacedItems.filter(p => !placedSet.has(p._uid));
            unplacedItems.length = 0;
            for (const p of filtered) unplacedItems.push(p);
            if (phase3Placed.length > 0) {
              console.log(`[NestForge Phase 3] placed ${phase3Placed.length} unrestricted parts in released zones`);
            }
          }
        }
      }

      return { placements: placed, placed: placed.length,
               unplaced: unplacedItems.length, unplacedItems,
               completeSets: derivedSets ? countSets(placed) : 0,
               maxX: curMaxX, maxY: curMaxY };
    };

    // ── PHASE 4: EDGE-ANCHORED BRUTE-FORCE RETRY ─────────────────────────
    // After all structured passes (main BL, second-chance cavity-aware,
    // Phase 3 cross-zone fill), some parts remain unplaced because
    // placeBest's candidate enumeration is NEIGHBOR-BASED — positions are
    // generated by "hug an existing placement." Regions of the sheet with
    // no nearby placed parts (horn peaks, bottom-right corner of a hide,
    // empty far edges) NEVER get candidate positions.
    //
    // Phase 4 brute-forces candidate positions independent of existing
    // placements:
    //   • Hide outline vertices (direct hits on the concave perimeter)
    //   • Hide outline edge midpoints (catches sides between vertices)
    //   • 4 corners of usable rectangle
    //   • Coarse uniform grid (every ~25mm)
    // For each candidate, directly test validity against placed polys
    // (with gap enforcement via offset), defect polys, hide outline
    // containment, and zone rules. First fit wins.
    //
    // Runs ONCE per sheet on the BEST result from singleSheetBestPass.
    // Time budget: 8 seconds total. Stops early on cancel.
    const runPhase4 = async (result) => {
      const placed = result.placements;
      const unplacedItems = result.unplacedItems;
      let curMaxX = result.maxX;
      let curMaxY = result.maxY;

      if (!unplacedItems || unplacedItems.length === 0) return;

      // Deterministic instead of a wall-clock budget: every (shape, rotation,
      // position) is evaluated at most once (see p4Cursor below), so a normal
      // job finishes in well under a second. The cap only guards pathological
      // input, and it is a count, so the result never depends on machine speed.
      const PHASE4_MAX_EVALS = 2000000;
      let phase4Evals = 0;
      let phase4Capped = false;

      const placedOutsets = placed.map(pl => {
        const wp = pl.worldPoly || PU.translate(pl.pts, pl.x - margin, pl.y - margin);
        const off = PU.offsetSingle(wp, gap, 'square') || wp;
        return { poly: off, bbox: PU.bbox(off) };
      });
      const defectPolys = (settings.defects || []).map(d => {
        let poly;
        if (d.shape && d.shape.length >= 3) {
          poly = d.shape;
        } else {
          poly = [];
          const r = d.r + gap;
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * 2 * Math.PI;
            poly.push([d.x + r * Math.cos(a), d.y + r * Math.sin(a)]);
          }
        }
        return { poly, bbox: PU.bbox(poly) };
      });

      const fitsAt = (variant, x, y, zoneCheck) => {
        const wp = PU.translate(variant.pts, x, y);
        const bb = PU.bbox(wp);
        if (bb.x < -0.5 || bb.y < -0.5) return false;
        if (bb.x + bb.w > usW + 0.5 || bb.y + bb.h > usH + 0.5) return false;
        if (settings.sheetOutline && settings.sheetOutline.length >= 3) {
          const cx = bb.x + bb.w * 0.5, cy = bb.y + bb.h * 0.5;
          if (!PU.contains(settings.sheetOutline, [cx, cy])) return false;
          for (const v of wp) {
            if (!PU.contains(settings.sheetOutline, v)) return false;
          }
        }
        if (zoneCheck) {
          const cx = bb.x + bb.w * 0.5, cy = bb.y + bb.h * 0.5;
          if (!zoneCheck(cx, cy)) return false;
        }
        for (const po of placedOutsets) {
          if (bb.x > po.bbox.x + po.bbox.w + 0.1) continue;
          if (bb.x + bb.w < po.bbox.x - 0.1) continue;
          if (bb.y > po.bbox.y + po.bbox.h + 0.1) continue;
          if (bb.y + bb.h < po.bbox.y - 0.1) continue;
          // Strict overlap: even 1 vertex of new poly inside existing → reject.
          // Was using 0.5mm² area threshold but that allowed parts to overlap
          // significantly with each other when they shared one edge or vertex.
          // Vertex-PIP test catches all real overlap cases.
          for (let k = 0; k < wp.length; k++) {
            const px = wp[k][0], py = wp[k][1];
            let inside = false;
            for (let ii = 0, jj = po.poly.length - 1; ii < po.poly.length; jj = ii++) {
              const xi = po.poly[ii][0], yi = po.poly[ii][1];
              const xj = po.poly[jj][0], yj = po.poly[jj][1];
              if ((yi > py) !== (yj > py)) {
                const xI = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
                if (px < xI) inside = !inside;
              }
            }
            if (inside) return false;
          }
          // Also check reverse: any vertex of placed poly inside new poly?
          for (let k = 0; k < po.poly.length; k++) {
            const px = po.poly[k][0], py = po.poly[k][1];
            let inside = false;
            for (let ii = 0, jj = wp.length - 1; ii < wp.length; jj = ii++) {
              const xi = wp[ii][0], yi = wp[ii][1];
              const xj = wp[jj][0], yj = wp[jj][1];
              if ((yi > py) !== (yj > py)) {
                const xI = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
                if (px < xI) inside = !inside;
              }
            }
            if (inside) return false;
          }
          // Final fallback: real intersection area test (catches edge-only crossings)
          const inter = PU.intersection([wp], [po.poly]);
          if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 0.1) return false;
        }
        for (const dp of defectPolys) {
          if (bb.x > dp.bbox.x + dp.bbox.w + 0.1) continue;
          if (bb.x + bb.w < dp.bbox.x - 0.1) continue;
          if (bb.y > dp.bbox.y + dp.bbox.h + 0.1) continue;
          if (bb.y + bb.h < dp.bbox.y - 0.1) continue;
          const inter = PU.intersection([wp], [dp.poly]);
          if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 0.5) return false;
        }
        return true;
      };

      const candidates = [];
      candidates.push([0, 0], [usW, 0], [0, usH], [usW, usH]);
      if (settings.sheetOutline && settings.sheetOutline.length >= 3) {
        const outline = settings.sheetOutline;
        for (const v of outline) candidates.push([v[0], v[1]]);
        for (let i = 0; i < outline.length; i++) {
          const a = outline[i], b = outline[(i + 1) % outline.length];
          candidates.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        }
      }
      const GRID_STEP = 25;
      for (let gy = 0; gy <= usH; gy += GRID_STEP) {
        for (let gx = 0; gx <= usW; gx += GRID_STEP) {
          candidates.push([gx, gy]);
        }
      }

      const phase4Placed = [];
      const p4Queue = unplacedItems.slice().sort((a, b) => (derivedSets && setRank(a) !== setRank(b))
        ? setRank(a) - setRank(b)
        : PU.area(b.pts) - PU.area(a.pts));
      // First candidate index not yet known to fail, per (shape, rotation, rule).
      // A rejection is permanent within Phase 4 (placements are only added and
      // can only take space away), so later parts of the same shape resume the
      // scan here and get the same first fit the full scan would have found.
      const p4Cursor = new Map();

      for (const part of p4Queue) {
        if (isCancelled && isCancelled()) break;
        if (phase4Capped) break;
        const variants = variantsByPart.get(part.id);
        if (!variants || !variants.length) continue;

        const partKey = part._componentKey;
        const partRule = (partKey && settings.componentRules) ? settings.componentRules.get(partKey) : null;
        let zoneCheck = null;
        if (partRule && partRule.allowedZones && partRule.allowedZones.size && this._zoneCenters) {
          const allowed = partRule.allowedZones;
          const centers = this._zoneCenters;
          const mask = this._zoneMask, meta = this._zoneMaskMeta;
          zoneCheck = (cx, cy) => {
            let nearest = null;
            if (mask && meta) {
              const ix = Math.round((cx - meta.minX) / meta.cell);
              const iy = Math.round((cy - meta.minY) / meta.cell);
              if (ix >= 0 && ix < meta.gw && iy >= 0 && iy < meta.gh) {
                nearest = mask[iy * meta.gw + ix];
              }
            }
            if (!nearest) {
              let nd2 = Infinity;
              for (const zc of centers) {
                const dx = cx - zc[1], dy = cy - zc[2];
                const d2 = dx * dx + dy * dy;
                if (d2 < nd2) { nd2 = d2; nearest = zc[0]; }
              }
            }
            return nearest && allowed.has(nearest);
          };
        }

        let found = null;
        const p4Shape = shapeHashByPart.get(part.id) || part.id;
        for (const v of variants) {
          const vbb = PU.bbox(v.pts);
          const ck = p4Shape + '|' + v.key + '|' + (partKey || '');
          let ci = p4Cursor.get(ck) || 0;
          for (; ci < candidates.length; ci++) {
            if (++phase4Evals > PHASE4_MAX_EVALS) {
              if (!phase4Capped) console.log('[NestForge Phase 4] evaluation cap reached');
              phase4Capped = true;
              break;
            }
            const [cx, cy] = candidates[ci];
            const x = cx - vbb.x;
            const y = cy - vbb.y;
            if (fitsAt(v, x, y, zoneCheck)) {
              found = { v, x, y };
              break;
            }
          }
          // Everything before ci is rejected for good. If found, ci is the
          // position just taken; the next part of this shape re-tests it,
          // finds it occupied, and moves on.
          p4Cursor.set(ck, ci);
          if (found || phase4Capped) break;
        }

        if (found) {
          const v = found.v;
          const worldPoly = PU.translate(v.pts, found.x, found.y);
          let rPts = v.mirror ? PU.mirror(part.pts, v.mirror) : part.pts;
          rPts = PU.rotate(rPts, v.rotation);
          const innerLines = (part.innerLines || []).map(il => {
            let lp = v.mirror ? PU.mirror(il.pts, v.mirror) : il.pts;
            return { pts: PU.rotate(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
          });
          const plc = {
            partId: part.id, partName: part.name, color: part.color,
            shapeHash: shapeHashByPart.get(part.id),
            _uid: part._uid, pts: rPts, worldPoly, localPoly: v.pts,
            variantKey: v.key,
            x: margin + found.x, y: margin + found.y,
            nfpX: found.x, nfpY: found.y,
            rotation: v.rotation, mirror: v.mirror, sheet: 0, innerLines,
            _phase4: true,
          };
          placed.push(plc);
          phase4Placed.push(part._uid);
          const off = PU.offsetSingle(worldPoly, gap, 'square') || worldPoly;
          placedOutsets.push({ poly: off, bbox: PU.bbox(off) });
          try { _emit({ placement: plc, totalPlaced: placed.length, sheetIdx: 0 }); } catch(_){}
          const bb = PU.bbox(worldPoly);
          if (bb.maxX > curMaxX) curMaxX = bb.maxX;
          if (bb.maxY > curMaxY) curMaxY = bb.maxY;
        }
      }

      if (phase4Placed.length > 0) {
        const placedSet = new Set(phase4Placed);
        const filtered = unplacedItems.filter(p => !placedSet.has(p._uid));
        unplacedItems.length = 0;
        for (const p of filtered) unplacedItems.push(p);
        console.log(`[NestForge Phase 4] edge-fill placed ${phase4Placed.length} extra parts from corners/edges`);

        // POST-VERIFICATION: scan all final placements, count how many overlap
        // each other (bbox-level test). If overlap detected, REMOVE the
        // offending Phase 4 placements from the result so they go to next sheet.
        const overlapsToRemove = new Set();
        for (let i = 0; i < placed.length; i++) {
          const a = placed[i];
          if (!a._phase4) continue;  // only check Phase 4 additions
          const aBB = PU.bbox(a.worldPoly);
          for (let j = 0; j < placed.length; j++) {
            if (i === j) continue;
            const b = placed[j];
            const bBB = PU.bbox(b.worldPoly);
            if (aBB.maxX < bBB.minX || aBB.minX > bBB.maxX) continue;
            if (aBB.maxY < bBB.minY || aBB.minY > bBB.maxY) continue;
            // Real intersection test
            const inter = PU.intersection([a.worldPoly], [b.worldPoly]);
            if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 1.0) {
              overlapsToRemove.add(i);
              break;
            }
          }
        }
        if (overlapsToRemove.size > 0) {
          console.warn(`[NestForge Phase 4] removing ${overlapsToRemove.size} overlapping placements (will go to next sheet)`);
          // Sort indices descending so removal doesn't shift other indices
          const sortedRemovals = [...overlapsToRemove].sort((a, b) => b - a);
          for (const idx of sortedRemovals) {
            const removed = placed[idx];
            // Put back into unplaced queue
            const partDef = partDefs.find(p => p.id === removed.partId);
            if (partDef) {
              unplacedItems.push({ ...partDef, _uid: removed._uid });
            }
            placed.splice(idx, 1);
          }
          console.log(`[NestForge Phase 4] post-cleanup: ${placed.length} valid placements, ${unplacedItems.length} returned to queue`);
        }
      } else {
        console.log(`[NestForge Phase 4] no edge candidates fit (${unplacedItems.length} parts remain unplaced)`);
      }

      // Update result struct
      result.placed = placed.length;
      result.unplaced = unplacedItems.length;
      result.maxX = curMaxX;
      result.maxY = curMaxY;
    };

    // scorePass: lower is better. SIMPLIFIED — maximize placed count is the
    // user's actual goal ("publish whichever placed more"). Ties broken by
    // tighter bbox. Previous version used unplaced*1e12 which was supposed
    // to maximize placed but had a subtle issue: if set abandonment happened
    // differently between BL and cavity passes, unplaced counts could differ
    // in ways that didn't reflect actual placement quality. Direct -placed*X
    // is unambiguous: placed=46 ALWAYS beats placed=36 regardless of how
    // many other parts ended up "unplaced" due to set abandonment.
    // Copies-as-sets: complete sets come before the raw count, so a pass
    // with 3 of each beats one with more parts but only 2 of something.
    const scorePass = (r) =>
      -(r.completeSets || 0) * 1e12
      -r.placed * 1e9        // dominant: more placed = much better (negative cost)
      + r.maxX * r.maxY;     // tiebreaker: tighter bbox = better

    // Single-sheet pass: try each ordering with BL-only and (for dense mode)
    // cavity-aware placement. Keep whichever placed the most parts. Phase 4
    // edge-fill runs ONCE on the winning result at the end (not per ordering).
    // For nest mode, only cavity-aware is tried (BL filter is off in nest).
    const singleSheetBestPass = async (queue, progressOffset, progressScale) => {
      let bestPass = null;
      let bestLabel = null;
      const denseMode = fillSheet || multiSheet;
      const cavityModes = denseMode ? [false, true] : [true];
      const totalPasses = orderings.length * cavityModes.length;
      let passIdx = 0;
      let earlyExit = false;
      const passResults = [];  // diagnostic: track every pass for honest reporting

      // ── Compute all passes at once, choose exactly as below ──────────
      // Each pass is deterministic and independent (no randomness, every
      // limit is a count, fresh engine state per worker), so a pass gives the
      // same result in a worker as it would here. The loop below then walks
      // the results in the original order, with the original comparison and
      // the original early-exit rule, so the winner is the one the
      // one-by-one loop would have chosen. First sheet only: later sheets
      // nest what the previous sheet left, which a worker cannot rebuild.
      let precomputed = null;
      // Below ~48 queued parts a pass takes well under a second and starting
      // workers costs more than it saves (measured: a 16-part job went from
      // 1.1 s to 1.3 s). Small jobs stay on the one-by-one loop.
      const PARALLEL_MIN_QUEUE = 48;
      if (queue === baseQueue && totalPasses >= 3 && queue.length >= PARALLEL_MIN_QUEUE && !settings._singlePass
          && typeof EngineWorkers !== 'undefined' && EngineWorkers.mode !== 'sequential'
          && !(isCancelled && isCancelled())) {
        const jobs = [];
        for (let oi = 0; oi < orderings.length; oi++) {
          for (const cavityAware of cavityModes) {
            jobs.push({ kind: 'nestPass', partDefs,
              settings: Object.assign({}, settings, { _singlePass: { ordering: oi, cavityAware } }) });
          }
        }
        const t0 = performance.now();
        try {
          precomputed = await EngineWorkers.run(jobs,
            (f, msg) => onProgress(progressOffset + f * progressScale, msg), isCancelled, 'passes');
          console.log(`[NestForge] ${totalPasses} passes in parallel on ` +
            `${Math.min(totalPasses, EngineWorkers.threads())} workers in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        } catch (err) {
          if (EngineWorkers.mode === 'parallel') throw err;
          console.warn('[NestForge] parallel passes not available (' + ((err && err.message) || err) +
            '), running them one by one');
          precomputed = null;
        }
      }

      for (let oi = 0; oi < orderings.length; oi++) {
        for (const cavityAware of cavityModes) {
          if (isCancelled && isCancelled()) break;
          let r;
          if (precomputed) {
            r = precomputed[passIdx];
            if (!r) break;   // only missing if cancelled mid-run, as the loop above would break
          } else {
            const q = [...queue].sort(orderings[oi]);
            const prog = (pct, msg) => onProgress(
              progressOffset + (passIdx + pct) / totalPasses * progressScale,
              `Ordering ${oi + 1}${cavityAware ? ' +cavity' : ''}: ${msg}`);
            r = await runPass(q, prog, cavityAware);
          }
          const passLabel = `Ord${oi + 1}${cavityAware ? '+cav' : '+BL'}`;
          const score = scorePass(r);
          passResults.push({ label: passLabel, placed: r.placed, unplaced: r.unplaced, maxX: r.maxX, maxY: r.maxY, score });
          console.log(`[NestForge pass] ${passLabel}: placed=${r.placed}, unplaced=${r.unplaced}` +
            (derivedSets ? `, sets=${r.completeSets}/${nSetsWanted}` : '') +
            `, bbox=${Math.round(r.maxX)}×${Math.round(r.maxY)}, score=${score.toExponential(3)}`);
          if (!bestPass || score < scorePass(bestPass)) {
            bestPass = r;
            bestLabel = passLabel;
          }
          passIdx++;
          if (bestPass.unplaced === 0 && oi === 0 && bestPass.maxY < usH * 0.6) {
            earlyExit = true;
            break;
          }
        }
        if (earlyExit) break;
      }
      // Diagnostic — show all passes ranked
      if (passResults.length > 1) {
        const ranked = passResults.slice().sort((a, b) => a.score - b.score);
        console.log(`[NestForge] passes ranked best→worst:`);
        for (const p of ranked) {
          const marker = p.label === bestLabel ? ' ← WINNER' : '';
          console.log(`  ${p.label}: placed=${p.placed}${marker}`);
        }
      }
      // The workers could not stream placements to the live preview; show
      // the chosen layout now. (Sequential passes streamed as they ran.)
      if (precomputed && bestPass && bestPass.placements) {
        for (let i = 0; i < bestPass.placements.length; i++) {
          try { _emit({ placement: bestPass.placements[i], totalPlaced: i + 1, sheetIdx: 0 }); } catch (_) {}
        }
      }
      // Run Phase 4 edge-fill exactly ONCE on the winning result
      if (bestPass && bestPass.unplaced > 0) {
        const beforePhase4 = bestPass.placed;
        await runPhase4(bestPass);
        if (derivedSets) bestPass.completeSets = countSets(bestPass.placements);
        if (bestPass.placed > beforePhase4) {
          console.log(`[NestForge] Phase 4 added ${bestPass.placed - beforePhase4} parts (${beforePhase4} → ${bestPass.placed})`);
        }
      }
      return bestPass;
    };

    // ── WORKER MODE: one pass of the first sheet, raw ──────────────────
    // EngineWorkers runs nest() in a worker with settings._singlePass set.
    // Everything above was built exactly as for a normal run (same code,
    // same inputs), so the pass sees the same queue, variants and zones.
    // The page-side singleSheetBestPass() collects six of these and
    // chooses among them with the same rule as its one-by-one loop.
    if (settings._singlePass) {
      const sp = settings._singlePass;
      const q = [...baseQueue].sort(orderings[sp.ordering]);
      return await runPass(q, (pct, msg) => onProgress(pct, msg), !!sp.cavityAware);
    }

    // ── MAIN LOOP: single sheet OR overflow to many sheets ──
    const MAX_SHEETS = 50;  // safety limit — avoid infinite loops on degenerate input
    const allPlacements = [];
    const sheetsList = [];
    let remainingQueue = baseQueue;
    let sheetIdx = 0;
    let totalUnplaced = 0;

    // ── DIAGNOSTIC: log entry conditions for multi-sheet
    console.log(`════════════════════════════════════════════════════════════`);
    console.log(`[MULTI-SHEET DEBUG] Engine starting`);
    console.log(`  baseQueue.length = ${baseQueue.length}  (parts to place)`);
    console.log(`  multiSheet flag  = ${multiSheet}`);
    console.log(`  fillSheet flag   = ${fillSheet}`);
    console.log(`  sheetW × sheetH  = ${settings.sheetW} × ${settings.sheetH}`);
    console.log(`  margin / gap     = ${margin} / ${gap}`);
    console.log(`  copies / setMode = ${copies} / ${setMode}`);
    console.log(`════════════════════════════════════════════════════════════`);

    while (remainingQueue.length > 0) {
      if (isCancelled && isCancelled()) break;
      if (sheetIdx >= MAX_SHEETS) {
        totalUnplaced = remainingQueue.length;
        console.log(`[MULTI-SHEET] hit MAX_SHEETS=${MAX_SHEETS} cap`);
        break;
      }

      // Progress — divide the 0-100% bar into chunks per sheet (approximate)
      const estTotalSheets = Math.max(1, Math.ceil(baseQueue.length / Math.max(1, baseQueue.length - remainingQueue.length + 1)));
      const progressOffset = sheetIdx / Math.max(1, estTotalSheets);
      const progressScale = 1 / Math.max(1, estTotalSheets);
      onProgress(Math.min(0.99, progressOffset),
                 `Sheet ${sheetIdx + 1}: nesting ${remainingQueue.length} parts…`);

      console.log(`[MULTI-SHEET] >>> Starting sheet ${sheetIdx + 1} with ${remainingQueue.length} parts in queue`);
      const bestPass = await singleSheetBestPass(remainingQueue, progressOffset, progressScale);
      if (!bestPass) { console.log(`[MULTI-SHEET] sheet ${sheetIdx + 1}: bestPass=null, BREAKING`); break; }

      console.log(`[MULTI-SHEET] sheet ${sheetIdx + 1} done: placed=${bestPass.placed}, reported_unplaced=${bestPass.unplaced}, unplacedItems_array_length=${bestPass.unplacedItems ? bestPass.unplacedItems.length : 'NULL'}`);

      // If this sheet placed nothing, the remaining parts are too big for the
      // sheet — stop the overflow loop. These become unplaced.
      if (bestPass.placed === 0) {
        totalUnplaced = remainingQueue.length;
        console.log(`[MULTI-SHEET] sheet ${sheetIdx + 1} placed nothing, BREAKING with ${totalUnplaced} unplaced`);
        break;
      }

      // Tag placements with this sheet index
      for (const p of bestPass.placements) p.sheet = sheetIdx;
      allPlacements.push(...bestPass.placements);
      sheetsList.push({ idx: sheetIdx, placements: bestPass.placements });

      // Continue with items that didn't fit on this sheet
      const inputQueue = remainingQueue;  // save reference for recovery
      remainingQueue = bestPass.unplacedItems || [];
      sheetIdx++;
      // Copies-as-sets: extras only top up a sheet, they never open one.
      // Once every set part is placed, leftover extras are done, not unplaced.
      if (derivedSets && remainingQueue.length && remainingQueue.every(p => p._exhaustFill)) {
        console.log(`[MULTI-SHEET] all ${nSetsWanted} sets placed; ${remainingQueue.length} fill extras left over`);
        remainingQueue = [];
      }

      // CRITICAL DIAGNOSTIC: if reported unplaced count > 0 but unplacedItems
      // array is empty, that's a desync bug — engine claims items are unplaced
      // but doesn't pass them to the next sheet. RECOVER by computing the
      // real unplaced list from input queue minus what was placed.
      if (bestPass.unplaced > 0 && remainingQueue.length === 0) {
        console.error(`[MULTI-SHEET] ⚠️ DESYNC DETECTED: bestPass.unplaced=${bestPass.unplaced} but unplacedItems array is EMPTY. Recovering from input queue…`);
        const placedUids = new Set();
        for (const p of bestPass.placements) if (p._uid) placedUids.add(p._uid);
        const recovered = inputQueue.filter(p => !placedUids.has(p._uid));
        console.log(`[MULTI-SHEET] recovered ${recovered.length} unplaced parts from input queue (vs reported ${bestPass.unplaced})`);
        remainingQueue = recovered;
      }

      // Stop conditions:
      //  • multiSheet=false: user wants exactly 1 sheet, never overflow
      //  • multiSheet=true + nothing left: all done
      //  • multiSheet=true + remaining > 0: overflow to next sheet
      // Note: fillSheet (Fill Entire Sheet button) is now COMPATIBLE with
      // multi-sheet — fillSheet just means "saturate each sheet to its max"
      // before moving on. Previously fillSheet forced single-sheet which
      // contradicted user intent when both checkboxes were on.
      if (!multiSheet) {
        // Copies-as-sets: only the missing set parts count as unplaced;
        // fill extras that found no room are not parts the user asked for.
        totalUnplaced = derivedSets ? remainingQueue.filter(p => !p._exhaustFill).length : remainingQueue.length;
        console.log(`[MULTI-SHEET] STOPPING after sheet ${sheetIdx}: multiSheet=false (single-sheet mode), remaining=${totalUnplaced} parts will be UNPLACED`);
        break;
      }
      if (remainingQueue.length === 0) {
        console.log(`[MULTI-SHEET] all parts placed across ${sheetIdx} sheet(s)`);
        break;
      }
      console.log(`[MULTI-SHEET] continuing to sheet ${sheetIdx + 1} with ${remainingQueue.length} parts in queue`);
    }

    console.log(`════════════════════════════════════════════════════════════`);
    console.log(`[MULTI-SHEET FINAL] sheets=${sheetsList.length}, total_placed=${allPlacements.length}, total_unplaced=${totalUnplaced}`);
    sheetsList.forEach((sh, i) => console.log(`  Sheet ${i+1}: ${sh.placements.length} placements`));
    console.log(`════════════════════════════════════════════════════════════`);

    if (sheetsList.length === 0) {
      // Nothing placed at all (parts too big etc.)
      sheetsList.push({ idx: 0, placements: [] });
    }

    const out = {
      placements: allPlacements,
      sheets: sheetsList,
      placed: allPlacements.length,
      unplaced: totalUnplaced,
      sheetCount: sheetsList.length,
      usableW: usW, usableH: usH, effRes: 'polygon'
    };
    // Fill mode inflates the queue to saturate the sheet; what is left of that
    // queue is not "unplaced", the sheet is simply full.
    if (fillSheet && !derivedSets && !settings._autoExpandQueueCap) out.unplaced = 0;
    if (derivedSets) {
      // What the user asked for and what they got: N of each part. Unplaced
      // is the shortfall against the request (an extra of a part covers a
      // set copy of it that was skipped); fill extras are never unplaced.
      out.sets = { requested: nSetsWanted, complete: countSets(allPlacements), partsPerSet: partDefs.length,
                   perPart: placedPerPart(allPlacements) };
      out.unplaced = out.sets.perPart.reduce((a, r) => a + Math.max(0, nSetsWanted - r.placed), 0);
      console.log(`[NestForge sets] ${out.sets.complete} of ${nSetsWanted} complete sets (${partDefs.length} parts each), ${allPlacements.length} parts placed`);
    }
    return out;
  },

  /* Compute a stable hash of a polygon's shape. Parts with the same
     vertices (e.g. 20 copies of the same DXF) produce the same hash,
     allowing NFP cache hits across copies. Uses vertex count + bbox +
     first few vertex coords as the signature. */
  _shapeHash(pts) {
    if (!pts || pts.length === 0) return 'empty';
    let minX = pts[0][0], minY = pts[0][1], maxX = minX, maxY = minY;
    for (let i = 1; i < pts.length; i++) {
      const x = pts[i][0], y = pts[i][1];
      if (x < minX) minX = x; else if (x > maxX) maxX = x;
      if (y < minY) minY = y; else if (y > maxY) maxY = y;
    }
    const w = (maxX - minX).toFixed(2);
    const h = (maxY - minY).toFixed(2);
    // Sample 8 vertices evenly to disambiguate different shapes with same bbox
    const n = pts.length;
    let sig = '';
    for (let i = 0; i < 8; i++) {
      const idx = Math.floor(i * n / 8);
      sig += (pts[idx][0] - minX).toFixed(1) + ',' + (pts[idx][1] - minY).toFixed(1) + ';';
    }
    return `${n}_${w}x${h}_${sig}`;
  },

  /* ══════════════════════════════════════════════════════════════════
     INCREMENTAL EDGE-FILL — used by App.tryImprove()
     ─────────────────────────────────────────────────────────────────
     Takes an EXISTING set of placements (from a finished nest OR a
     hand-adjusted layout) and tries to squeeze more parts into the
     remaining empty space WITHOUT moving any existing placement.

     Unlike runPhase4 (which runs INSIDE the nest pipeline with internal
     state), denseEdgeFill is a standalone pass callable after nesting.
     Uses the same edge-anchor + dense grid strategy but with a MUCH
     finer 10mm grid (vs 25mm in Phase 4) and a longer 15-second budget
     because it's user-initiated (they expect some wait).

     For the queue: cycles through every partDef and generates many
     copies of each, largest-first. Respects per-component zone rules.

     Returns array of newly-placed placement objects ready to append
     to nestResult.placements.
     ═════════════════════════════════════════════════════════════════ */
  async denseEdgeFill(existingPlacements, partDefs, settings, isCancelled, budgetMs, onPlacement) {
    const margin = settings.margin || 5;
    const gap = settings.gap || 2;
    const usW = settings.sheetW - 2 * margin;
    const usH = settings.sheetH - 2 * margin;
    const sheetOutline = settings.sheetOutline;
    const BUDGET_MS = (budgetMs != null) ? budgetMs : 15000;
    // Diversity seed — randomizes candidate ordering so repeat calls don't
    // produce identical results. 0 = deterministic (Phase 4 default).
    const diversitySeed = settings._diversitySeed || 0;

    const variantsByPart = new Map();
    for (const p of partDefs) {
      const rots = p._rotations || settings.rotations || [0, 90, 180, 270];
      const mm = p._mirrorMode || settings.mirrorMode || 'none';
      const variants = this.buildVariants(p.pts, rots, mm);
      variantsByPart.set(p.id, variants);
    }

    this._zoneCenters = null;
    if (settings.sheetLabels && settings.sheetLabels.length) {
      this._zoneCenters = this._getZoneCenters(settings.sheetLabels);
    }

    // Gap-outset of existing placements in USABLE-AREA coords. Existing
    // placements have pl.x in canvas coords (margin included); worldPoly
    // (if present) is in usable-area coords (no margin).
    const placedOutsets = existingPlacements.map(pl => {
      let wp;
      if (pl.worldPoly && pl.worldPoly.length >= 3) {
        wp = pl.worldPoly;
      } else {
        const pb = PU.bbox(pl.pts);
        wp = pl.pts.map(p => [p[0] - pb.x + pl.x - margin, p[1] - pb.y + pl.y - margin]);
      }
      const off = PU.offsetSingle(wp, gap, 'square') || wp;
      return { poly: off, bbox: PU.bbox(off) };
    });

    const defectPolys = (settings.defects || []).map(d => {
      let poly;
      if (d.shape && d.shape.length >= 3) {
        poly = d.shape;
      } else {
        poly = [];
        const r = d.r + gap;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * 2 * Math.PI;
          poly.push([d.x + r * Math.cos(a), d.y + r * Math.sin(a)]);
        }
      }
      return { poly, bbox: PU.bbox(poly) };
    });

    const fitsAt = (variant, x, y, zoneCheck) => {
      const wp = PU.translate(variant.pts, x, y);
      const bb = PU.bbox(wp);
      if (bb.x < -0.5 || bb.y < -0.5) return false;
      if (bb.x + bb.w > usW + 0.5 || bb.y + bb.h > usH + 0.5) return false;
      if (sheetOutline && sheetOutline.length >= 3) {
        const cx = bb.x + bb.w * 0.5, cy = bb.y + bb.h * 0.5;
        if (!PU.contains(sheetOutline, [cx, cy])) return false;
        for (const v of wp) {
          if (!PU.contains(sheetOutline, v)) return false;
        }
      }
      if (zoneCheck) {
        const cx = bb.x + bb.w * 0.5, cy = bb.y + bb.h * 0.5;
        if (!zoneCheck(cx, cy)) return false;
      }
      for (const po of placedOutsets) {
        if (bb.x > po.bbox.x + po.bbox.w + 0.1) continue;
        if (bb.x + bb.w < po.bbox.x - 0.1) continue;
        if (bb.y > po.bbox.y + po.bbox.h + 0.1) continue;
        if (bb.y + bb.h < po.bbox.y - 0.1) continue;
        const inter = PU.intersection([wp], [po.poly]);
        if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 0.5) return false;
      }
      for (const dp of defectPolys) {
        if (bb.x > dp.bbox.x + dp.bbox.w + 0.1) continue;
        if (bb.x + bb.w < dp.bbox.x - 0.1) continue;
        if (bb.y > dp.bbox.y + dp.bbox.h + 0.1) continue;
        if (bb.y + bb.h < dp.bbox.y - 0.1) continue;
        const inter = PU.intersection([wp], [dp.poly]);
        if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 0.5) return false;
      }
      return true;
    };

    const candidates = [];
    candidates.push([0, 0], [usW, 0], [0, usH], [usW, usH]);
    if (sheetOutline && sheetOutline.length >= 3) {
      for (const v of sheetOutline) candidates.push([v[0], v[1]]);
      for (let i = 0; i < sheetOutline.length; i++) {
        const a = sheetOutline[i], b = sheetOutline[(i + 1) % sheetOutline.length];
        candidates.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    }
    const GRID_STEP = 10;  // dense — 2.5× denser than Phase 4
    for (let gy = 0; gy <= usH; gy += GRID_STEP) {
      for (let gx = 0; gx <= usW; gx += GRID_STEP) {
        candidates.push([gx, gy]);
      }
    }
    // Diversity: stable shuffle the grid candidates (NOT corners/outline —
    // those are always tried first as they're the highest-value positions).
    if (diversitySeed) {
      // Separate corners+outline (already pushed first) from grid
      const cornerCount = 4 + (sheetOutline ? sheetOutline.length * 2 : 0);
      const corners = candidates.slice(0, cornerCount);
      const grid = candidates.slice(cornerCount);
      // Fisher-Yates with seeded PRNG
      let s = diversitySeed >>> 0;
      const rand = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
      };
      for (let i = grid.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [grid[i], grid[j]] = [grid[j], grid[i]];
      }
      candidates.length = 0;
      candidates.push(...corners, ...grid);
    }

    const queue = [];
    let uid = 0;
    for (const p of partDefs) {
      const partArea = PU.area(p.pts);
      if (partArea < 1) continue;
      const maxN = Math.min(500, Math.max(10, Math.ceil((usW * usH * 0.4) / partArea)));
      for (let i = 0; i < maxN; i++) {
        queue.push({ ...p, _uid: 'inc_' + (uid++) });
      }
    }
    queue.sort((a, b) => PU.area(b.pts) - PU.area(a.pts));

    const startT = performance.now();
    const newPlacements = [];

    for (const part of queue) {
      if (isCancelled && isCancelled()) break;
      if (performance.now() - startT > BUDGET_MS) {
        console.log('[Improve dense-fill] budget exhausted after', newPlacements.length, 'new parts');
        break;
      }
      const variants = variantsByPart.get(part.id);
      if (!variants || !variants.length) continue;

      const partKey = part._componentKey;
      const partRule = (partKey && settings.componentRules) ? settings.componentRules.get(partKey) : null;
      let zoneCheck = null;
      if (partRule && partRule.allowedZones && partRule.allowedZones.size && this._zoneCenters) {
        const allowed = partRule.allowedZones;
        const centers = this._zoneCenters;
        zoneCheck = (cx, cy) => {
          let nearest = null, nd2 = Infinity;
          for (const zc of centers) {
            const dx = cx - zc[1], dy = cy - zc[2];
            const d2 = dx * dx + dy * dy;
            if (d2 < nd2) { nd2 = d2; nearest = zc[0]; }
          }
          return nearest && allowed.has(nearest);
        };
      }

      let found = null;
      outer: for (const v of variants) {
        const vbb = PU.bbox(v.pts);
        for (const [cx, cy] of candidates) {
          const x = cx - vbb.x;
          const y = cy - vbb.y;
          if (fitsAt(v, x, y, zoneCheck)) {
            found = { v, x, y };
            break outer;
          }
        }
      }

      if (found) {
        const v = found.v;
        const worldPoly = PU.translate(v.pts, found.x, found.y);
        let rPts = v.mirror ? PU.mirror(part.pts, v.mirror) : part.pts;
        rPts = PU.rotate(rPts, v.rotation);
        const innerLines = (part.innerLines || []).map(il => {
          let lp = v.mirror ? PU.mirror(il.pts, v.mirror) : il.pts;
          return { pts: PU.rotate(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
        });
        const plc = {
          partId: part.id, partName: part.name, color: part.color,
          _uid: part._uid, pts: rPts, worldPoly, localPoly: v.pts,
          variantKey: v.key,
          x: margin + found.x, y: margin + found.y,
          nfpX: found.x, nfpY: found.y,
          rotation: v.rotation, mirror: v.mirror, sheet: 0, innerLines,
          _improveFill: true,
        };
        newPlacements.push(plc);
        const off = PU.offsetSingle(worldPoly, gap, 'square') || worldPoly;
        placedOutsets.push({ poly: off, bbox: PU.bbox(off) });
        // Emit for live preview
        if (onPlacement) {
          try { onPlacement({ placement: plc, totalPlaced: existingPlacements.length + newPlacements.length, sheetIdx: 0 }); } catch(_) {}
        }
      }
    }

    console.log(`[Improve dense-fill] added ${newPlacements.length} new parts in ${Math.round(performance.now() - startT)}ms`);
    return newPlacements;
  },

  /* ══════════════════════════════════════════════════════════════════
     SHAKE-AND-FIT — simulates manual drag-rotate optimization.
     ─────────────────────────────────────────────────────────────────
     For each existing placement (largest-first, up to N parts within
     time budget):
       1. Try ALTERNATE rotations in place (at same centroid)
       2. For each rotation that's still valid (no overlap), run a
          QUICK denseEdgeFill (2s budget) to see if the new orientation
          has opened space for more parts
       3. Keep whichever rotation yielded the most extras
     Returns { layout, totalAdded }. Layout is the modified placements
     array; totalAdded is the count of new parts placed via this shake.

     This is the "piece-by-piece" optimization the user wanted — exactly
     like manually rotating a piece to open a gap, then dropping another
     piece into that gap.
     ═════════════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════
     SHAKE-AND-FIT — aggressive perturbation search.
     ─────────────────────────────────────────────────────────────────
     What user does manually: pick a part, MOVE/ROTATE it, see if more
     parts fit in the freed space. If yes, keep the new layout. If no,
     try another part. Repeat until truly no more fits anywhere.

     Algorithm — for each placed part (largest area first, time budget):
       Strategy A — LIFT-AND-REPLACE:
         1. Temporarily REMOVE this part from layout
         2. Run denseEdgeFill on the gap-augmented layout
         3. If we placed >1 new part, the part we removed got REPLACED
            by 2+ pieces — net gain. Commit.
         4. If we placed exactly 1 (just put it back same spot), try
            putting it in a different rotation/spot via Strategy B.
       Strategy B — ROTATE IN PLACE:
         1. For each alternate rotation (90/180/270 of original):
            a. Remove the part, rotate it, try to place it back near
               original centroid via fitsAt scan
            b. If fits, run denseEdgeFill on the rotated layout
            c. Track which rotation gave most extras
         2. Commit best rotation if it gained >0 parts
       Strategy C — SHIFT TO BEST FIT:
         1. Remove part, scan all candidate positions in usable area
            for THIS part's largest variant
         2. Place in best fit (that doesn't overlap), then denseEdgeFill
         3. Commit if total parts increased

     Each part attempted with all three strategies in sequence — first
     strategy that yields a net gain wins. No gain → part stays put.
     ═════════════════════════════════════════════════════════════════ */
  async shakeAndFit(layout, partDefs, settings, isCancelled, timeBudgetMs, onPlacement, onShake) {
    const TIME_BUDGET = timeBudgetMs || 15000;
    const startT = performance.now();
    let newLayout = layout.slice();
    let totalAdded = 0;
    const margin = settings.margin || 5;
    const gap = settings.gap || 2;

    // Sort by area DESC — bigger parts have more impact
    const shakeOrder = newLayout
      .map((pl, idx) => ({ pl, idx, area: PU.area(pl.pts) }))
      .sort((a, b) => b.area - a.area);

    const MAX_SHAKE = Math.min(40, shakeOrder.length);

    // Helper: count how many of each component currently in layout
    const countByPartId = (lay) => {
      const m = new Map();
      for (const p of lay) m.set(p.partId, (m.get(p.partId) || 0) + 1);
      return m;
    };

    // Initial counts — used to verify "lift-and-replace" actually adds NEW parts
    const initialCount = newLayout.length;

    for (let k = 0; k < MAX_SHAKE; k++) {
      if (performance.now() - startT > TIME_BUDGET) break;
      if (isCancelled && isCancelled()) break;

      const { pl } = shakeOrder[k];
      const realIdx = newLayout.findIndex(p => p._uid === pl._uid);
      if (realIdx < 0) continue;  // already replaced
      const partDef = partDefs.find(p => p.id === pl.partId);
      if (!partDef) continue;

      const beforeCount = newLayout.length;
      let bestNewLayout = null;
      let bestGain = 0;

      // ─── STRATEGY A: LIFT-AND-REPLACE ──────────────────────────
      // Remove this part, run denseEdgeFill — does the freed space let
      // us fit 2+ pieces where there was just this one?
      try {
        const liftedLayout = newLayout.slice();
        liftedLayout.splice(realIdx, 1);
        const fillBudget = Math.min(2000, Math.max(800, (TIME_BUDGET - (performance.now() - startT)) / (MAX_SHAKE - k) / 3));
        const extras = await this.denseEdgeFill(liftedLayout, partDefs, settings, isCancelled, fillBudget);
        // Net gain = extras placed - 1 (we removed one)
        const gain = extras.length - 1;
        if (gain > bestGain) {
          bestGain = gain;
          bestNewLayout = liftedLayout.concat(extras);
        }
      } catch (e) { /* ignore individual failures */ }

      // ─── STRATEGY B: ROTATE IN PLACE ───────────────────────────
      // Only run if Strategy A didn't yield a gain — saves time.
      if (bestGain <= 0) {
        const allRots = partDef._rotations || settings.rotations || [0, 90, 180, 270];
        const currentRot = pl.rotation || 0;
        const rotsToTry = allRots.filter(r => r !== currentRot);

        const partKey = pl._componentKey || (pl.partName ? pl.partName.replace(/_\d+$/, '') : null);
        const partRule = (partKey && settings.componentRules) ? settings.componentRules.get(partKey) : null;
        const allowedZones = partRule && partRule.allowedZones;

        const origBB = PU.bbox(pl.pts);
        const origCX = pl.x + origBB.w / 2;
        const origCY = pl.y + origBB.h / 2;

        for (const tryRot of rotsToTry) {
          if (performance.now() - startT > TIME_BUDGET) break;

          // Zone check
          if (allowedZones && allowedZones.size && this._zoneCenters) {
            const ucX = origCX - margin, ucY = origCY - margin;
            let nearest = null, nd2 = Infinity;
            for (const zc of this._zoneCenters) {
              const dx = ucX - zc[1], dy = ucY - zc[2];
              const d2 = dx * dx + dy * dy;
              if (d2 < nd2) { nd2 = d2; nearest = zc[0]; }
            }
            if (!nearest || !allowedZones.has(nearest)) continue;
          }

          let rPts = partDef.pts;
          if (pl.mirror && pl.mirror !== 'none') rPts = PU.mirror(rPts, pl.mirror);
          rPts = PU.rotate(rPts, tryRot);
          const newBB = PU.bbox(rPts);
          const newX = origCX - newBB.w / 2;
          const newY = origCY - newBB.h / 2;
          const newWP = rPts.map(p => [p[0] - newBB.x + newX - margin, p[1] - newBB.y + newY - margin]);

          // Quick overlap + outline check (cheap)
          const candidatePlacement = {
            ...pl,
            pts: rPts,
            x: newX, y: newY,
            rotation: tryRot,
            worldPoly: newWP,
          };
          // Build test layout: replace pl with rotated version
          const testLayout = newLayout.slice();
          testLayout[realIdx] = candidatePlacement;
          // Quick validity: does rotated part fit + not overlap?
          let valid = true;
          if (settings.sheetOutline && settings.sheetOutline.length >= 3) {
            for (const v of newWP) {
              if (!PU.contains(settings.sheetOutline, v)) { valid = false; break; }
            }
          }
          if (!valid) continue;
          const aBB = PU.bbox(newWP);
          for (let j = 0; j < testLayout.length && valid; j++) {
            if (j === realIdx) continue;
            const other = testLayout[j];
            let oWP = other.worldPoly;
            if (!oWP || oWP.length < 3) continue;
            const bBB = PU.bbox(oWP);
            if (aBB.x > bBB.x + bBB.w + gap + 0.2) continue;
            if (aBB.x + aBB.w < bBB.x - gap - 0.2) continue;
            if (aBB.y > bBB.y + bBB.h + gap + 0.2) continue;
            if (aBB.y + aBB.h < bBB.y - gap - 0.2) continue;
            const offOther = PU.offsetSingle(oWP, gap, 'square') || oWP;
            const inter = PU.intersection([newWP], [offOther]);
            if (inter.length > 0 && inter[0].length >= 3 && PU.area(inter[0]) > 0.5) valid = false;
          }
          if (!valid) continue;

          // Rotation valid → run sub-fill
          try {
            const fillBudget = Math.min(1500, Math.max(500, (TIME_BUDGET - (performance.now() - startT)) / (MAX_SHAKE - k) / 4));
            const extras = await this.denseEdgeFill(testLayout, partDefs, settings, isCancelled, fillBudget);
            if (extras.length > bestGain) {
              bestGain = extras.length;
              bestNewLayout = testLayout.concat(extras);
            }
          } catch (e) { /* ignore */ }
        }
      }

      // ─── COMMIT BEST RESULT ─────────────────────────────────────
      if (bestNewLayout && bestGain > 0) {
        if (onShake) {
          try { onShake({ rotatedIdx: realIdx, newLayout: bestNewLayout, addedCount: bestGain }); } catch(_){}
        }
        newLayout = bestNewLayout;
        totalAdded += bestGain;
      }
    }

    console.log(`[Improve shake-and-fit] shook ${Math.min(MAX_SHAKE, shakeOrder.length)} parts, net gain ${totalAdded} parts (${initialCount}→${newLayout.length}) in ${Math.round(performance.now() - startT)}ms`);
    return { layout: newLayout, totalAdded };
  },

  /* Build variants for a part. Each variant is {rotation, mirror, pts, bbox, key}.
     `pts` is normalized so bbox.min = (0,0). `key` is a stable identifier for
     NFP caching. */
  buildVariants(pts, rotations, mirrors, simplifyTol = 1.5) {
    const out = [];
    // Simplify first — Minkowski (NFP) is O(n·m) in vertex count, so
    // reducing vertex count gives quadratic speedup for nesting.
    // Tolerance=1.5mm preserves shape quality for leather dies (cutting
    // tolerance ~0.5mm) while dropping vertex count 3-5×. Complex vamps
    // go from 300+ verts → 70-90 verts = 10-25× faster NFP computation.
    let cleaned = PU.ensureCCW(pts);
    cleaned = PU.clean(cleaned, 0.1);
    if (cleaned.length > 20) {
      cleaned = PU.simplifyDP(cleaned, simplifyTol);
    }
    for (const mirror of mirrors) {
      const mPts = mirror ? PU.mirror(cleaned, mirror) : cleaned;
      for (const rot of rotations) {
        const rotated = rot ? PU.rotate(mPts, rot) : mPts.slice();
        const bb = PU.bbox(rotated);
        const normalizedPts = PU.translate(rotated, -bb.minX, -bb.minY);
        const normBB = PU.bbox(normalizedPts);
        // Cache key: unique per (partShape, mirror, rotation). Multiple
        // queue entries for the same part share the same variants, so the
        // key only depends on shape identity + transform.
        const key = `${mirror || '0'}_${rot}_${normalizedPts.length}`;
        out.push({
          rotation: rot, mirror, pts: normalizedPts,
          bbox: normBB, key, nVerts: normalizedPts.length
        });
      }
    }
    return out;
  },

  /* Try each variant, pick the best placement across all.
     Returns { x, y, vi } or null.
     placed = list of {worldPoly, partId, variantKey, ...} already on the sheet.
     nfpCache = Map<string, {outer, holes}> — keyed by `partId|vKey|thisPartId|thisVKey`
  */
  async placeBest(variants, placed, sheetW, sheetH, gap, curMaxX, curMaxY,
            thisPartId, nfpCache, fillSheet, cavityAware, sheetOutline, defects,
            shapeHashByPart, isCancelled) {
    let best = null;
    const thisShapeHash = shapeHashByPart ? shapeHashByPart.get(thisPartId) : thisPartId;
    const placedBBoxes = [];
    for (const p of placed) placedBBoxes.push(PU.bbox(p.worldPoly));
    let lastYield = performance.now();
    // Hard time budget: 1 second per part. If a part can't find a spot in
    // 1 second, the nest is too tight for it anyway — move on. This is the
    // most effective way to prevent slow nests since individual-part time
    // is bounded.
    // Per-part limit as a count of candidate positions examined, not seconds,
    // so a part's placement never depends on how fast the machine is. On the
    // profiled jobs the old 3 s limit was never reached; this cap is far
    // above what 3 s allowed, and exists only to bound pathological input.
    const MAX_CANDIDATE_EVALS = 200000;
    let candidateEvals = 0;
    for (let vi = 0; vi < variants.length; vi++) {
      // Abandon if we've spent too long on this single part
      if (candidateEvals > MAX_CANDIDATE_EVALS) break;
      // Yield between variants — 20ms budget to stay responsive
      const now = performance.now();
      if (now - lastYield > 20) {
        if (isCancelled && isCancelled()) return best;
        await sleep(0);
        lastYield = performance.now();
      }
      const v = variants[vi];
      const placeResult = this.placeOne(v.pts, placed, sheetW, sheetH, gap,
                                        thisShapeHash, v.key, nfpCache);
      if (!placeResult) continue;
      const { candidates, perPolyBL } = placeResult;
      if (!candidates || !candidates.length) continue;
      const bb = v.bbox;

      // For dense mode WITHOUT cavity-awareness: use per-polygon BL points.
      // The feasible region may have multiple separate polygons — typically
      // one outer region plus zero or more "cavity islands" (valid positions
      // inside concavities of placed parts). Per-polygon BL gives each
      // cavity its own BL candidate to compete against the outer-region BL.
      // Cavities usually win because they don't extend the overall bbox.
      // For cavity-aware mode (or nest mode), keep all candidates so we can
      // discover positions inside concavities of already-placed parts.
      let positionsToTry = (fillSheet && !cavityAware) ? perPolyBL : candidates;

      // ── Leather sheet: augment candidate positions ─────────────
      // When a hide outline is active, the default IFP candidates are the
      // corners/midpoints of the sheet bbox — but those are often OUTSIDE
      // the hide shape. To give the engine positions inside the hide, we
      // sample a coarse grid across the outline bbox (positions that are
      // clearly inside the hide bbox region).
      //
      // CRITICAL: grid candidates must ALSO pass the NFP overlap check
      // against every placed part, otherwise they'd cause visible overlaps.
      // The default IFP-based candidates are NFP-feasible by construction;
      // grid candidates are NOT, so we must test each one explicitly.
      let outlineBB = null;
      const placedBBoxesForOverlap = [];
      if (sheetOutline && placed.length > 0) {
        // Cache placed bboxes for fast overlap rejection
        for (const p of placed) placedBBoxesForOverlap.push({ bb: PU.bbox(p.worldPoly), poly: p.worldPoly });
      }
      if (sheetOutline) {
        outlineBB = PU.bbox(sheetOutline);
        // Grid density: ~12x12 = up to 144 extra candidates. Balances coverage
        // of narrow zones (flanks) vs placement time.
        const stepX = Math.max(bb.w * 0.6, outlineBB.w / 12);
        const stepY = Math.max(bb.h * 0.6, outlineBB.h / 12);
        const extras = [];
        for (let gx = outlineBB.minX; gx <= outlineBB.maxX - bb.w; gx += stepX) {
          for (let gy = outlineBB.minY; gy <= outlineBB.maxY - bb.h; gy += stepY) {
            extras.push({ x: gx, y: gy, _isGrid: true });
          }
        }
        positionsToTry = positionsToTry.concat(extras);
      }

      let candIdx = 0;
      for (const hit of positionsToTry) {
        // Tighter yield schedule — every 8 candidates, 20ms budget.
        candIdx++;
        candidateEvals++;
        if ((candIdx & 7) === 0) {
          // Time budget hard cap
          if (candidateEvals > MAX_CANDIDATE_EVALS) return best;
          const nowY = performance.now();
          if (nowY - lastYield > 20) {
            if (isCancelled && isCancelled()) return best;
            await sleep(0);
            lastYield = performance.now();
          }
        }
        // ── Leather sheet constraint check ──────────────────────────
        // Skip for rectangular sheets (outline/defects both null).
        let zoneScore = 16;  // max = fully in allowed zone (16/16 grid points)
        if (sheetOutline) {
          // FAST bbox reject: candidate + part bbox must fit in hide bbox.
          if (hit.x < outlineBB.minX - 0.5 || hit.x + bb.w > outlineBB.maxX + 0.5 ||
              hit.y < outlineBB.minY - 0.5 || hit.y + bb.h > outlineBB.maxY + 0.5) {
            continue;
          }
          // Full containment check
          const worldPoly = v.pts.map(p => [p[0] + hit.x, p[1] + hit.y]);
          if (!LeatherSheet.insideSheet(worldPoly, sheetOutline)) continue;
          if (defects && defects.length && LeatherSheet.overlapsDefects(worldPoly, defects)) continue;

          // ── Zone constraint check (50% of PART BODY in allowed zone) ────
          // Samples the part body, not the bbox. A U-shaped vamp's empty
          // interior doesn't count toward the 50% — only actual material.
          if (this._zoneCheck) {
            const wbb = PU.bbox(worldPoly);
            // (1) Centroid check — the middle of the part must be in allowed zone
            const ccx = (wbb.minX + wbb.maxX) / 2;
            const ccy = (wbb.minY + wbb.maxY) / 2;
            if (!this._zoneCheck(ccx, ccy)) continue;
            // (2) 50%-of-body check: 5×5 grid, only count points INSIDE polygon.
            // PERF: Use a simplified version of the polygon for the PIP test.
            // Full vamp has 300+ verts → 300 edge tests × 25 points × many
            // candidates = too slow. Simplified (sampled every N verts)
            // preserves overall shape well enough for body/bbox distinction.
            if (!v._simplePoly) {
              const src = v.pts;
              const step = Math.max(1, Math.floor(src.length / 32));
              const simple = [];
              for (let i = 0; i < src.length; i += step) simple.push(src[i]);
              v._simplePoly = simple;
            }
            // Translate simplified poly to world coords
            const simpleN = v._simplePoly.length;
            let okCount = 0;
            let bodyCount = 0;
            // DENSE 10×10 grid (100 points). Previous 5×5 had 8% granularity
            // per sample — too coarse. 10×10 gives 1% granularity so marginal
            // cases (like 49% vs 51%) are correctly decided instead of
            // incorrectly passing due to grid alignment luck.
            const GRID_N = 10;
            for (let gy = 0; gy < GRID_N; gy++) {
              const sy = wbb.minY + wbb.h * ((gy + 0.5) / GRID_N);
              for (let gx = 0; gx < GRID_N; gx++) {
                const sx = wbb.minX + wbb.w * ((gx + 0.5) / GRID_N);
                // Ray-cast PIP using simplified polygon (local coords + offset)
                let inside = false;
                const lsx = sx - hit.x, lsy = sy - hit.y;
                for (let ii = 0, jj = simpleN - 1; ii < simpleN; jj = ii++) {
                  const yi = v._simplePoly[ii][1], yj = v._simplePoly[jj][1];
                  if ((yi > lsy) !== (yj > lsy)) {
                    const xi = v._simplePoly[ii][0], xj = v._simplePoly[jj][0];
                    if (lsx < (xj - xi) * (lsy - yi) / (yj - yi + 1e-12) + xi) inside = !inside;
                  }
                }
                if (!inside) continue;
                bodyCount++;
                if (this._zoneCheck(sx, sy)) okCount++;
              }
            }
            // STRICT MAJORITY: require okCount × 10 > bodyCount × 6 (>60%).
            // Raised from 50% to 60% because strong rotation pairing can
            // override zone preference, so we need the hard rejection to
            // be conservative enough that surviving placements are clearly
            // in-zone, not marginal.
            if (bodyCount > 0 && okCount * 10 < bodyCount * 6) continue;
            zoneScore = bodyCount > 0 ? Math.round((okCount / bodyCount) * 16) : 16;
          }

          // ── DEFENSIVE OVERLAP CHECK for ALL candidates ─────────────
          // Originally this only fired for `hit._isGrid` candidates because
          // NFP-derived candidates are mathematically overlap-free. But NFP
          // cache hits or numerical edge cases can produce candidates that
          // appear feasible but actually overlap when shapes are nearly
          // identical or share a vertex. Symptom: placements appear to
          // overlap visually and material utilization exceeds 100%.
          // Fix: do a vertex-PIP test for every candidate. The cost is
          // negligible (O(N)) and catches all real overlap cases.
          if (placedBBoxesForOverlap.length > 0) {
            const worldBB = PU.bbox(worldPoly);
            let overlapsPlaced = false;
            for (const pb of placedBBoxesForOverlap) {
              if (worldBB.maxX + gap < pb.bb.minX || worldBB.minX - gap > pb.bb.maxX) continue;
              if (worldBB.maxY + gap < pb.bb.minY || worldBB.minY - gap > pb.bb.maxY) continue;
              for (let k = 0; k < pb.poly.length; k++) {
                const px = pb.poly[k][0], py = pb.poly[k][1];
                let inside = false;
                for (let ii = 0, jj = worldPoly.length - 1; ii < worldPoly.length; jj = ii++) {
                  const xi = worldPoly[ii][0], yi = worldPoly[ii][1];
                  const xj = worldPoly[jj][0], yj = worldPoly[jj][1];
                  if ((yi > py) !== (yj > py)) {
                    const xI = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
                    if (px < xI) inside = !inside;
                  }
                }
                if (inside) { overlapsPlaced = true; break; }
              }
              if (overlapsPlaced) break;
              for (let k = 0; k < worldPoly.length; k++) {
                const px = worldPoly[k][0], py = worldPoly[k][1];
                let inside = false;
                for (let ii = 0, jj = pb.poly.length - 1; ii < pb.poly.length; jj = ii++) {
                  const xi = pb.poly[ii][0], yi = pb.poly[ii][1];
                  const xj = pb.poly[jj][0], yj = pb.poly[jj][1];
                  if ((yi > py) !== (yj > py)) {
                    const xI = (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi;
                    if (px < xI) inside = !inside;
                  }
                }
                if (inside) { overlapsPlaced = true; break; }
              }
              if (overlapsPlaced) break;
            }
            if (overlapsPlaced) continue;  // skip this candidate — overlaps existing
          }
        } else if (defects && defects.length) {
          const worldPoly = v.pts.map(p => [p[0] + hit.x, p[1] + hit.y]);
          if (LeatherSheet.overlapsDefects(worldPoly, defects)) continue;
        }

        const newMaxX = Math.max(curMaxX, hit.x + bb.w);
        const newMaxY = Math.max(curMaxY, hit.y + bb.h);
        let cost;
        if (fillSheet) {
          // Dense mode: strict height-first packing. Main cost is bbox
          // extension (newMaxY then newMaxX) — any position that extends
          // less wins. Among positions with EQUAL bbox extension (typical
          // for small parts placed after big parts are down), we face a
          // choice: strip positions (along the edge of the existing layout)
          // vs cavity positions (deep inside a concavity of a placed part).
          //
          // Standard BL tiebreaker prefers lower y/x, which means STRIP
          // positions win. That's wrong when filling — strip space is
          // continuous material that could fit more parts of the same size
          // in a row, while cavity space is geometrically isolated and
          // can't be used by anything bigger.
          //
          // Fix: detect whether this position fits ENTIRELY within the
          // existing bbox (hit.y + bb.h <= curMaxY AND hit.x + bb.w <= curMaxX).
          // If so, it's either a strip or a cavity. For these internal
          // positions, use INVERTED tiebreaker: prefer higher y, then
          // higher x. This fills cavities before strips. For positions
          // that extend the bbox, keep standard BL tiebreaker.
          const fitsInside = (hit.x + bb.w <= curMaxX + 0.5) &&
                             (hit.y + bb.h <= curMaxY + 0.5);
          if (fitsInside) {
            // Check if this candidate position's bbox fits entirely inside
            // an already-placed polygon's bbox. If so, it's a TRUE cavity
            // position (the part goes into a concavity of the placed part —
            // e.g., loop into vamp tongue cutout, small part into J-shape
            // opening). These positions are geometrically isolated: they
            // can't be used by anything bigger, and leaving them empty
            // wastes material. Strongly prefer them over strip positions.
            //
            // Without this bonus, the inverted tiebreaker below picks "deep
            // strip" positions (high y/x in empty bottom-right of layout)
            // over vamp-tongue cavities (moderate y inside a placed part's
            // bbox), because the tongue cavity is at MODERATE y while the
            // bottom strip is at HIGHER y. Inverted tiebreaker prefers
            // higher y, which wrongly loses the true cavity position.
            let insidePlacedBBox = false;
            for (const pb of placedBBoxes) {
              if (hit.x >= pb.minX - 0.5 &&
                  hit.x + bb.w <= pb.maxX + 0.5 &&
                  hit.y >= pb.minY - 0.5 &&
                  hit.y + bb.h <= pb.maxY + 0.5) {
                insidePlacedBBox = true;
                break;
              }
            }
            // Width-growth runs swap the axes: the fixed height fills first.
            const gx = this._growAxisX;
            const M1 = gx ? newMaxX : newMaxY, M2 = gx ? newMaxY : newMaxX;
            const h1 = gx ? hit.x : hit.y, h2 = gx ? hit.y : hit.x;
            if (insidePlacedBBox) {
              // True cavity: subtract a large bonus that dominates the
              // tiebreaker (max ~13k for 1250mm sheet) but is smaller
              // than newMaxX*1e3 (so it never beats a position with a
              // smaller newMaxX). Tiebreaker among cavities: standard BL.
              cost = M1 * 1e6 + M2 * 1e3 - 1e5 + h1 * 10 + h2;
            } else {
              // Internal placement (strip): prefer deeper (higher y) positions.
              // -y * 10 - x makes higher y/x give lower (better) cost.
              cost = M1 * 1e6 + M2 * 1e3 - h1 * 10 - h2;
            }
          } else {
            // External placement (extending bbox): standard BL.
            const gx = this._growAxisX;
            cost = gx ? (newMaxX * 1e6 + newMaxY * 1e3 + hit.x * 10 + hit.y)
                      : (newMaxY * 1e6 + newMaxX * 1e3 + hit.y * 10 + hit.x);
          }
        } else {
          // Nest mode: minimise bbox AREA for tight compact packs.
          const bboxArea = newMaxX * newMaxY;
          cost = bboxArea * 1000 + hit.y * 10 + hit.x;
        }
        // ── ZONE PREFERENCE BONUS ───────────────────────────────────
        // zoneScore is 8..16 (out of 16 grid points). A placement fully
        // inside the zone (16/16) should be MUCH preferred over a boundary
        // placement (8/16). The penalty must sit between newMaxX (1e3) and
        // newMaxY (1e6) so it overrides horizontal packing preference but
        // not vertical bbox growth. Weight: (16 - zoneScore) × 5e5 means
        // a 16/16 placement beats an 8/16 placement by 4e6 — guaranteeing
        // zone-centered wins over zone-edge whenever both are feasible.
        cost += (16 - zoneScore) * 5e5;

        // ── ROTATION PAIRING BONUS (interlock optimization) ─────────
        // For U-shaped parts like vamps, best nesting comes from alternating
        // OPPOSITE rotations. DOMINANT preference for complement rotation.
        // Zone rule compliance is enforced by the strict 60% rejection
        // above (zone violators are removed with `continue` — they never
        // reach this cost comparison), so we can make pairing dominant
        // here without allowing zone violations.
        if (this._lastRotByComp && this._currentCompKey && v.rotation !== undefined) {
          const lastRot = this._lastRotByComp.get(this._currentCompKey);
          if (lastRot !== undefined) {
            const complement = (lastRot + 180) % 360;
            if (v.rotation === complement) {
              cost -= 1e10;  // dominates everything — zone already enforced above
            } else if (v.rotation !== lastRot) {
              cost -= 5e6;
            }
          }
        }

        // Compute candidate centroid ONCE — used by proximity bonus AND
        // by directional sweep below. Previously placeCX/CY was only defined
        // inside `if (!cavityAware)` block, causing a silent ReferenceError
        // crash in the proximity bonus whenever cavityAware mode was on
        // (which is always for hide nests). That's why proximity wasn't
        // working in your tests.
        const placeCX = hit.x + bb.w / 2;
        const placeCY = hit.y + bb.h / 2;

        // ── PROXIMITY-TO-LAST-SAME-COMPONENT BONUS ──────────────────
        // User feedback: "if it started in BUTT it should keep nesting in
        // BUTT and only expand outward, not jump randomly across the sheet."
        // This makes same-component placements cluster spatially.
        //
        // We track the centroid of the LAST placed part of each component.
        // For the current candidate, compute distance from candidate centroid
        // to that last-placed centroid. Closer = lower cost. The penalty must
        // be SMALLER than zone bonus (5e5) so it doesn't break zone rules,
        // but bigger than within-zone tiebreakers (×10) so it actually moves
        // placements toward the cluster.
        // Weight: 1mm distance = 200 cost units. So 100mm away = 20000 extra
        // cost. With newMaxX*1e3 dominating overall packing, this only kicks
        // in among placements that pack equally well.
        if (this._lastCentroidByComp && this._currentCompKey) {
          const lastC = this._lastCentroidByComp.get(this._currentCompKey);
          if (lastC) {
            const dx = placeCX - lastC[0];
            const dy = placeCY - lastC[1];
            const dist = Math.sqrt(dx*dx + dy*dy);
            cost += dist * 200;
          }
        }

        // ── DETERMINISTIC JITTER FOR DIVERSITY ───────────────────────
        // Adds randomness derived from (hit position, variant, seed) that
        // genuinely affects ranking when seed is non-zero.
        //
        // SIZING: tiebreakers below are `hit.y * 10 + hit.x` — for a 1000mm
        // sheet the position difference between two candidates is ~10000
        // cost units. Above that, `newMaxX * 1e3` controls packing growth
        // (10mm bbox shift = 10000 cost). To meaningfully shuffle WITHIN a
        // packing efficiency tier, jitter must reach ~50000. To stay below
        // zone bonus (5e5) and rotation pair (5e6) so it never breaks
        // user rules, we cap at 50000. So range is ±50000.
        //
        // Earlier version used ±50 which was 200× too small to ever change
        // ranking — every GA candidate produced identical results. Fixed.
        if (this._diversitySeed) {
          // Better hash: full 32-bit avalanche (xmur3-like)
          let h = (this._diversitySeed ^ Math.floor(hit.x * 100) ^ (Math.floor(hit.y * 100) << 16) ^ (vi * 2654435761)) >>> 0;
          h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
          h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
          h = (h ^ (h >>> 16)) >>> 0;
          // Map to ±50000 range (4 decimal digits worth of randomness)
          cost += ((h % 100000) - 50000);
        }

        // ── DIRECTIONAL SWEEP COST (bottom-up within zone) ──────────
        // Sweep upward from the BOTTOM of the part's allowed zones.
        // For each candidate, find the NEAREST allowed-zone bottom — so a
        // candidate in BELLY is scored against BELLY's bottom (not against
        // HIND_FLANK's bottom which would be far away). This lets the
        // engine sweep through each zone independently while still
        // preferring lower positions within each zone.
        if (!cavityAware) {
          let nearestBottomY = null;
          let nearestBottomDist = Infinity;
          if (this._zoneBounds && this._currentRule
              && this._currentRule.allowedZones && this._currentRule.allowedZones.size) {
            for (const zname of this._currentRule.allowedZones) {
              const zb = this._zoneBounds[zname];
              if (!zb) continue;
              // Only consider zones whose horizontal extent contains this candidate
              if (placeCX < zb.minX - 50 || placeCX > zb.maxX + 50) continue;
              // Distance from candidate to this zone's bottom
              const d = Math.abs(zb.maxY - placeCY);
              if (d < nearestBottomDist) {
                nearestBottomDist = d;
                nearestBottomY = zb.maxY;
              }
            }
            // Fallback: if no zone matches horizontally, use the bottom-most allowed zone
            if (nearestBottomY === null) {
              for (const zname of this._currentRule.allowedZones) {
                const zb = this._zoneBounds[zname];
                if (zb && (nearestBottomY === null || zb.maxY > nearestBottomY)) {
                  nearestBottomY = zb.maxY;
                }
              }
            }
          }
          if (nearestBottomY !== null) {
            // Distance from placement centroid to nearest matching zone bottom.
            // Closer to bottom = lower cost. Scale: 1mm = 1000 cost units.
            const distFromBottom = Math.abs(nearestBottomY - placeCY);
            cost += distFromBottom * 1000;
          }
        }

        if (best === null || cost < best.cost) {
          best = { x: hit.x, y: hit.y, vi, cost };
        }
      }
    }
    return best;
  },

  /* Place ONE variant: compute feasible region (IFP \ union(NFPs)),
     return ALL candidate points (vertices + edge midpoints of feasible
     polygons). Caller scores them and picks the best.
     Returns { candidates, perPolyBL } or null.
       candidates: array of {x, y} — all vertex/midpoint positions
       perPolyBL: array of {x, y} — the BL point of each feasible polygon
         (one entry per disconnected region of valid positions)  */
  // ── placeOne memo ───────────────────────────────────────────────────
  // The Clipper difference in _placeOneUncached() is the single most
  // expensive operation in the engine: on a real fill-mode job it was 75% of
  // the total run, because every rotation of every queued part recomputes
  // "sheet minus all placed NFPs" from scratch, and most queued parts in fill
  // mode fail to fit. Within a pass the placed list only grows, so a call with
  // the same incoming variant against the same placed list is the same
  // computation. This returns the earlier result instead.
  //
  // Correctness: the memo is keyed by the identity of every placement object
  // in `placed`, in order, plus the incoming variant, sheet and gap. Any
  // mutation of the list, or a different list, misses and recomputes. Only
  // the current length is kept, so memory stays at a few entries per pass.
  // Placement objects are never modified after creation, so identity
  // identifies content. Results are the uncached function's own objects, so
  // they are bit-identical; the arrays are copied so a caller cannot alter
  // what a later hit receives.
  _placeOneMemo: new WeakMap(),

  placeOne(partPts, placed, sheetW, sheetH, gap, thisPartId, thisVKey, nfpCache) {
    if (!Array.isArray(placed) || !thisVKey) {
      return this._placeOneUncached(partPts, placed, sheetW, sheetH, gap, thisPartId, thisVKey, nfpCache);
    }
    let memo = this._placeOneMemo.get(placed);
    let same = !!memo && memo.refs.length === placed.length;
    if (same) {
      const refs = memo.refs;
      for (let i = 0; i < refs.length; i++) { if (refs[i] !== placed[i]) { same = false; break; } }
    }
    if (!same) {
      memo = { refs: placed.slice(), entries: new Map() };
      this._placeOneMemo.set(placed, memo);
    }
    const bb = PU.bbox(partPts);
    const key = thisPartId + '|' + thisVKey + '|' + gap + '|' + sheetW + '|' + sheetH + '|' +
      partPts.length + '|' + bb.minX + '|' + bb.minY + '|' + bb.maxX + '|' + bb.maxY;
    let hit = memo.entries.get(key);
    if (hit === undefined) {
      hit = this._placeOneUncached(partPts, placed, sheetW, sheetH, gap, thisPartId, thisVKey, nfpCache);
      memo.entries.set(key, hit);
    }
    if (hit === null) return null;
    return { candidates: hit.candidates.slice(), perPolyBL: hit.perPolyBL.slice() };
  },

  _placeOneUncached(partPts, placed, sheetW, sheetH, gap, thisPartId, thisVKey, nfpCache) {
    const ifp = NFP.computeIFP(sheetW, sheetH, partPts);
    if (!ifp) return null;

    if (placed.length === 0) {
      const p = { x: ifp[0][0], y: ifp[0][1] };
      return { candidates: [p], perPolyBL: [p] };
    }

    // For each placed part, look up or compute NFP(placedVariant, thisVariant).
    // Cache key uses SHAPE HASH (not partId) so that identical shapes with
    // different ids (e.g. 20 copies of one DXF) all share the same cached
    // NFP. This is the key optimization for "copies=N" scenarios — 20×
    // speedup for 20 copies.
    const nfpPolys = [];
    for (const p of placed) {
      let cacheEntry = null;
      // p.shapeHash set by placeBest callers; fall back to partId for safety
      const pHash = p.shapeHash || p.partId;
      if (nfpCache && thisVKey && p.variantKey) {
        const k = `${pHash}|${p.variantKey}||${thisPartId}|${thisVKey}|${gap}`;
        cacheEntry = nfpCache.get(k);
        if (!cacheEntry) {
          cacheEntry = NFP.computeWithGap(p.localPoly, partPts, gap);
          nfpCache.set(k, cacheEntry);
        }
      } else {
        cacheEntry = NFP.computeWithGap(p.localPoly || p.worldPoly, partPts, gap);
      }
      for (const nfp of cacheEntry.outer) {
        const tx = (p.nfpX !== undefined) ? p.nfpX : p.x;
        const ty = (p.nfpY !== undefined) ? p.nfpY : p.y;
        nfpPolys.push(PU.translate(nfp, tx, ty));
      }
    }

    const feasible = PU.difference([ifp], nfpPolys);
    if (!feasible.length) return null;

    // Collect ALL candidate positions — vertices + edge midpoints of every
    // feasible polygon. This is what lets us find cavity placements: the
    // feasible region has a complex shape (including "islands" inside
    // concave cavities of placed parts), and cavity-positions appear as
    // vertices of that shape. Returning the full list lets the caller
    // score by true compactness, not just bottom-left.
    // ALSO: for each feasible polygon, compute its BL point — this lets
    // the caller do per-polygon BL picking instead of one global BL,
    // which gives cavity regions a fair chance against outer regions.
    const candidates = [];
    const perPolyBL = [];
    const seen = new Set();
    const addPoint = (x, y) => {
      if (Math.abs(y) < 1e-6) y = 0;
      if (Math.abs(x) < 1e-6) x = 0;
      const k = `${Math.round(x*10)}|${Math.round(y*10)}`;
      if (seen.has(k)) return;
      seen.add(k);
      candidates.push({ x, y });
    };
    for (const poly of feasible) {
      let polyBL = null;
      const considerBL = (x, y) => {
        const pscore = y * 10 + x;
        if (polyBL === null || pscore < polyBL._p) polyBL = { x, y, _p: pscore };
      };
      for (const [x, y] of poly) {
        addPoint(x, y);
        considerBL(x, y);
      }
      for (let i = 0; i < poly.length; i++) {
        const j = (i + 1) % poly.length;
        const mx = (poly[i][0] + poly[j][0]) * 0.5;
        const my = (poly[i][1] + poly[j][1]) * 0.5;
        addPoint(mx, my);
        considerBL(mx, my);
      }
      if (polyBL) perPolyBL.push({ x: polyBL.x, y: polyBL.y });
    }
    return { candidates, perPolyBL };
  },

  getMirrors(m) {
    // Optional variants — engine TRIES with and without mirror, picks best
    return m === 'x' ? [null, 'x']
         : m === 'y' ? [null, 'y']
         : m === 'both' ? [null, 'x', 'y']
    // Compulsory variants — original is excluded; mirror is FORCED
         : m === 'x-must' ? ['x']
         : m === 'y-must' ? ['y']
         : m === 'both-must' ? ['x', 'y']
         : [null];
  },

  /* Same as raster engine's _getZoneCenters — merges FORE+FLANK pairs
     and returns [zoneId, cx, cy] triples for nearest-label classification. */
  _getZoneCenters(labels) {
    const centers = [];
    const used = new Set();
    for (let i = 0; i < labels.length; i++) {
      if (used.has(i)) continue;
      const L = labels[i];
      const t = L.text.toUpperCase().trim();
      if (t === 'BUTT')     centers.push(['butt', L.x, L.y]);
      else if (t === 'SHOULDER') centers.push(['shoulder', L.x, L.y]);
      else if (t === 'NECK')     centers.push(['neck', L.x, L.y]);
      else if (t === 'BELLY')    centers.push(['belly', L.x, L.y]);
      else if (t === 'FORE' || t === 'HIND') {
        let bestJ = -1, bestD2 = Infinity;
        for (let j = 0; j < labels.length; j++) {
          if (j === i || used.has(j)) continue;
          if (labels[j].text.toUpperCase().trim() !== 'FLANK') continue;
          const dx = labels[j].x - L.x, dy = labels[j].y - L.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < bestD2) { bestD2 = d2; bestJ = j; }
        }
        if (bestJ >= 0) used.add(bestJ);
        const zoneId = (t === 'FORE') ? 'fore_flank' : 'hind_flank';
        const cx = (L.x + (bestJ >= 0 ? labels[bestJ].x : L.x)) / 2;
        const cy = (L.y + (bestJ >= 0 ? labels[bestJ].y : L.y)) / 2;
        centers.push([zoneId, cx, cy]);
      }
      used.add(i);
    }
    return centers;
  },

  /* ─────────────────────────────────────────────────────────────────────
     SKYLINE FLOW PLACEMENT (polygon-precision version of raster's skyline)

     Core idea: maintain a per-mm skyline array — one Y value per column
     across the sheet width. For each placement:

       candY = max over dx of (skyline[x+dx] - partBottomAtDx(dx))

     This is the classic raster skyline formula, computed at polygon
     precision. The key advantage over flat-row placement: parts naturally
     interlock into concave dead space because skyline tracks the actual
     upper contour of placed parts, not a flat row baseline.

     For each variant we pre-compute `bottomContour[dx]` = the Y of the
     polygon's LOWEST edge at column offset dx. Similarly `topContour[dx]`
     for updating the skyline after placement.
     ───────────────────────────────────────────────────────────────────── */

  /* Sample a polygon's top and bottom edge at each integer X offset.
     Returns { bot: Float64Array, top: Float64Array, w: int } where
     bot[dx] = minimum Y (distance from polygon's own bbox.minY) that
               the polygon occupies at X offset dx from its bbox.minX
     top[dx] = maximum Y at that offset
     Used to compute skyline interactions.                                */
  sampleContours(poly) {
    const bb = PU.bbox(poly);
    const w = Math.ceil(bb.w) + 1;
    const bot = new Float64Array(w).fill(Infinity);
    const top = new Float64Array(w).fill(-Infinity);

    // For each edge (p1, p2), sample integer x positions it crosses and
    // record y values. Bot/top are in part-local coords (ref = bbox.min).
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const x1 = poly[i][0] - bb.minX, y1 = poly[i][1] - bb.minY;
      const x2 = poly[j][0] - bb.minX, y2 = poly[j][1] - bb.minY;
      const xmin = Math.min(x1, x2), xmax = Math.max(x1, x2);
      const ixmin = Math.max(0, Math.floor(xmin));
      const ixmax = Math.min(w - 1, Math.ceil(xmax));
      for (let x = ixmin; x <= ixmax; x++) {
        let y;
        if (Math.abs(x2 - x1) < 1e-9) {
          // Vertical edge — hits all Y from min(y1,y2) to max(y1,y2)
          const ymin = Math.min(y1, y2), ymax = Math.max(y1, y2);
          if (ymin < bot[x]) bot[x] = ymin;
          if (ymax > top[x]) top[x] = ymax;
          continue;
        }
        const t = (x - x1) / (x2 - x1);
        if (t < 0 || t > 1) continue;
        y = y1 + t * (y2 - y1);
        if (y < bot[x]) bot[x] = y;
        if (y > top[x]) top[x] = y;
      }
    }

    // Fill in columns that weren't hit (shouldn't happen often) — use
    // the polygon's interior by scanline. For simplicity, just propagate
    // from neighbors.
    for (let x = 0; x < w; x++) {
      if (!isFinite(bot[x])) {
        // Search neighbors
        for (let d = 1; d < w; d++) {
          if (x - d >= 0 && isFinite(bot[x-d])) { bot[x] = bot[x-d]; break; }
          if (x + d < w && isFinite(bot[x+d])) { bot[x] = bot[x+d]; break; }
        }
        if (!isFinite(bot[x])) bot[x] = 0;
      }
      if (!isFinite(top[x])) {
        for (let d = 1; d < w; d++) {
          if (x - d >= 0 && isFinite(top[x-d])) { top[x] = top[x-d]; break; }
          if (x + d < w && isFinite(top[x+d])) { top[x] = top[x+d]; break; }
        }
        if (!isFinite(top[x])) top[x] = bb.h;
      }
    }

    return { bot, top, w, bboxW: bb.w, bboxH: bb.h };
  },

  /* Find placement Y for a part whose bottom contour is `bot` at X offset x.
     skyline[x..x+w-1] = current floor (min Y the part must clear).
     Returns the minimum Y where part fits, or -1 if out of sheet bounds.  */
  skyFit(bot, skyline, x, contourW, sheetH, partH) {
    let minY = 0;
    const endX = x + contourW;
    if (endX > skyline.length) return -1;
    for (let dx = 0; dx < contourW; dx++) {
      // Part's bottom at column (x+dx) must be >= skyline[x+dx]
      // part's Y at column dx + partY = skyline[x+dx] → partY = skyline[x+dx] - bot[dx]
      const needed = skyline[x + dx] - bot[dx];
      if (needed > minY) minY = needed;
    }
    if (minY + partH > sheetH + 1e-6) return -1;
    return minY;
  },

  /* Update skyline after placing a part at (x, y) with top contour `top`.
     For each column covered, raise skyline[col] to y + top[dx] + gap.
     Gap is added so next placement starts at gap+1mm above the part edge. */
  skyBump(skyline, top, x, y, contourW, gap) {
    for (let dx = 0; dx < contourW; dx++) {
      const col = x + dx;
      if (col < 0 || col >= skyline.length) continue;
      const newVal = y + top[dx] + gap;
      if (newVal > skyline[col]) skyline[col] = newVal;
    }
  },

  /* Row-strict placement: Y fixed at rowY, scan X from minX rightward.
     Returns leftmost position where part fits on the skyline at y ≈ rowY.
     Used for PHASE 1 of flowNest (ordered rows).

     "Fits at rowY" means: skyline-fit Y must be ≤ rowY. If skyline has concave
     space below rowY at this X (e.g. from a shorter part placed here earlier),
     the actual placement Y can be < rowY — part slots down naturally.       */
  placeInRowStrict(variantsWithContours, skyline, sheetW, sheetH, rowY, minX, okAt) {
    let best = null;
    const STEP = 1;

    for (let vi = 0; vi < variantsWithContours.length; vi++) {
      const v = variantsWithContours[vi];
      const { bot, w: contourW, bboxH, bboxW } = v.contours;
      const xMax = sheetW - bboxW;
      if (minX > xMax + 1e-6) continue;
      if (rowY + bboxH > sheetH + 1e-6) continue;
      // On a hide (okAt given) a row is a band: where the hide's edge
      // curves away, a part may sit lower than the baseline, up to three
      // quarters of its height, so the rows follow the hide instead of
      // stopping at its first dip.
      const yMax = rowY + (okAt ? bboxH * 0.75 : 0);

      let foundX = -1, foundY = -1;
      for (let x = Math.max(0, Math.floor(minX)); x <= Math.ceil(xMax); x += STEP) {
        let y = this.skyFit(bot, skyline, x, contourW, sheetH, bboxH);
        if (y < 0) continue;
        // Must fit AT or BELOW row baseline
        if (y > rowY + 1e-6) continue;
        if (okAt) {
          // Drop until the whole part is on the hide and off the defects
          while (y <= yMax + 1e-6 && y + bboxH <= sheetH + 1e-6 && !okAt(v, x, y)) y += 2;
          if (y > yMax + 1e-6 || y + bboxH > sheetH + 1e-6) continue;
        }
        foundX = x; foundY = y;
        break;
      }

      if (foundX >= 0) {
        const cost = foundX * 100 + vi;  // leftmost X wins
        if (best === null || cost < best.cost) {
          best = { x: foundX, y: foundY, vi, cost };
        }
      }
    }
    return best;
  },

  /* Skyline-based placement that scans the ENTIRE sheet for the lowest valid Y.
     Returns leftmost-X-at-min-Y placement.

     Unlike row-constrained placement, this finds the globally-best BL position
     using the skyline. The row alternation for flow mode is handled by the
     caller choosing which variants (rotA vs rotB) to pass in. This allows parts
     to naturally fill concave dead space between parts of the previous row.  */
  placeSky(variantsWithContours, skyline, sheetW, sheetH, okAt) {
    let best = null;
    const STEP = 1;

    for (let vi = 0; vi < variantsWithContours.length; vi++) {
      const v = variantsWithContours[vi];
      const { bot, w: contourW, bboxH, bboxW } = v.contours;
      const xMax = sheetW - bboxW;
      if (xMax < 0) continue;

      let variantBestY = Infinity, variantBestX = -1;
      for (let x = 0; x <= Math.ceil(xMax); x += STEP) {
        let y = this.skyFit(bot, skyline, x, contourW, sheetH, bboxH);
        if (y < 0) continue;
        if (okAt) {
          // Hide: drop a little way looking for a spot on the hide
          const yStop = y + 40;
          while (y <= yStop && y + bboxH <= sheetH + 1e-6 && !okAt(v, x, y)) y += 2;
          if (y > yStop || y + bboxH > sheetH + 1e-6) continue;
        }
        // Prefer min Y; tie-break by min X
        if (y < variantBestY - 1e-6) {
          variantBestY = y;
          variantBestX = x;
        }
      }

      if (variantBestX >= 0) {
        // Among variants, prefer min Y; tie-break by min X; tie-break by vi order
        const cost = variantBestY * 1e6 + variantBestX * 10 + vi;
        if (best === null || cost < best.cost) {
          best = { x: variantBestX, y: variantBestY, vi, cost };
        }
      }
    }
    return best;
  },

  /* ─────────────────────────────────────────────────────────────────────
     CUTTING-FLOW NESTING — two-phase algorithm.

     PHASE 1 (ORDERED ROWS): Strict left-to-right row cursor at flat Y
     baselines. Parts placed in cut sequence: row 1 (left→right),
     row 2 (left→right), etc. Rotations alternate per position for
     brick-wall interlocking. This is what the cutting blade will follow.

     PHASE 2 (DEAD-SPACE FILL): After rows are complete, one final pass
     of global skyline BL-fill squeezes extra parts into any remaining
     dead space. These extras are appended AFTER the row-ordered parts
     in the placements array, so the cutter finishes the main grid first,
     then does a cleanup sweep for the extras.
     ───────────────────────────────────────────────────────────────────── */
  // Multi-strategy public flowNest — try multiple lane configs, pick best.
  // The 16-layout Cutting Flow search is shared with the other engine and
  // runs its layouts in parallel. See src/nesting/flow-strategies.js.
  async flowNest(partDefs, settings, onProgress, isCancelled, onPlacement) {
    return FlowStrategies.run(this, partDefs, settings, onProgress, isCancelled, onPlacement);
  },

  async _flowNestSingle(partDefs, settings, onProgress, isCancelled, onPlacement) {
    const _emit = onPlacement || (() => {});
    const { sheetW, sheetH, margin, gap, mirrorMode,
            copies, fillSheet, flowDir } = settings;

    const usW = sheetW - 2 * margin, usH = sheetH - 2 * margin;
    // Use caller-provided rotation pair if specified (multi-strategy
    // dispatcher uses this to try many angles). Otherwise fall back to
    // the default flowDir-based pair.
    let rotA, rotB;
    if (settings._flowRotA !== undefined && settings._flowRotB !== undefined) {
      rotA = settings._flowRotA;
      rotB = settings._flowRotB;
    } else {
      [rotA, rotB] = flowDir === 'vertical' ? [90, 270] : [0, 180];
    }
    if (settings._flowSwapAB) { const t = rotA; rotA = rotB; rotB = t; }
    const mirrors = this.getMirrors(mirrorMode);

    onProgress(0, `Flow NFP (2-phase) — sheet ${usW}×${usH}mm`);
    await sleep(0);

    const attachContours = (variants) => variants.map(v => ({
      ...v,
      contours: this.sampleContours(v.pts)
    }));
    const vcA = new Map(), vcB = new Map();
    for (const p of partDefs) {
      vcA.set(p.id, attachContours(this.buildVariants(p.pts, [rotA], mirrors)));
      vcB.set(p.id, attachContours(this.buildVariants(p.pts, [rotB], mirrors)));
    }

    const totalPartArea = partDefs.reduce((s, p) => s + PU.area(p.pts), 0) || 1;
    // Budget per part, not per sheet: "3 copies" is 3 of EACH part. The
    // total used to be handed to every part as its own limit, so one part
    // could take the whole budget (13 of one, 0 of another). Auto-expand
    // caps each part at the requested copies too.
    const perPart = settings._autoExpandQueueCap || copies;
    const fillTotal = Math.min(8000, Math.ceil(usW * usH / totalPartArea) + 50);
    let maxTotal = settings._autoExpandQueueCap
      ? settings._autoExpandQueueCap * partDefs.length
      : (fillSheet ? fillTotal : copies * partDefs.length);

    const placed = [];
    let placedCount = 0;
    const t0 = performance.now();
    let lastYield = t0;

    // Fill mode with several parts: the requested copies of every part are
    // placed first as complete sets (each part capped at `copies`), then
    // the caps are lifted and the leftover space is topped up with extras.
    const setsFirst = fillSheet && !settings._autoExpandQueueCap && copies >= 1 && partDefs.length >= 2;
    const copiesLeft = new Map(partDefs.map(p => [p.id, (fillSheet && !setsFirst) ? maxTotal : perPart]));
    // Multi-sheet overflow (FlowStrategies.run): this sheet gets what is
    // still wanted of each part after the sheets before it.
    if (settings._remainingById) {
      maxTotal = 0;
      for (const p of partDefs) { const n = settings._remainingById[p.id] | 0; copiesLeft.set(p.id, n); maxTotal += n; }
    }
    let capsLifted = !setsFirst;
    // Sets first: cycle the parts biggest first, so a large part is not
    // squeezed out of every row by the small ones that come before it in
    // the import order. Plain copies keep the import order (cut sequence).
    const cycle = setsFirst
      ? partDefs.slice().sort((a, b) => PU.area(b.pts) - PU.area(a.pts) || (String(a.id) < String(b.id) ? -1 : 1))
      : partDefs;
    const liftCaps = () => {
      if (capsLifted) return false;
      capsLifted = true;
      for (const p of partDefs) copiesLeft.set(p.id, maxTotal);
      return true;
    };
    const allCapsReached = () => {
      for (const v of copiesLeft.values()) if (v > 0) return false;
      return true;
    };

    const skyW = Math.ceil(usW) + 2;
    const skyline = new Float64Array(skyW);

    // ── Hide outline and defects ─────────────────────────────────────
    // The lane placer is skyline-only; it knew nothing about a hide, so
    // Cutting Flow on leather could put parts off the hide and on defects
    // (the raster flow always had its obstacle mask). Now: a 1 mm mask of
    // forbidden cells (outside the outline, on a defect) built by the same
    // code the raster engine uses, sampled along each part's outline at
    // every candidate, and the exact polygon tests confirm the spot found.
    let okAt = null;
    const hasHide = !!(settings.sheetOutline && settings.sheetOutline.length >= 3);
    const hasDefects = !!(settings.defects && settings.defects.length);
    if ((hasHide || hasDefects) && typeof NestEngineRaster !== 'undefined') {
      const MW = Math.ceil(usW) + 1, MH = Math.ceil(usH) + 1;
      const mask = NestEngineRaster._buildObstacleMask(settings, MW, MH, 1);
      // Defects grown by 1 mm for the exact test: the variant outline is the
      // cleaned polygon, which can sit a fraction of a millimetre inside the
      // raw one, so a bare test could leave the cut edge on a defect.
      const defectsGrown = hasDefects ? settings.defects.map(d => (d.shape && d.shape.length >= 3)
        ? { ...d, r: (d.r || 0) + 1, shape: PU.offsetSingle(d.shape, 1, 'square') || d.shape }
        : { ...d, r: (d.r || 0) + 1 }) : null;
      // Outline sample points per variant: every vertex plus a point every
      // 4 mm along each edge, relative to the variant's origin.
      const samplesOf = (v) => {
        if (v._hideSamples) return v._hideSamples;
        const out = [];
        const pts = v.pts;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.max(1, Math.ceil(len / 4));
          for (let k = 0; k < n; k++) {
            const t = k / n;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          }
        }
        v._hideSamples = out;
        return out;
      };
      okAt = (v, x, y) => {
        if (mask) {
          for (const [sx, sy] of samplesOf(v)) {
            const gx = Math.floor(sx + x), gy = Math.floor(sy + y);
            if (gx < 0 || gy < 0 || gx >= MW || gy >= MH || mask[gy * MW + gx]) return false;
          }
        }
        const world = PU.translate(v.pts, x, y);
        if (hasHide && !LeatherSheet.insideSheet(world, settings.sheetOutline)) return false;
        if (hasDefects && LeatherSheet.overlapsDefects(world, defectsGrown)) return false;
        return true;
      };
    }

    // Helper to commit a placement (used by both phases)
    const commitPlacement = (pl, variants, part) => {
      const v = variants[pl.vi];
      this.skyBump(skyline, v.contours.top, pl.x, pl.y, v.contours.w, gap);
      const worldPoly = PU.translate(v.pts, pl.x, pl.y);
      let rPts = v.mirror ? PU.mirror(part.pts, v.mirror) : part.pts;
      rPts = PU.rotate(rPts, v.rotation);
      const innerLines = (part.innerLines || []).map(il => {
        let lp = v.mirror ? PU.mirror(il.pts, v.mirror) : il.pts;
        return { pts: PU.rotate(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
      });
      const placement = {
        partId: part.id, partName: part.name, color: part.color,
        pts: rPts, worldPoly,
        localPoly: v.pts, variantKey: v.key,
        x: margin + pl.x, y: margin + pl.y,
        nfpX: pl.x, nfpY: pl.y,
        rotation: v.rotation, mirror: v.mirror, sheet: 0, innerLines
      };
      placed.push(placement);
      try { _emit({ placement, totalPlaced: placed.length, sheetIdx: 0 }); } catch(_){}
      copiesLeft.set(part.id, (copiesLeft.get(part.id) || 0) - 1);
      placedCount++;
      if (setsFirst && !capsLifted && allCapsReached()) liftCaps();
    };

    // Lane sequence (FlowStrategies tries every combination for the chosen
    // direction and keeps the fullest layout):
    //   _flowSeq      which rotation goes where. 'alt-flip' = A B A B / B A B A
    //                 (the original), 'alt' = A B A B in every row, 'rows' =
    //                 rows of A then rows of B, 'rows-flip', 'same-A', 'same-B',
    //                 'tight' = both tried at every place, the leftmost wins.
    //   _flowAdvance  'full' = the next part starts past the previous bbox
    //                 (the original); 'half' = half a part back, so it can tuck
    //                 into the previous part's cavity (the skyline keeps it
    //                 collision-free and the row rule keeps it in the row).
    //   _flowOffset   0.5 = odd rows start half a part in (brick pattern).
    const flowSeq = settings._flowSeq || 'alt-flip';
    const halfAdvance = settings._flowAdvance === 'half';
    const rowOffset = settings._flowOffset || 0;
    const rotFor = (rowNum, posInRow) => {
      switch (flowSeq) {
        case 'alt':       return posInRow % 2 === 0 ? 'A' : 'B';
        case 'rows':      return rowNum % 2 === 0 ? 'A' : 'B';
        case 'rows-flip': return rowNum % 2 === 0 ? 'B' : 'A';
        case 'same-A':    return 'A';
        case 'same-B':    return 'B';
        case 'tight':     return 'AB';
        default:          return (rowNum + posInRow) % 2 === 0 ? 'A' : 'B';
      }
    };
    const firstVar = vcA.get(cycle[0].id)[0];
    const offsetX = rowOffset ? Math.round(rowOffset * firstVar.bbox.w) : 0;

    // ────── PHASE 1: ORDERED ROW FILL ──────
    let rowY = 0;
    let rowNum = 0;

    phase1: while (placedCount < maxTotal) {
      if (isCancelled && isCancelled()) break;

      let curX = (rowNum % 2 === 1) ? offsetX : 0, posInRow = 0, rowPlaced = 0;
      let rowMaxBottomY = rowY;  // track the lowest point of parts in this row

      while (placedCount < maxTotal) {
        if (isCancelled && isCancelled()) break phase1;

        const now = performance.now();
        if (now - lastYield > 40) {
          onProgress(Math.min(0.4, placedCount / maxTotal),
            `Phase 1 — Row ${rowNum+1}, placed ${placedCount}`);
          await sleep(0);
          lastYield = performance.now();
        }

        const which = rotFor(rowNum, posInRow);
        const partIdx = posInRow % partDefs.length;
        const part = cycle[partIdx];

        if ((copiesLeft.get(part.id) || 0) <= 0) {
          posInRow++;
          if (posInRow > partDefs.length * 2) break;  // no parts left
          continue;
        }

        let variants, pl;
        if (which === 'AB') {
          const va = vcA.get(part.id), vb = vcB.get(part.id);
          const pa = this.placeInRowStrict(va, skyline, usW, usH, rowY, curX, okAt);
          const pb = this.placeInRowStrict(vb, skyline, usW, usH, rowY, curX, okAt);
          if (pa && (!pb || pa.x <= pb.x)) { variants = va; pl = pa; } else { variants = vb; pl = pb; }
        } else {
          variants = (which === 'A' ? vcA : vcB).get(part.id);
          pl = this.placeInRowStrict(variants, skyline, usW, usH, rowY, curX, okAt);
        }

        if (pl === null) {
          // This rotation/part didn't fit at current cursor — try next
          posInRow++;
          if (posInRow > partDefs.length * 2) break;  // row is full
          continue;
        }

        commitPlacement(pl, variants, part);
        const v = variants[pl.vi];
        curX = pl.x + (halfAdvance ? Math.max(1, Math.floor(v.bbox.w * 0.5)) : v.bbox.w);
        const placedTop = pl.y + v.bbox.h;
        if (placedTop > rowMaxBottomY) rowMaxBottomY = placedTop;

        posInRow++;
        rowPlaced++;
      }

      if (rowPlaced === 0) break;  // current row couldn't fit anything → done

      // Advance to next row: baseline = highest top reached in this row + gap
      rowY = rowMaxBottomY + gap;
      if (rowY >= usH) break;
      rowNum++;
    }

    const phase1Count = placedCount;

    // ────── PHASE 2: DEAD-SPACE FILL ──────
    // Use global skyline BL to squeeze any remaining parts into gaps.
    // These are appended at the END of the placements array so they come
    // after all the ordered row parts in cutting sequence.
    let phase2Step = 0;
    let phase2FailStreak = 0;
    const MAX_PHASE2_FAILS = partDefs.length * 2;

    while (placedCount < maxTotal) {
      if (phase2FailStreak >= MAX_PHASE2_FAILS) {
        // Sets-first: the dead-space pass ran with the per-part caps on;
        // now lift them and let extras use what is left.
        if (!liftCaps()) break;
        phase2FailStreak = 0;
      }
      if (isCancelled && isCancelled()) break;

      const now = performance.now();
      if (now - lastYield > 40) {
        onProgress(Math.min(0.99, 0.4 + (placedCount - phase1Count) / Math.max(1, maxTotal - phase1Count) * 0.6),
          `Phase 2 — filling dead space, placed ${placedCount}`);
        await sleep(0);
        lastYield = performance.now();
      }

      const useA = phase2Step % 2 === 0;
      const partIdx = Math.floor(phase2Step / 2) % partDefs.length;
      const part = cycle[partIdx];

      if ((copiesLeft.get(part.id) || 0) <= 0) {
        phase2Step++;
        phase2FailStreak++;
        continue;
      }

      const variants = (useA ? vcA : vcB).get(part.id);
      const pl = this.placeSky(variants, skyline, usW, usH, okAt);

      if (pl === null) {
        phase2Step++;
        phase2FailStreak++;
        continue;
      }

      commitPlacement(pl, variants, part);
      phase2Step++;
      phase2FailStreak = 0;
    }

    const sheets = [{ idx: 0, placements: placed }];
    const out = {
      placements: placed, sheets, placed: placedCount,
      unplaced: Math.max(0, maxTotal - placedCount),
      sheetCount: 1, usableW: usW, usableH: usH, effRes: 'polygon', cuttingFlow: true
    };
    if (fillSheet && !setsFirst && !settings._autoExpandQueueCap) out.unplaced = 0;   // the sheet is full, nothing is missing
    if (setsFirst) {
      const byId = new Map(partDefs.map(p => [p.id, 0]));
      for (const pl of placed) byId.set(pl.partId, (byId.get(pl.partId) || 0) + 1);
      const complete = Math.min(...byId.values());
      out.sets = { requested: copies, complete, partsPerSet: partDefs.length,
        perPart: partDefs.map(p => ({ id: p.id, name: p.name + (p._mustPairTag === 'mir' ? ' (mirrored)' : ''), placed: byId.get(p.id) })) };
      out.unplaced = Math.max(0, copies * partDefs.length - [...byId.values()].reduce((a, n) => a + Math.min(n, copies), 0));
    }
    return out;
  },
};



/* ═══════════════════════════════════════════════════════════════════════════
   ENGINE SELECTION
   Default: polygon NFP (PolyNestEngine)
   Fallback: raster skyline (NestEngineRaster) — kept for comparison
   Toggle at runtime: window.__useRasterEngine = true
══════════════════════════════════════════════════════════════════════════════ */

