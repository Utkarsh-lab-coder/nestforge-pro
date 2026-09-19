/*
 * NestForge Pro — Cutting Flow lane search, shared by both engines
 *
 * The lane direction the user picks is a promise: "Vertical lanes (90° ↔
 * 270°)" means vertical lanes with parts alternating 90° and 270°, exactly
 * as the Lane Preview shows. That one layout is what runs. The "Auto"
 * direction keeps the wider search: sixteen lane layouts, eight angles
 * across horizontal and vertical lanes, keeping the fullest (most parts
 * placed, then the smaller used height, then whichever comes first).
 *
 * Multi-sheet: the flow engine lays out one sheet. With "more sheets if
 * parts overflow" on, run() lays out sheet after sheet, each getting what
 * is still wanted of every part, until everything is placed or a sheet
 * takes nothing.
 *
 * This replaces two identical copies of the search that used to live in
 * raster-engine.js and poly-engine.js. Both engines' flowNest() call
 * FlowStrategies.run().
 *
 * The layouts of an Auto search run in parallel through EngineWorkers. Each
 * layout is a full, independent, deterministic run of the engine's
 * _flowNestSingle() - no randomness, no wall-clock limit, no shared state -
 * so it gives the same answer however many others run beside it, and picking
 * the winner in list order with the original comparison reproduces the
 * one-by-one result exactly. If workers cannot be used, the one-by-one loop
 * runs.
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system.
 */

