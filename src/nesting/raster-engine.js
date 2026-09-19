/*
 * NestForge Pro — Raster Engine (NestEngineRaster) — fast skyline bottom-left-fill, includes Clipper library
 *
 * Original location: lines 2138..10726 of nestforge-pro.html (8589 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const NestEngineRaster = {

  async nest(partDefs, settings, onProgress, isCancelled, onPlacement) {
    // onPlacement: optional callback called as each part is successfully
    // placed. Used for progressive rendering. Called as:
    //   onPlacement({ placement: <placed-obj>, totalPlaced: N, queueSize: M })
    // Safe to pass null — engine simply skips notification.
    const _emit = onPlacement || (() => {});
    const { sheetW, sheetH, margin, gap, rotations, sortBy,
            resolution, mirrorMode, copies, fillSheet, multiSheet } = settings;

    const usW = sheetW - 2*margin, usH = sheetH - 2*margin;

    // ── Auto-cap resolution to keep grid ≤ 1.5M cells ────────────
    // resolution = cells/mm internally (e.g. res=2 → 0.5mm/cell).
    // For large sheets (3600×3800mm at res=2 → 54M cells → 247ms/part!),
    // auto-REDUCE effRes so total cells never exceed 1.5M.
    // Formula: GW×GH = usW×effRes × usH×effRes = usW×usH×effRes²
    // Cap: effRes ≤ sqrt(MAX_CELLS / (usW×usH))
    // Cap grid at 12M cells for performance.
    // At 12M, skyline-based scan takes ~1ms/placement even for 3600×3800mm sheets.
    // Keeping resolution high enough for accurate gap enforcement:
    //   3600×3800 at cap: effRes≈0.94 → gapCell=2 → 2.1mm gap accuracy (was 3mm at 1.5M cap)
    //   1200×600  at res=2: 2.8M < 12M → no reduction, full 0.5mm/cell accuracy
    const MAX_GRID_CELLS = 12_000_000;
    const resLimit = Math.sqrt(MAX_GRID_CELLS / (usW * usH));
    // Minimum 0.5 cells/mm (2mm/cell) to keep gap legible
    const effRes = resLimit < resolution ? Math.max(0.5, resLimit) : resolution;
    const wasReduced = effRes < resolution - 0.01;

    const GW  = Math.ceil(usW * effRes), GH = Math.ceil(usH * effRes);
    const gapC = Math.ceil(gap * effRes);
    const mirrors = this.getMirrors(mirrorMode);

    // ── Pre-compute obstacle mask for leather sheets ────────────────
    // If sheet is non-rectangular (hide) or has defects, build a mask of
    // cells that are FORBIDDEN for placement. Applied to every new grid
    // at start of runPass(), so canPlace() rejects those cells naturally.
    const _obstacleMask = this._buildObstacleMask(settings, GW, GH, effRes);

    onProgress(0, wasReduced
      ? `Auto-scaled res: ${(1/effRes).toFixed(1)}mm/cell  Grid: ${GW}×${GH}`
      : `Grid: ${GW}×${GH} cells`);
    await sleep(0);

    // ── Pre-rasterize variants (once per unique shape) ───────────
    const vc = new Map();
    for (const p of partDefs) {
      // Per-component override: part-level _rotations / _mirrorMode win.
      const pRots = p._rotations || rotations;
      const pMirrors = p._mirrorMode ? this.getMirrors(p._mirrorMode) : mirrors;
      vc.set(p.id, this.buildVariants(p.pts, pRots, pMirrors, effRes, gapC));
    }

    // ── Pre-compute per-component zone permission masks ──────────────
    // Cache: same allowedZones set → same mask. Uses a signature key.
    // Optimization: zones are coarse features, so classify on a small
    // Voronoi grid (~96×96) and upsample to full grid.
    // The mask object also stores bbox to accelerate place() scan.
    const zoneMaskByPart = new Map();
    // ── Hoisted for Phase 3 access ──
    // These need to be visible from runPass so Phase 3 can build a relaxed
    // zone mask after the main pass identifies which zones are released.
    let _zoneCentersGlob = null, _coarseZoneGlob = null;
    let _cGWGlob = 0, _cGHGlob = 0;
    let _reservedZonesGlob = new Set();
    let _zoneIdsGlob = [];
    let _maskCacheGlob = null;
    if (settings.sheetLabels && settings.sheetLabels.length && settings.componentRules) {
      const zoneCenters = this._getZoneCenters(settings.sheetLabels);
      const maskCache = new Map();

      // Build a coarse zone-id grid once (shared across all allowedZones sets)
      const COARSE = 96;
      const cGW = COARSE, cGH = COARSE;
      const coarseZone = new Int8Array(cGW * cGH);
      const zoneIds = zoneCenters.map(c => c[0]);
      const sheetWmm = GW / effRes, sheetHmm = GH / effRes;
      for (let cy = 0; cy < cGH; cy++) {
        const ymm = ((cy + 0.5) / cGH) * sheetHmm;
        for (let cx = 0; cx < cGW; cx++) {
          const xmm = ((cx + 0.5) / cGW) * sheetWmm;
          let nearest = -1, nd2 = Infinity;
          for (let z = 0; z < zoneCenters.length; z++) {
            const c = zoneCenters[z];
            const dx = xmm - c[1], dy = ymm - c[2];
            const d2 = dx*dx + dy*dy;
            if (d2 < nd2) { nd2 = d2; nearest = z; }
          }
          coarseZone[cy * cGW + cx] = nearest;
        }
      }

      // Compute the set of zones that are "reserved" (restricted to some
      // specific component). Unrestricted parts in the main pass will avoid
      // these zones, leaving space for the restricted component.
      const reservedZones = new Set();
      for (const rule of settings.componentRules.values()) {
        if (rule && rule.allowedZones && rule.allowedZones.size) {
          for (const z of rule.allowedZones) reservedZones.add(z);
        }
      }

      // Expose to outer scope for Phase 3
      _zoneCentersGlob = zoneCenters;
      _coarseZoneGlob = coarseZone;
      _cGWGlob = cGW; _cGHGlob = cGH;
      _reservedZonesGlob = reservedZones;
      _zoneIdsGlob = zoneIds;
      _maskCacheGlob = maskCache;

      for (const p of partDefs) {
        const compKey = p._componentKey;
        if (!compKey) continue;
        const rule = settings.componentRules.get(compKey);

        // Determine the effective allowedZones for this part:
        //   - If part has explicit allowedZones → use them (restricted mode)
        //   - Else if there are reservedZones → part is allowed in
        //     all non-reserved zones only (unrestricted-avoid mode)
        //   - Else → no mask needed
        let effectiveAllowed = null;
        if (rule && rule.allowedZones && rule.allowedZones.size) {
          effectiveAllowed = rule.allowedZones;
        } else if (reservedZones.size > 0) {
          // Build "all zones except reserved"
          effectiveAllowed = new Set();
          for (const z of zoneIds) {
            if (!reservedZones.has(z)) effectiveAllowed.add(z);
          }
          if (!effectiveAllowed.size) continue;  // all zones reserved, no restriction
        } else {
          continue;
        }

        const sig = Array.from(effectiveAllowed).sort().join(',');
        let cached = maskCache.get(sig);
        if (!cached) {
          const forbidByZone = new Uint8Array(zoneCenters.length);
          for (let z = 0; z < zoneCenters.length; z++) {
            forbidByZone[z] = effectiveAllowed.has(zoneIds[z]) ? 0 : 1;
          }
          const mask = new Uint8Array(GW * GH);
          let minX = GW, maxX = -1, minY = GH, maxY = -1;
          for (let gy = 0; gy < GH; gy++) {
            const cy = Math.min(cGH - 1, Math.floor(gy * cGH / GH));
            const coarseRow = cy * cGW;
            const fullRow = gy * GW;
            for (let gx = 0; gx < GW; gx++) {
              const cx = Math.min(cGW - 1, Math.floor(gx * cGW / GW));
              const zIdx = coarseZone[coarseRow + cx];
              if (zIdx < 0 || forbidByZone[zIdx]) {
                mask[fullRow + gx] = 1;
              } else {
                if (gx < minX) minX = gx;
                if (gx > maxX) maxX = gx;
                if (gy < minY) minY = gy;
                if (gy > maxY) maxY = gy;
              }
            }
          }
          cached = { mask, bbox: { minX, maxX, minY, maxY } };
          maskCache.set(sig, cached);
        }
        zoneMaskByPart.set(p.id, cached);
      }
    }

    // ── Build placement queue ────────────────────────────────────
    // See poly-engine for full explanation. Same heuristic applies here:
    // if user has ≥5 distinct components, copies=1, and multiSheet is on,
    // they want overflow not saturation — don't inflate the queue.
    let maxPerPart;
    const distinctComponents = partDefs.length;
    const userWantsOverflow = (multiSheet && copies === 1 && distinctComponents >= 5);
    if (fillSheet && !userWantsOverflow) {
      const totalPartArea = partDefs.reduce((s,p) => s + polyArea(p.pts), 0) || 1;
      maxPerPart = Math.min(5000, Math.ceil((usW * usH) / totalPartArea) + 30);
    } else {
      maxPerPart = copies;
    }

    // ── Set-mode detection ───────────────────────────────────────
    // If any component rule has setCount > 0, we're in "set mode":
    //   Build an interleaved queue (1 vamp, 2 quarters, 1 tng, repeat...)
    //   so the engine naturally completes sets before extras.
    // Multiple sizes of same component (e.g., vamp_1..vamp_9) all share
    // the same componentKey and setCount.
    const setCounts = new Map();  // componentKey → setCount
    if (settings.componentRules) {
      for (const [key, rule] of settings.componentRules) {
        if (rule && rule.setCount > 0) setCounts.set(key, rule.setCount);
      }
    }
    // Copies = complete sets (see poly-engine for the full note): with several
    // parts, "3 copies" is 3 of each; on a filled or fixed sheet the queue is
    // built set by set, extras (Fill mode) after the last set.
    const derivedSets = setCounts.size === 0 && copies >= 1 && partDefs.length >= 2
                        && (fillSheet || multiSheet) && !settings._autoExpandQueueCap
                        && settings.setsFirst !== false;
    const setMode = setCounts.size > 0 || derivedSets;
    const nSetsWanted = derivedSets ? copies : 0;
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

    const baseQueue = [];
    let _uid = 0;
    if (derivedSets) {
      const compKeyOf = (p) => p._componentKey || String(p.id);
      const compArea = new Map();
      for (const p of partDefs) {
        const k = compKeyOf(p), a = polyArea(p.pts);
        if (!compArea.has(k) || compArea.get(k) < a) compArea.set(k, a);
      }
      const setOrder = partDefs.slice().sort((a, b) => {
        const ka = compKeyOf(a), kb = compKeyOf(b);
        if (ka !== kb) return (compArea.get(kb) - compArea.get(ka)) || (ka < kb ? -1 : 1);
        if (a._mustPairTag !== b._mustPairTag) return a._mustPairTag === 'orig' ? -1 : 1;
        return (polyArea(b.pts) - polyArea(a.pts)) || (String(a.id) < String(b.id) ? -1 : 1);
      });
      for (let s = 0; s < nSetsWanted; s++) {
        for (const p of setOrder) baseQueue.push({ ...p, _q: s, _uid: _uid++, _inSet: true, _setIdx: s });
      }
      if (fillSheet) {
        for (let s = nSetsWanted; s < maxPerPart; s++) {
          for (const p of setOrder) baseQueue.push({ ...p, _q: s, _uid: _uid++, _inSet: false, _exhaustFill: true });
        }
      }
    } else if (setMode) {
      // Group parts by componentKey (preserves size variants as separate items)
      const byKey = new Map();
      for (const p of partDefs) {
        const k = p._componentKey || p.id;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(p);
      }
      // ── Realistic nSets cap ──
      // Don't blindly queue hundreds of sets — compute max possible sets
      // based on ONE set's total area × overhead factor. This prevents
      // the engine from wasting time on parts that will clearly never fit.
      // For fillSheet mode we derive from sheet area.
      let nSets;
      if (fillSheet) {
        // Area of one complete set
        let setArea = 0;
        for (const [key, parts] of byKey) {
          const perSet = setCounts.get(key) || 0;
          if (perSet > 0) {
            setArea += polyArea(parts[0].pts) * perSet;
          }
        }
        if (setArea > 0) {
          // Cap at 1.5× the theoretical max (accounts for waste)
          nSets = Math.min(50, Math.ceil((usW * usH * 0.85) / setArea));
        } else {
          nSets = 10;
        }
      } else {
        nSets = maxPerPart;  // user asked for explicit number of sets
      }
      // Strategy-based sort
      const strat = settings._queueStrategy || 'restricted-area';
      const sortedKeys = Array.from(byKey.keys()).filter(k => setCounts.has(k))
        .sort((a, b) => {
          const ra = (settings.componentRules && settings.componentRules.get(a)) || {};
          const rb = (settings.componentRules && settings.componentRules.get(b)) || {};
          const aHasZone = ra.allowedZones && ra.allowedZones.size > 0;
          const bHasZone = rb.allowedZones && rb.allowedZones.size > 0;
          const aA = polyArea(byKey.get(a)[0].pts);
          const bA = polyArea(byKey.get(b)[0].pts);
          const aBB = polyBBox(byKey.get(a)[0].pts);
          const bBB = polyBBox(byKey.get(b)[0].pts);
          if (strat === 'area-desc') return bA - aA;
          if (strat === 'height-desc') return bBB.h - aBB.h;
          if (aHasZone && !bHasZone) return -1;
          if (!aHasZone && bHasZone) return 1;
          return bA - aA;
        });
      // ── ZONE-SATURATION QUEUE ──
      // Phase 1: Restricted-zone components saturate their zones first
      // Phase 2: Unrestricted components fill remaining space
      // This guarantees that restricted zones are used to maximum capacity
      // before unrestricted parts are allowed to consume any space.
      const SATURATION_FACTOR = 2.0;
      // Phase 1: restricted parts first
      for (const key of sortedKeys) {
        const rule = (settings.componentRules && settings.componentRules.get(key)) || {};
        const hasZone = rule.allowedZones && rule.allowedZones.size > 0;
        if (!hasZone) continue;
        const parts = byKey.get(key);
        const perSet = setCounts.get(key);
        const targetCopies = Math.ceil(nSets * perSet * SATURATION_FACTOR);
        for (let q = 0; q < targetCopies; q++) {
          const p = parts[q % parts.length];
          baseQueue.push({...p, _q: q, _uid: _uid++, _inSet: false, _phase: 1});
        }
      }
      // Phase 2: unrestricted parts fill remaining zones
      for (const key of sortedKeys) {
        const rule = (settings.componentRules && settings.componentRules.get(key)) || {};
        const hasZone = rule.allowedZones && rule.allowedZones.size > 0;
        if (hasZone) continue;
        const parts = byKey.get(key);
        const perSet = setCounts.get(key);
        const targetCopies = Math.ceil(nSets * perSet * SATURATION_FACTOR);
        for (let q = 0; q < targetCopies; q++) {
          const p = parts[q % parts.length];
          baseQueue.push({...p, _q: q, _uid: _uid++, _inSet: false, _phase: 2});
        }
      }
      // Non-set components (setCount=0 or no rule) go at the end as pure extras
      for (const [key, parts] of byKey) {
        if (setCounts.has(key)) continue;
        for (const p of parts) {
          const cap = Math.min(50, maxPerPart);
          for (let q = 0; q < cap; q++) {
            baseQueue.push({...p, _q: q, _uid: _uid++, _inSet: false});
          }
        }
      }
    } else {
      // Standard (non-set) queue
      for (const p of partDefs) {
        for (let q = 0; q < maxPerPart; q++) baseQueue.push({...p, _q:q, _uid: _uid++});
      }
    }

    // ── Try multiple orderings and keep the best result ──────────────────
    // The first-placed part anchors the whole layout, so the order matters
    // A LOT. We try several sorts and pick the result with the smallest
    // bounding box. For small queues (typical DXF case) this is cheap.
    const orderingFns = [
      (a,b) => polyArea(b.pts)-polyArea(a.pts),                  // area desc
      (a,b) => polyBBox(b.pts).h-polyBBox(a.pts).h,              // height desc
      (a,b) => polyBBox(b.pts).w-polyBBox(a.pts).w,              // width desc
      (a,b) => Math.max(polyBBox(b.pts).w, polyBBox(b.pts).h)
             - Math.max(polyBBox(a.pts).w, polyBBox(a.pts).h),   // longest-edge desc
    ];
    // Honor the user-selected sort as the first attempt
    if (sortBy === 'width')      orderingFns.unshift((a,b) => polyBBox(b.pts).w-polyBBox(a.pts).w);
    else if (sortBy === 'height') orderingFns.unshift((a,b) => polyBBox(b.pts).h-polyBBox(a.pts).h);
    else                         orderingFns.unshift((a,b) => polyArea(b.pts)-polyArea(a.pts));

    // Cap at 4 orderings for perf — usually enough to find a good layout.
    // In set mode, we MUST preserve the interleaved queue order so that
    // sets are completed in sequence. So we use identity (no-op) sort only.
    const setRank = (p) => p._inSet ? p._setIdx : 1e6 + (p._q || 0);
    const withSetPrimary = (sortFn) => (a, b) => {
      const ra = setRank(a), rb = setRank(b);
      if (ra !== rb) return ra - rb;
      return sortFn(a, b) || (a._uid - b._uid);
    };
    const orderings = derivedSets
      ? orderingFns.slice(0, 3).map(withSetPrimary)
      : setMode
        ? [(a,b) => 0]  // preserve insertion order (interleaved sets)
        : orderingFns.slice(0, 4);

    /* Inner single-pass nester — tries one specific queue ordering.       */
    const runPass = async (queue, onPassProgress) => {
      const _allPl = [];
      const _unplacedItems = [];
      let _grid = new Uint8Array(GW*GH), _sky = new Int32Array(GW);
      // Pre-populate grid with leather-sheet obstacle mask (outline+defects).
      // Skyline must start at the FIRST VALID y from the top of each column.
      // In this engine's convention: gy=0 is top of sheet, gy=GH-1 is bottom.
      // A part with bbox h occupies gy..gy+h-1, so sky[x] is the top-most y
      // where a new part can be placed in column x. For rect sheets sky[x]=0.
      // For hide sheets, columns that START with forbidden cells (because
      // they're above/outside the hide outline at that column) need sky[x]
      // to skip past those forbidden cells to the first valid cell.
      if (_obstacleMask) {
        _grid.set(_obstacleMask);
        for (let gx = 0; gx < GW; gx++) {
          // Scan DOWN from top: find first non-forbidden cell.
          // That cell is the minimum y where a part can start in this column.
          let sk = 0;
          for (let gy = 0; gy < GH; gy++) {
            if (_obstacleMask[gy * GW + gx]) sk = gy + 1;
            else break;
          }
          // If the entire column is forbidden (e.g. outside hide entirely),
          // sky[gx] = GH means no placement possible in this column.
          _sky[gx] = sk;
        }
      }
      let _placed = 0;
      let _curMaxX = 0, _curMaxY = 0;
      let _lastYield = performance.now();

      // ── Set-mode placement logic ───────────────────────────────────
      // In set mode, the queue is interleaved by set index.
      // When any part of a set fails to place, abandon trying the remaining
      // parts of that set AND all future sets (they won't fit either).
      // Then continue with extras (non-set items at end of queue).
      let _abandonSets = false;
      let _currentFailedSetIdx = -1;
      const failedExtraIds = new Set();   // copies-as-sets: one try per part for extras

      for (let pi = 0; pi < queue.length; pi++) {
        if (isCancelled && isCancelled()) break;
        const now = performance.now();
        if (now - _lastYield > 40) {
          onPassProgress(_placed / Math.max(queue.length, 1), `Placed: ${_placed}`);
          await sleep(0);
          _lastYield = performance.now();
        }

        const part = queue[pi];
        // If we're abandoning sets and this part is part of one, skip it
        if (_abandonSets && part._inSet) {
          _unplacedItems.push(part);
          continue;
        }
        // If we abandoned a specific set mid-placement, skip further items of that set
        if (_currentFailedSetIdx >= 0 && part._setIdx === _currentFailedSetIdx) {
          _unplacedItems.push(part);
          continue;
        }
        // Reset failed-set marker when we enter a new set
        if (part._inSet && part._setIdx !== _currentFailedSetIdx) {
          _currentFailedSetIdx = -1;
        }
        if (part._exhaustFill && derivedSets && failedExtraIds.has(part.id)) {
          _unplacedItems.push(part);
          continue;
        }

        const variants = vc.get(part.id);
        const denseMode = fillSheet || multiSheet;
        const partZoneMask = zoneMaskByPart.get(part.id) || null;
        const pl = await this.place(variants, _grid, GW, GH, _sky, _curMaxX, _curMaxY, denseMode, isCancelled, partZoneMask);

        if (pl !== null) {
          const v = variants[pl.vi];
          this.mark(_grid, GW, GH, v.flatD, pl.gx, pl.gy);
          this.bumpSky(_sky, v.flat, pl.gx, pl.gy, Math.max(gapC, 1));
          if (pl.gx + v.w > _curMaxX) _curMaxX = pl.gx + v.w;
          if (pl.gy + v.h > _curMaxY) _curMaxY = pl.gy + v.h;

          let rPts = v.mirror ? mirrorPts(part.pts, v.mirror) : part.pts;
          rPts = rotatePts(rPts, v.rotation);
          const innerLines = (part.innerLines||[]).map(il => {
            let lp = v.mirror ? mirrorPts(il.pts, v.mirror) : il.pts;
            return { pts: rotatePts(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
          });
          const placement = { partId:part.id, partName:part.name, color:part.color,
            _uid: part._uid,
            pts:rPts,
            x: margin + pl.gx/effRes, y: margin + pl.gy/effRes,
            rotation:v.rotation, mirror:v.mirror, sheet:0, innerLines };
          _allPl.push(placement);
          _placed++;
          // Progressive rendering hook — notify the caller immediately so
          // the UI can draw this part. Safe wrapper: never let callback
          // throw break the nest.
          try { _emit({ placement, totalPlaced: _placed, sheetIdx: 0 }); } catch(_){}
        } else {
          if (part._inSet) {
            // Set-part failed — abandon this set's remaining parts
            // (copies-as-sets keeps trying the rest of the set: the smaller
            // parts may still fit) and ALL future sets.
            if (!derivedSets) _currentFailedSetIdx = part._setIdx;
            _abandonSets = true;
          }
          if (part._exhaustFill && derivedSets) failedExtraIds.add(part.id);
          else if (fillSheet && !part._inSet) break;
          _unplacedItems.push(part);
        }
      }

      // ── PHASE 3: CROSS-COMPONENT ZONE OVERFLOW (one-direction) ─────────
      // Mirrors poly-engine Phase 3. Unrestricted parts spill into reserved
      // zones IF the owning restricted component(s) have no more parts wanting
      // placement. Restricted parts STAY strict (never spill).
      if (_unplacedItems.length > 0
          && settings.componentRules
          && _reservedZonesGlob.size > 0
          && _zoneCentersGlob && _coarseZoneGlob) {
        // Phase 3 always releases ALL reserved zones — see poly-engine for rationale.
        // Restricted parts already attempted in main pass; unrestricted parts can
        // safely use leftover zone space without displacing any restricted part
        // that could have fit.
        const releasedZones = new Set(_reservedZonesGlob);
        if (releasedZones.size > 0) {
          // Filter to UNRESTRICTED unplaced (restricted parts stay strict)
          const phase3Queue = _unplacedItems.filter(p => {
            const k = p._componentKey;
            const rule = k && settings.componentRules.get(k);
            return !rule || !rule.allowedZones || !rule.allowedZones.size;
          });
          if (phase3Queue.length > 0) {
            console.log(`[NestForge raster Phase 3] ${phase3Queue.length} unrestricted parts retry into ALL reserved zones [${[...releasedZones].join(',')}] (restricted parts already attempted)`);
            // Build a relaxed mask: forbid only those reserved zones that are NOT released
            const phase3Allowed = new Set();
            for (const z of _zoneIdsGlob) {
              if (!_reservedZonesGlob.has(z) || releasedZones.has(z)) {
                phase3Allowed.add(z);
              }
            }
            // Cache by signature so multiple Phase 3 runs reuse it
            const sig3 = 'phase3:' + Array.from(phase3Allowed).sort().join(',');
            let phase3Mask = _maskCacheGlob.get(sig3);
            if (!phase3Mask) {
              const forbid3 = new Uint8Array(_zoneCentersGlob.length);
              for (let z = 0; z < _zoneCentersGlob.length; z++) {
                forbid3[z] = phase3Allowed.has(_zoneIdsGlob[z]) ? 0 : 1;
              }
              const m3 = new Uint8Array(GW * GH);
              let mnX = GW, mxX = -1, mnY = GH, mxY = -1;
              for (let gy = 0; gy < GH; gy++) {
                const cy = Math.min(_cGHGlob - 1, Math.floor(gy * _cGHGlob / GH));
                const cRow = cy * _cGWGlob;
                const fRow = gy * GW;
                for (let gx = 0; gx < GW; gx++) {
                  const cx = Math.min(_cGWGlob - 1, Math.floor(gx * _cGWGlob / GW));
                  const zIdx = _coarseZoneGlob[cRow + cx];
                  if (zIdx < 0 || forbid3[zIdx]) {
                    m3[fRow + gx] = 1;
                  } else {
                    if (gx < mnX) mnX = gx;
                    if (gx > mxX) mxX = gx;
                    if (gy < mnY) mnY = gy;
                    if (gy > mxY) mxY = gy;
                  }
                }
              }
              phase3Mask = { mask: m3, bbox: { minX: mnX, maxX: mxX, minY: mnY, maxY: mxY } };
              _maskCacheGlob.set(sig3, phase3Mask);
            }
            // Try to place each unrestricted unplaced part with the relaxed mask
            const phase3Placed = new Set();
            // A count, not a clock, so the result does not depend on machine speed.
            const PHASE3_MAX_ATTEMPTS = 200;
            let phase3Attempts = 0;
            const phase3Sorted = phase3Queue.slice().sort((a, b) => polyArea(b.pts) - polyArea(a.pts));
            for (const part of phase3Sorted) {
              if (isCancelled && isCancelled()) break;
              if (++phase3Attempts > PHASE3_MAX_ATTEMPTS) break;
              const variants = vc.get(part.id);
              const denseMode = fillSheet || multiSheet;
              const pl = await this.place(variants, _grid, GW, GH, _sky, _curMaxX, _curMaxY, denseMode, isCancelled, phase3Mask);
              if (pl !== null) {
                const v = variants[pl.vi];
                this.mark(_grid, GW, GH, v.flatD, pl.gx, pl.gy);
                this.bumpSky(_sky, v.flat, pl.gx, pl.gy, Math.max(gapC, 1));
                if (pl.gx + v.w > _curMaxX) _curMaxX = pl.gx + v.w;
                if (pl.gy + v.h > _curMaxY) _curMaxY = pl.gy + v.h;
                let rPts = v.mirror ? mirrorPts(part.pts, v.mirror) : part.pts;
                rPts = rotatePts(rPts, v.rotation);
                const innerLines = (part.innerLines||[]).map(il => {
                  let lp = v.mirror ? mirrorPts(il.pts, v.mirror) : il.pts;
                  return { pts: rotatePts(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
                });
                const placement = { partId:part.id, partName:part.name, color:part.color,
                  _uid: part._uid, pts:rPts,
                  x: margin + pl.gx/effRes, y: margin + pl.gy/effRes,
                  rotation:v.rotation, mirror:v.mirror, sheet:0, innerLines, _phase3: true };
                _allPl.push(placement);
                _placed++;
                phase3Placed.add(part._uid);
                try { _emit({ placement, totalPlaced: _placed, sheetIdx: 0 }); } catch(_){}
              }
            }
            if (phase3Placed.size > 0) {
              // Remove placed items from unplaced
              const filtered = _unplacedItems.filter(p => !phase3Placed.has(p._uid));
              _unplacedItems.length = 0;
              for (const p of filtered) _unplacedItems.push(p);
              console.log(`[NestForge raster Phase 3] placed ${phase3Placed.size} unrestricted parts in released zones`);
            }
          }
        }
      }

      return { placements:_allPl, placed:_placed,
               unplaced: _unplacedItems.length, unplacedItems: _unplacedItems,
               completeSets: derivedSets ? countSets(_allPl) : 0,
               maxX:_curMaxX, maxY:_curMaxY };
    };

    // Score a pass: lower is better. Prefers fewer unplaced and tighter bbox.
    // SIMPLIFIED: -placed*1e9 means more placed = better. Tiebreak by tighter
    // bbox. See poly-engine for full rationale on why this beats the previous
    // unplaced*1e12 weighting (set abandonment ambiguity).
    // Copies-as-sets: complete sets outrank the raw count.
    const scorePass = (r) => -(r.completeSets || 0) * 1e12 - r.placed * 1e9 + r.maxX * r.maxY;

    // Single-sheet pass: try each ordering, keep the best.
    const singleSheetBestPass = async (queue, progressOffset, progressScale) => {
      let bestPass = null;
      for (let oi = 0; oi < orderings.length; oi++) {
        if (isCancelled && isCancelled()) break;
        const q = [...queue].sort(orderings[oi]);
        const prog = (pct, msg) => onProgress(
          progressOffset + (oi + pct) / orderings.length * progressScale,
          `Ordering ${oi+1}: ${msg}`);
        const r = await runPass(q, prog);
        if (!bestPass || scorePass(r) < scorePass(bestPass)) bestPass = r;
        if (bestPass.unplaced === 0 && oi === 0 && bestPass.maxY < GH * 0.6) break;
      }
      return bestPass;
    };

    // ── MAIN LOOP: single sheet OR overflow to many sheets ──
    const MAX_SHEETS = 50;
    const allPl = [];
    const sheetsList = [];
    let remainingQueue = baseQueue;
    let sheetIdx = 0;
    let totalUnplaced = 0;

    while (remainingQueue.length > 0) {
      if (isCancelled && isCancelled()) break;
      if (sheetIdx >= MAX_SHEETS) { totalUnplaced = remainingQueue.length; break; }

      const estTotalSheets = Math.max(1, Math.ceil(baseQueue.length / Math.max(1, baseQueue.length - remainingQueue.length + 1)));
      const progressOffset = sheetIdx / Math.max(1, estTotalSheets);
      const progressScale = 1 / Math.max(1, estTotalSheets);
      onProgress(Math.min(0.99, progressOffset),
                 `Sheet ${sheetIdx + 1}: nesting ${remainingQueue.length} parts…`);

      const bestPass = await singleSheetBestPass(remainingQueue, progressOffset, progressScale);
      if (!bestPass) break;
      if (bestPass.placed === 0) { totalUnplaced = remainingQueue.length; break; }

      // Tag placements with this sheet index
      for (const p of bestPass.placements) p.sheet = sheetIdx;
      allPl.push(...bestPass.placements);
      sheetsList.push({ idx: sheetIdx, placements: bestPass.placements });

      remainingQueue = bestPass.unplacedItems;
      sheetIdx++;
      if (derivedSets && remainingQueue.length && remainingQueue.every(p => p._exhaustFill)) {
        remainingQueue = [];   // extras only top up a sheet, they never open one
      }

      // Stop after one sheet if multi-sheet mode is off OR fillSheet is on
      if (!multiSheet || fillSheet) {
        totalUnplaced = derivedSets ? remainingQueue.filter(p => !p._exhaustFill).length : remainingQueue.length;
        break;
      }
    }

    if (sheetsList.length === 0) {
      sheetsList.push({ idx: 0, placements: [] });
    }

    const out = { placements: allPl,
             sheets: sheetsList,
             placed: allPl.length,
             unplaced: totalUnplaced,
             sheetCount: sheetsList.length,
             usableW:usW, usableH:usH, effRes };
    if (fillSheet && !derivedSets && !settings._autoExpandQueueCap) out.unplaced = 0;   // fill leftovers are not missing parts
    if (derivedSets) {
      out.sets = { requested: nSetsWanted, complete: countSets(allPl), partsPerSet: partDefs.length,
                   perPart: placedPerPart(allPl) };
      out.unplaced = out.sets.perPart.reduce((a, r) => a + Math.max(0, nSetsWanted - r.placed), 0);
    }
    return out;
  },

  // Cells a part may not use: outside a non-rectangular sheet (a hide) and on
  // defects. Shared by nest() and _flowNestSingle(), which size their grids
  // identically. Null for a plain rectangular sheet with no defects.
  _buildObstacleMask(settings, GW, GH, effRes) {
    if (!(settings.sheetOutline || (settings.defects && settings.defects.length))) return null;
    const _obstacleMask = new Uint8Array(GW * GH);

    // 1. Mark cells OUTSIDE the sheet outline as forbidden.
    if (settings.sheetOutline && settings.sheetOutline.length >= 3) {
      const poly = settings.sheetOutline;  // already margin-shifted to usable-area coords
      // Scanline rasterize: for each grid row, find x-intersections with polygon edges,
      // then mark cells OUTSIDE the interior spans as forbidden.
      for (let gy = 0; gy < GH; gy++) {
        const yc = (gy + 0.5) / effRes;  // sheet-mm coordinate of cell center
        const xs = [];
        for (let i = 0; i < poly.length; i++) {
          const [ax, ay] = poly[i];
          const [bx, by] = poly[(i + 1) % poly.length];
          if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
            const t = (yc - ay) / (by - ay);
            xs.push(ax + t * (bx - ax));
          }
        }
        xs.sort((a, b) => a - b);
        // Mark all cells first as forbidden, then clear the inside spans
        for (let gx = 0; gx < GW; gx++) _obstacleMask[gy * GW + gx] = 1;
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const gxa = Math.max(0, Math.ceil(xs[k] * effRes));
          const gxb = Math.min(GW - 1, Math.floor(xs[k + 1] * effRes));
          for (let gx = gxa; gx <= gxb; gx++) _obstacleMask[gy * GW + gx] = 0;
        }
      }
    }

    // 2. Mark defect zones as forbidden. If defect has an irregular
    //    shape polygon (realistic scar outline), rasterize it with
    //    scanline. Otherwise fall back to circle.
    if (settings.defects && settings.defects.length) {
      for (const d of settings.defects) {
        if (d.shape && d.shape.length >= 3) {
          // Scanline-rasterize the polygon into the mask
          let minY = Infinity, maxY = -Infinity;
          for (const [, py] of d.shape) {
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
          const gyStart = Math.max(0, Math.floor(minY * effRes));
          const gyEnd = Math.min(GH - 1, Math.ceil(maxY * effRes));
          for (let gy = gyStart; gy <= gyEnd; gy++) {
            const yc = (gy + 0.5) / effRes;
            const xs = [];
            for (let i = 0; i < d.shape.length; i++) {
              const [ax, ay] = d.shape[i];
              const [bx, by] = d.shape[(i + 1) % d.shape.length];
              if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
                const t = (yc - ay) / (by - ay);
                xs.push(ax + t * (bx - ax));
              }
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
              const gxa = Math.max(0, Math.ceil(xs[k] * effRes));
              const gxb = Math.min(GW - 1, Math.floor(xs[k + 1] * effRes));
              for (let gx = gxa; gx <= gxb; gx++) _obstacleMask[gy * GW + gx] = 1;
            }
          }
        } else {
          // Circle fallback
          const gcx = d.x * effRes, gcy = d.y * effRes;
          const gr = d.r * effRes;
          const gxa = Math.max(0, Math.floor(gcx - gr));
          const gxb = Math.min(GW - 1, Math.ceil(gcx + gr));
          const gya = Math.max(0, Math.floor(gcy - gr));
          const gyb = Math.min(GH - 1, Math.ceil(gcy + gr));
          const gr2 = gr * gr;
          for (let gy = gya; gy <= gyb; gy++) {
            for (let gx = gxa; gx <= gxb; gx++) {
              const dx = gx + 0.5 - gcx, dy = gy + 0.5 - gcy;
              if (dx*dx + dy*dy <= gr2) _obstacleMask[gy * GW + gx] = 1;
            }
          }
        }
      }
    }
    return _obstacleMask;
  },

  getMirrors(m) {
    return m==='x'?[null,'x']
         :m==='y'?[null,'y']
         :m==='both'?[null,'x','y']
         :m==='x-must'?['x']
         :m==='y-must'?['y']
         :m==='both-must'?['x','y']
         :[null];
  },

  /* Convert raw zone labels (FORE/FLANK duplicates, BELLY twice, etc.) into
     unique zone centers for Voronoi classification of cells. Returns
     [ [zoneId, cx, cy], ... ] where zoneId matches the allowedZones rule
     IDs (butt, shoulder, neck, belly, fore_flank, hind_flank). */
  _getZoneCenters(labels) {
    // Group FORE+FLANK pairs: any FORE label whose nearest FLANK is within
    // ~5% of hide size is part of FORE FLANK zone. Same for HIND+FLANK.
    // Plain BUTT, SHOULDER, NECK, BELLY labels become their own centers.
    // Multiple BELLY / FORE FLANK / HIND FLANK labels = multiple centers
    // for the same zone (handled by the nearest-check at use site).
    const centers = [];
    const used = new Set();
    for (let i = 0; i < labels.length; i++) {
      if (used.has(i)) continue;
      const L = labels[i];
      const t = L.text.toUpperCase().trim();
      if (t === 'BUTT')     centers.push(['butt',     L.x, L.y]);
      else if (t === 'SHOULDER') centers.push(['shoulder', L.x, L.y]);
      else if (t === 'NECK')     centers.push(['neck',     L.x, L.y]);
      else if (t === 'BELLY')    centers.push(['belly',    L.x, L.y]);
      else if (t === 'FORE' || t === 'HIND') {
        // Find the matching FLANK label closest to this one
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

  buildVariants(pts, rots, mirrors, res, gapC) {
    const out = [];
    // Minimum 1-cell dilation absorbs sub-pixel rasterization errors.
    // For non-zero user gap: add 1 cell of buffer so the resulting
    // physical minimum gap is at least the requested value (rounding
    // up to one cell over to be safe). Without this buffer, ceil()
    // can leave the gap short by sub-cell amounts that look like
    // touching parts at high zoom.
    const safeGap = gapC > 0 ? gapC + 1 : 1;
    for (const mirror of mirrors) {
      const mPts = mirror ? mirrorPts(pts, mirror) : pts;
      for (const rot of rots) {
        const rotated = rotatePts(mPts, rot);
        const { pts:np, bbox } = normalizePoly(rotated);
        const w = Math.ceil(bbox.w*res)+2, h = Math.ceil(bbox.h*res)+2;
        const { cells } = rasterizePolygon(np, res, w, h);
        const dilated = buildDilatedCells(cells, safeGap, w, h);
        const tops = computeColTops(cells, w);
        // ── Flat Int32Array: [x0,y0,x1,y1,...] — ~5× faster loop ──
        const flat = new Int32Array(cells.length * 2);
        for (let i = 0; i < cells.length; i++) { flat[i*2]=cells[i][0]; flat[i*2+1]=cells[i][1]; }
        const flatD = new Int32Array(dilated.length * 2);
        for (let i = 0; i < dilated.length; i++) { flatD[i*2]=dilated[i][0]; flatD[i*2+1]=dilated[i][1]; }
        out.push({ rotation:rot, mirror, bbox, w, h, cells, flat, flatD, dilated, tops });
      }
    }
    return out;
  },

  /* Skyline Bottom-Left-Fill — correct interlocking via colTops NFP.
     ──────────────────────────────────────────────────────────────────
     The skyline formula ALREADY encodes interlocking:
       minY(gx) = max_dx { sky[gx+dx] − colTops[dx] }
     colTops[dx] = topmost cell of the new part at column offset dx.
     If the new part has a CONCAVE bottom (colTops[dx] > 0 at dx), the
     formula LOWERS minY — the part slides down into the existing
     material's convex profile. This is correct floor-interlocking.

     Why we do NOT backward-scan (scanStart = minY, not minY-h):
     • Backward scan allowed parts to reach UP into ceiling concavities,
       which caused cumulative diagonal drift across the sheet: each
       column's base-Y shifted lower than the previous, creating the
       diagonal wave/band visible in the output.
     • The skyline formula + colTops already captures the correct
       floor-interlocking without any backward scan.
     • canPlace() is the exact pixel-level arbiter for all placements.

     SCORING — `curMaxX`/`curMaxY` passed from the outer loop track the
     bounding box of all already-placed parts.  We minimise HEIGHT first
     (because width is fixed by the user and height is the scarce axis
     that grows the sheet), then minimise width, then fall back to
     bottom-left tie-breaks.  This actively uses dead space in the current
     horizontal range before extending height — e.g. a small part gets
     tucked into an empty column rather than placed below the last part.  */
  async place(variants, grid, GW, GH, sky, curMaxX, curMaxY, fillSheet, isCancelled, zoneMaskObj) {
    curMaxX = curMaxX || 0;
    curMaxY = curMaxY || 0;
    let best = null;
    let lastYield = performance.now();

    // Unpack zoneMaskObj = { mask, bbox: {minX,maxX,minY,maxY} } or legacy mask
    let zoneMask = null;
    let zoneMinX = 0, zoneMaxX = GW - 1, zoneMinY = 0, zoneMaxY = GH - 1;
    if (zoneMaskObj) {
      if (zoneMaskObj.mask) {
        zoneMask = zoneMaskObj.mask;
        const bb = zoneMaskObj.bbox;
        if (bb && bb.maxX >= 0) {
          zoneMinX = bb.minX; zoneMaxX = bb.maxX;
          zoneMinY = bb.minY; zoneMaxY = bb.maxY;
        } else {
          return null;  // zone bbox empty = no valid cells
        }
      } else {
        zoneMask = zoneMaskObj;  // legacy: just the Uint8Array
      }
    }

    for (let vi = 0; vi < variants.length; vi++) {
      const { w, h, flat, tops } = variants[vi];
      const mX = GW-w, mY = GH-h;
      if (mX < 0 || mY < 0) continue;

      const gxStart = zoneMask ? Math.max(0, zoneMinX - w + 1) : 0;
      const gxEnd = zoneMask ? Math.min(mX, zoneMaxX) : mX;

      for (let gx = gxStart; gx <= gxEnd; gx++) {
        if ((gx & 31) === 0) {
          const now = performance.now();
          if (now - lastYield > 30) {
            if (isCancelled && isCancelled()) return best;
            await sleep(0);
            lastYield = performance.now();
          }
        }
        let minY = 0;
        for (let dx = 0; dx < w; dx++) {
          const t = tops[dx];
          if (t < 999999) { const n = sky[gx+dx] - t; if (n > minY) minY = n; }
        }
        const scanStart = Math.max(0, Math.min(minY, mY));
        const gyEnd = zoneMask ? Math.min(mY, zoneMaxY) : mY;

        for (let gy = scanStart; gy <= gyEnd; gy++) {
          if (!this.canPlace(flat, grid, GW, GH, gx, gy)) continue;
          if (zoneMask && !this.canPlace(flat, zoneMask, GW, GH, gx, gy)) continue;
          const newMaxY = Math.max(curMaxY, gy + h);
          const newMaxX = Math.max(curMaxX, gx + w);
          let cost;
          if (fillSheet) {
            cost = newMaxY * 1e6 + newMaxX * 1e3 + gy * 10 + gx;
          } else {
            const bboxArea = newMaxX * newMaxY;
            cost = bboxArea * 1000 + gy * 10 + gx;
          }
          if (best === null || cost < best.cost) {
            best = { gx, gy, vi, cost };
          }
          break;
        }
      }
    }
    return best;
  },

  /* canPlace / mark / bumpSky use flat Int32Array [x0,y0,x1,y1,...]
     — avoids array-of-arrays overhead, ~5× faster in hot loops.     */
  canPlace(flat, grid, GW, GH, ox, oy) {
    for (let i = 0, n = flat.length; i < n; i += 2) {
      const nx = flat[i]+ox, ny = flat[i+1]+oy;
      if (nx<0||nx>=GW||ny<0||ny>=GH||grid[ny*GW+nx]) return false;
    }
    return true;
  },

  mark(grid, GW, GH, flatD, ox, oy) {
    for (let i = 0, n = flatD.length; i < n; i += 2) {
      const nx = flatD[i]+ox, ny = flatD[i+1]+oy;
      if (nx>=0&&nx<GW&&ny>=0&&ny<GH) grid[ny*GW+nx]=1;
    }
  },

  bumpSky(sky, flat, ox, oy, gapC=0) {
    for (let i = 0, n = flat.length; i < n; i += 2) {
      const x = flat[i]+ox;
      if (x>=0&&x<sky.length) { const y=flat[i+1]+oy+1+gapC; if(y>sky[x]) sky[x]=y; }
    }
  },

  /* ─────────────────────────────────────────────────────────────────
     CUTTING FLOW NESTING  —  Row-cursor algorithm
     ──────────────────────────────────────────────────────────────
     Root cause of gaps with the old queue-based approach:
       place() searches the WHOLE sheet for topmost-leftmost, so A and B
       parts scatter randomly instead of staying in ordered rows.

     Fix — strict left-to-right row cursor:
       • Each row fills from curGX=0 → rightward using placeFromX(curGX)
       • Rotation per position: (rowNum + posInRow) % 2 → A or B
         Row 0: A B A B A B ...  (starts with A)
         Row 1: B A B A B A ...  (starts with B → half-period offset)
         Row 2: A B A B ...      (back to A → brick-wall offset between rows)
       • This offset between rows is what creates the interlocking wave
         because rotB's concave TOP naturally fits rotA's concave BOTTOM
         at a slightly shifted X position.
       • When placeFromX returns null the row is done; rowNum++ resets curGX=0
     ───────────────────────────────────────────────────────────── */
  // MULTI-STRATEGY flowNest dispatcher (raster engine).
  // Tries multiple lane directions + rotation pairs, returns the best
  // result by placement count, then bbox tightness. Each strategy is
  // a full single-pass nest; we run them sequentially and rank.
  //
  // Strategies considered:
  //   1. Horizontal lanes, parts upright (0° / 180°)   — typical
  //   2. Vertical lanes, parts sideways (90° / 270°)   — typical
  //   3. Horizontal lanes, parts on side (90° / 270°)  — try lying down
  //   4. Vertical lanes, parts upright (0° / 180°)     — try standing up
  // For each: also tries the swapped rotation pair (B-first instead of A).
  // The 16-layout Cutting Flow search is shared with the other engine and
  // runs its layouts in parallel. See src/nesting/flow-strategies.js.
  async flowNest(partDefs, settings, onProgress, isCancelled, onPlacement) {
    return FlowStrategies.run(this, partDefs, settings, onProgress, isCancelled, onPlacement);
  },

  // SINGLE-STRATEGY flowNest — actually runs one specific lane direction.
  // flowNest() above hands all 16 layouts to FlowStrategies.run().
  async _flowNestSingle(partDefs, settings, onProgress, isCancelled, onPlacement) {
    const _emit = onPlacement || (() => {});
    const { sheetW, sheetH, margin, gap, resolution, mirrorMode,
            copies, fillSheet, flowDir } = settings;

    const usW = sheetW - 2*margin, usH = sheetH - 2*margin;

    // Same auto-resolution cap as nest()
    const MAX_GRID_CELLS = 12_000_000;
    const resLimit = Math.sqrt(MAX_GRID_CELLS / (usW * usH));
    const effRes = resLimit < resolution ? Math.max(0.5, resLimit) : resolution;
    const GW = Math.ceil(usW * effRes), GH = Math.ceil(usH * effRes);
    const gapC = Math.ceil(gap * effRes);
    // Hide outline and defects. This call was missing: the grid code below
    // was copied from nest() without the mask it depends on, so every raster
    // Cutting Flow run threw "_obstacleMask is not defined".
    const _obstacleMask = this._buildObstacleMask(settings, GW, GH, effRes);
    const mirrors = this.getMirrors(mirrorMode);

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

    onProgress(0, `Flow mode — Grid ${GW}×${GH} | res ${(1/effRes).toFixed(1)}mm/cell`);
    await sleep(0);

    // Build rasterised variants for each rotation
    const vcA = new Map(), vcB = new Map();
    for (const p of partDefs) {
      vcA.set(p.id, this.buildVariants(p.pts, [rotA], mirrors, effRes, gapC));
      vcB.set(p.id, this.buildVariants(p.pts, [rotB], mirrors, effRes, gapC));
    }

    const totalPartArea = partDefs.reduce((s,p) => s + polyArea(p.pts), 0) || 1;
    // Budget per part, not per sheet (same fix as the polygon flow engine):
    // "3 copies" is 3 of EACH part; auto-expand caps each part likewise.
    const perPart = settings._autoExpandQueueCap || copies;
    let maxTotal = settings._autoExpandQueueCap
      ? settings._autoExpandQueueCap * partDefs.length
      : (fillSheet
          ? Math.min(8000, Math.ceil(usW * usH / totalPartArea) + 50)
          : copies * partDefs.length);
    // Fill mode with several parts: complete sets first (each part capped
    // at `copies`), then the caps are lifted for extras.
    const setsFirst = fillSheet && !settings._autoExpandQueueCap && copies >= 1 && partDefs.length >= 2;

    /* placeFromX — find the LEFTMOST valid placement starting at minGX.
       Unlike place() which scans the whole sheet, this advances the row
       cursor strictly left→right, preventing backward jumps.            */
    const placeFromX = (variants, minGX) => {
      for (let vi = 0; vi < variants.length; vi++) {
        const { w, h, flat, tops } = variants[vi];
        if (GW-w < 0 || GH-h < 0) continue;
        const mX = GW-w, mY = GH-h;
        for (let gx = Math.max(0, minGX); gx <= mX; gx++) {
          let minY = 0;
          for (let dx = 0; dx < w; dx++) {
            const t = tops[dx];
            if (t < 999999) { const n = sky[gx+dx]-t; if (n>minY) minY=n; }
          }
          const gy0 = Math.max(0, Math.min(minY, mY));
          for (let gy = gy0; gy <= mY; gy++) {
            if (this.canPlace(flat, grid, GW, GH, gx, gy)) {
              return { gx, gy, vi }; // leftmost found — return immediately
            }
          }
          // If this gx failed entirely, continue scanning right
        }
      }
      return null; // row is full
    };

    const allPl = [], sheets = [];
    let si = 0, grid = new Uint8Array(GW*GH), sky = new Int32Array(GW);
    if (_obstacleMask) {
      grid.set(_obstacleMask);
      for (let gx = 0; gx < GW; gx++) {
        // Scan DOWN from top: skyline starts at first non-forbidden cell
        let sk = 0;
        for (let gy = 0; gy < GH; gy++) {
          if (_obstacleMask[gy * GW + gx]) sk = gy + 1;
          else break;
        }
        sky[gx] = sk;
      }
    }
    let placed = 0;
    const t0 = performance.now(); let lastYield = t0;
    let rowNum = 0;

    // Track how many copies of each part placed (for non-fill mode)
    const copiesLeft = new Map(partDefs.map(p => [p.id, (fillSheet && !setsFirst) ? maxTotal : perPart]));
    // Multi-sheet overflow (FlowStrategies.run): what is still wanted of
    // each part after the sheets before this one.
    if (settings._remainingById) {
      maxTotal = 0;
      for (const p of partDefs) { const n = settings._remainingById[p.id] | 0; copiesLeft.set(p.id, n); maxTotal += n; }
    }
    let capsLifted = !setsFirst;
    // Sets first: cycle the parts biggest first, so a large part is not
    // squeezed out of every row by the small ones that come before it in
    // the import order. Plain copies keep the import order (cut sequence).
    const cycle = setsFirst
      ? partDefs.slice().sort((a, b) => polyArea(b.pts) - polyArea(a.pts) || (String(a.id) < String(b.id) ? -1 : 1))
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

    // Lane sequence knobs, as in the polygon engine's _flowNestSingle. The
    // raster engine's own original is 'tight' with a half advance.
    const flowSeq = settings._flowSeq || 'tight';
    const halfAdvance = settings._flowAdvance ? settings._flowAdvance === 'half' : true;
    const rowOffset = settings._flowOffset || 0;
    const rotFor = (rowNum, posInRow) => {
      switch (flowSeq) {
        case 'alt':       return posInRow % 2 === 0 ? 'A' : 'B';
        case 'alt-flip':  return (rowNum + posInRow) % 2 === 0 ? 'A' : 'B';
        case 'rows':      return rowNum % 2 === 0 ? 'A' : 'B';
        case 'rows-flip': return rowNum % 2 === 0 ? 'B' : 'A';
        case 'same-A':    return 'A';
        case 'same-B':    return 'B';
        default:          return 'AB';
      }
    };
    const offsetGX = rowOffset ? Math.round(rowOffset * vcA.get(cycle[0].id)[0].w) : 0;

    rowLoop: while (true) {
      let curGX = (rowNum % 2 === 1) ? offsetGX : 0, posInRow = 0, rowPlaced = 0;

      while (true) {
        if (isCancelled && isCancelled()) break rowLoop;
        if (placed >= maxTotal) break rowLoop;

        // Time-budget yield
        const now = performance.now();
        if (now - lastYield > 40) {
          onProgress(Math.min(0.99, placed / maxTotal),
            `Flow row ${rowNum+1} | placed: ${placed} | ${((now-t0)/1000).toFixed(1)}s`);
          await sleep(0); lastYield = performance.now();
        }

        // TIGHTEST-FIT PLACEMENT: try BOTH rotation variants (A and B)
        // and pick whichever gives the leftmost (= tightest) valid position.
        // Previously this forced alternating A/B per position, which creates
        // the documented "wavy cutting path" pattern but produces large
        // gaps for asymmetric shapes (vamps, quarters, etc.) where rotation
        // A vs B faces opposite directions.
        //
        // Quality preserved: canPlace() collision-checks each candidate,
        // so the tightest valid position is always chosen.

        const partIdx = posInRow % partDefs.length;
        const part = cycle[partIdx];

        if ((copiesLeft.get(part.id) || 0) <= 0) {
          posInRow++;
          if (posInRow > maxTotal) break;
          continue;
        }

        const which = rotFor(rowNum, posInRow);
        const variantsA = vcA.get(part.id);
        const variantsB = vcB.get(part.id);
        const plA = which === 'B' ? null : placeFromX(variantsA, curGX);
        const plB = which === 'A' ? null : placeFromX(variantsB, curGX);

        // Pick the leftmost (tighter) placement; if both same gx, prefer A.
        // null means that variant set couldn't fit anywhere.
        let pl = null, variants = null;
        if (plA && plB) {
          if (plA.gx <= plB.gx) { pl = plA; variants = variantsA; }
          else                   { pl = plB; variants = variantsB; }
        } else if (plA) { pl = plA; variants = variantsA; }
        else if (plB) { pl = plB; variants = variantsB; }

        if (pl === null) {
          // Row exhausted — move to next row
          break;
        }

        const v = variants[pl.vi];
        this.mark(grid, GW, GH, v.flatD, pl.gx, pl.gy);
        this.bumpSky(sky, v.flat, pl.gx, pl.gy, Math.max(gapC, 1));

        let rPts = v.mirror ? mirrorPts(part.pts, v.mirror) : part.pts;
        rPts = rotatePts(rPts, v.rotation);
        // Transform inner marking lines with same rotation/mirror
        const innerLines = (part.innerLines||[]).map(il => {
          let lp = v.mirror ? mirrorPts(il.pts, v.mirror) : il.pts;
          return { pts: rotatePts(lp, v.rotation), color: il.color, layer: il.layer, closed: il.closed };
        });
        const placement = { partId:part.id, partName:part.name, color:part.color, pts:rPts,
          x: margin + pl.gx/effRes, y: margin + pl.gy/effRes,
          rotation:v.rotation, mirror:v.mirror, sheet:si, innerLines };
        allPl.push(placement);
        try { _emit({ placement, totalPlaced: placed + 1, sheetIdx: si }); } catch(_){}

        copiesLeft.set(part.id, (copiesLeft.get(part.id)||0) - 1);
        if (setsFirst && !capsLifted && allCapsReached()) liftCaps();
        // CURSOR ADVANCE — Previously this jumped by the full part width
        // (pl.gx + v.w), which prevented adjacent parts from interlocking
        // into each other's concave cavities. For convex parts this is
        // optimal, but for concave shapes like shoe vamps, much of each
        // part's right side is "empty" curve space that the next part's
        // left curve could fit into.
        //
        // Fix: advance by HALF the part width. placeFromX() will scan
        // forward from there and find the leftmost cavity-respecting
        // position via canPlace() collision check. Same quality
        // guarantees, much tighter horizontal packing.
        curGX = pl.gx + (halfAdvance ? Math.max(1, Math.floor(v.w * 0.5)) : v.w);
        posInRow++;
        rowPlaced++;
        placed++;
      }

      if (rowPlaced === 0) {
        // Sets-first: the rows are done with the caps on; lift them and
        // let extras use the rest of the sheet.
        if (liftCaps()) continue;
        break; // no part fit anywhere — sheet full
      }
      rowNum++;
    }

    sheets.push({ idx:si, placements: allPl });
    const out = { placements:allPl, sheets, placed,
             unplaced: Math.max(0, maxTotal - placed),
             sheetCount: 1, usableW:usW, usableH:usH, effRes, cuttingFlow:true };
    if (fillSheet && !setsFirst && !settings._autoExpandQueueCap) out.unplaced = 0;   // the sheet is full, nothing is missing
    if (setsFirst) {
      const byId = new Map(partDefs.map(p => [p.id, 0]));
      for (const pl of allPl) byId.set(pl.partId, (byId.get(pl.partId) || 0) + 1);
      out.sets = { requested: copies, complete: Math.min(...byId.values()), partsPerSet: partDefs.length,
        perPart: partDefs.map(p => ({ id: p.id, name: p.name + (p._mustPairTag === 'mir' ? ' (mirrored)' : ''), placed: byId.get(p.id) })) };
      out.unplaced = Math.max(0, copies * partDefs.length - [...byId.values()].reduce((a, n) => a + Math.min(n, copies), 0));
    }
    return out;
  }
};