const FlowStrategies = (() => {
  const BASE_ANGLES = [0, 30, 45, 60, 90, 120, 135, 150];

  // Order matters: an exact tie keeps the earlier layout.
  const STRATEGIES = [];
  for (const ang of BASE_ANGLES) {
    STRATEGIES.push({ flowDir: 'horizontal', rotA: ang, rotB: (ang + 180) % 360, label: 'H-lanes ' + ang + '°' });
    STRATEGIES.push({ flowDir: 'vertical',   rotA: ang, rotB: (ang + 180) % 360, label: 'V-lanes ' + ang + '°' });
  }

  // The layouts a run tries. A chosen direction is followed exactly: the
  // one layout the Lane Preview promises (horizontal 0° ↔ 180°, vertical
  // 90° ↔ 270°). 'auto' tries all sixteen.
  function strategiesFor(settings) {
    if (settings.flowDir === 'auto') return STRATEGIES.slice();
    const dir = settings.flowDir === 'vertical' ? 'vertical' : 'horizontal';
    const rotA = dir === 'vertical' ? 90 : 0;
    return STRATEGIES.filter(s => s.flowDir === dir && s.rotA === rotA);
  }

  const settingsFor = (settings, s) => Object.assign({}, settings, {
    flowDir: s.flowDir, _flowRotA: s.rotA, _flowRotB: s.rotB, _flowSwapAB: false,
  });

  // The original comparison: more parts placed wins, then the smaller used
  // height. Strict, so an exact tie keeps the earlier layout. When the run
  // is copies-as-sets (result.sets), complete sets come first.
  const setsOf = (r) => (r.sets ? r.sets.complete : 0);
  const isBetter = (r, best) => !best
    || setsOf(r) > setsOf(best)
    || (setsOf(r) === setsOf(best) && r.placed > best.placed)
    || (setsOf(r) === setsOf(best) && r.placed === best.placed && r.usableH < best.usableH);

  function pickBest(strategies, results, tag) {
    let best = null, bestLabel = '';
    for (let i = 0; i < strategies.length; i++) {
      const r = results[i];
      if (!r) continue;
      if (isBetter(r, best)) { best = r; bestLabel = strategies[i].label; }
      console.log(`[CuttingFlow${tag} strategy] ${strategies[i].label}: placed=${r.placed}` + (r.sets ? `, sets=${r.sets.complete}/${r.sets.requested}` : ''));
    }
    return { best, bestLabel };
  }

  // One by one: the original loop.
  async function runSequential(engine, strategies, partDefs, settings, onProgress, isCancelled) {
    const results = new Array(strategies.length);
    for (let si = 0; si < strategies.length; si++) {
      const strat = strategies[si];
      if (isCancelled && isCancelled()) break;
      const wrapProg = (pct, msg) =>
        onProgress((si + Math.min(pct, 1)) / strategies.length, `${strat.label} — ${msg}`);
      const result = await engine._flowNestSingle(partDefs, settingsFor(settings, strat), wrapProg, isCancelled, () => {});
      if (isCancelled && isCancelled()) break;   // a cancelled layout is partial; drop it
      results[si] = result;
    }
    return results;
  }

  async function runParallel(engine, strategies, partDefs, settings, onProgress, isCancelled) {
    const which = engine === PolyNestEngine ? 'poly' : 'raster';
    const jobs = strategies.map(s => ({ kind: 'flowSingle', engine: which, partDefs, settings: settingsFor(settings, s) }));
    return EngineWorkers.run(jobs, onProgress, isCancelled, 'layouts');
  }

  // One sheet: the chosen layout(s), best kept.
  async function runSheet(engine, partDefs, settings, onProgress, isCancelled) {
    const tag = engine === PolyNestEngine ? ' polygon' : '';
    const strategies = strategiesFor(settings);
    const t0 = performance.now();
    let results = null, how = 'one by one';
    const mode = (typeof EngineWorkers !== 'undefined') ? EngineWorkers.mode : 'sequential';

    // A single layout runs right here: starting a worker costs more than
    // the layout itself, and the live preview gets it as it lands.
    if (strategies.length > 1 && mode !== 'sequential') {
      try {
        results = await runParallel(engine, strategies, partDefs, settings, onProgress, isCancelled);
        how = 'in parallel on ' + Math.min(strategies.length, EngineWorkers.threads()) + ' workers';
      } catch (err) {
        if (mode === 'parallel') throw err;
        console.warn('[CuttingFlow] parallel run not available (' + ((err && err.message) || err) +
          '), running the layouts one by one');
      }
    }
    if (!results) results = await runSequential(engine, strategies, partDefs, settings, onProgress, isCancelled);

    const { best, bestLabel } = pickBest(strategies, results, tag);
    console.log(`[CuttingFlow${tag}] ${strategies.length} layout(s) ${how} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    if (best) console.log(`[CuttingFlow${tag}] ${strategies.length > 1 ? 'winner: ' : 'layout: '}${bestLabel} with ${best.placed} placed`);
    return best;
  }

  async function run(engine, partDefs, settings, onProgress, isCancelled, onPlacement) {
    const emit = (placements, sheetIdx) => {
      if (!onPlacement || !placements) return;
      for (let i = 0; i < placements.length; i++) {
        try { onPlacement({ placement: placements[i], totalPlaced: i + 1, sheetIdx }); } catch (_) {}
      }
    };

    // One sheet: fill mode saturates it; without overflow the rest stays
    // unplaced (the app then grows the sheet, as for the other engine).
    const overflow = !!settings.multiSheet && !settings.fillSheet;
    if (!overflow) {
      const best = await runSheet(engine, partDefs, settings, onProgress, isCancelled);
      if (best) emit(best.placements, 0);
      return best;
    }

    // Sheet after sheet. Each sheet gets what is still wanted of every part;
    // a part that no longer needs copies is left out of the next sheet.
    const wanted = settings._autoExpandQueueCap || settings.copies || 1;
    const remaining = new Map(partDefs.map(p => [p.id, wanted]));
    const MAX_SHEETS = 50;
    const all = [], sheets = [];
    let first = null;
    for (let si = 0; si < MAX_SHEETS; si++) {
      if (isCancelled && isCancelled()) break;
      const defs = partDefs.filter(p => remaining.get(p.id) > 0);
      if (!defs.length) break;
      const left = {};
      for (const p of defs) left[p.id] = remaining.get(p.id);
      const s = Object.assign({}, settings, { _remainingById: left });
      const prog = (pct, msg) => onProgress(pct, `Sheet ${si + 1}: ${msg}`);
      const r = await runSheet(engine, defs, s, prog, isCancelled);
      if (!r || !r.placed) break;
      if (!first) first = r;
      for (const pl of r.placements) {
        pl.sheet = si;
        remaining.set(pl.partId, (remaining.get(pl.partId) || 0) - 1);
        all.push(pl);
      }
      sheets.push({ idx: si, placements: r.placements });
      emit(r.placements, si);
    }
    let unplaced = 0;
    for (const n of remaining.values()) if (n > 0) unplaced += n;
    if (!sheets.length) sheets.push({ idx: 0, placements: [] });
    console.log(`[CuttingFlow] ${all.length} placed on ${sheets.length} sheet(s), ${unplaced} unplaced`);
    return {
      placements: all, sheets, placed: all.length, unplaced,
      sheetCount: sheets.length,
      usableW: first ? first.usableW : settings.sheetW - 2 * settings.margin,
      usableH: first ? first.usableH : settings.sheetH - 2 * settings.margin,
      effRes: first ? first.effRes : 'polygon', cuttingFlow: true,
    };
  }

  return { run, STRATEGIES, strategiesFor };
})();
