/*
 * NestForge Pro — Cutting Flow lane search, shared by both engines
 *
 * The lane direction the user picks is a promise: "Vertical lanes (90° ↔
 * 270°)" means vertical lanes with parts at 90° and 270°, exactly as the
 * Lane Preview shows. Within that promise there are still several ways to
 * sequence the lanes, and which one packs best depends on the shape:
 * alternate the two rotations along a row or give whole rows one rotation,
 * let a part tuck into the cavity of the one before it or not, start every
 * other row half a part in so cups interlock. So a run tries every lane
 * sequence for the chosen direction (28 layouts, all of them lanes, all
 * with the promised rotations) and keeps the fullest: most complete sets,
 * then most parts placed, then the smaller used height, then whichever
 * comes first. The "Auto" direction widens this to eight angles across
 * horizontal and vertical lanes, with the six most distinct sequences each.
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

  // Lane sequences: how the two rotations A (rotA) and B (rotB) are dealt
  // out along and across the rows, whether the cursor advances a full part
  // or half (so the next part can tuck into the cavity of the one before),
  // and whether odd rows start half a part in. The first entry is the
  // original layout, so an exact tie keeps the old behaviour.
  const SEQS = [
    { seq: 'alt-flip',  name: 'A/B alternating, rows staggered' },
    { seq: 'alt',       name: 'A/B alternating' },
    { seq: 'rows',      name: 'rows of A then rows of B' },
    { seq: 'rows-flip', name: 'rows of B then rows of A' },
    { seq: 'same-A',    name: 'all A' },
    { seq: 'same-B',    name: 'all B' },
    { seq: 'tight',     name: 'tightest of A/B at each place' },
  ];
  const SEQUENCES = [];
  for (const q of SEQS) {
    for (const advance of ['full', 'half']) {
      for (const offset of [0, 0.5]) {
        SEQUENCES.push({ seq: q.seq, advance, offset,
          name: q.name + (advance === 'half' ? ', tucked' : '') + (offset ? ', offset rows' : '') });
      }
    }
  }
  // For the sixteen-angle Auto search: the six most distinct sequences.
  const AUTO_SEQUENCES = SEQUENCES.filter(q => q.offset === 0 && ['alt-flip', 'rows', 'tight'].includes(q.seq));

  const withSeq = (dir, q) => Object.assign({}, dir, q, {
    label: dir.label + ' · ' + q.name.replace(/\bA\b/g, dir.rotA + '°').replace(/\bB\b/g, dir.rotB + '°'),
  });

  // The layouts a run tries. A chosen direction is followed exactly (the
  // one the Lane Preview promises: horizontal 0° ↔ 180°, vertical 90° ↔
  // 270°), in every lane sequence. 'auto' tries all sixteen directions.
  function strategiesFor(settings) {
    if (settings.flowDir === 'auto') {
      const out = [];
      for (const dir of STRATEGIES) for (const q of AUTO_SEQUENCES) out.push(withSeq(dir, q));
      return out;
    }
    const dir = settings.flowDir === 'vertical' ? 'vertical' : 'horizontal';
    const rotA = dir === 'vertical' ? 90 : 0;
    const base = STRATEGIES.find(s => s.flowDir === dir && s.rotA === rotA);
    return SEQUENCES.map(q => withSeq(base, q));
  }

  const settingsFor = (settings, s) => Object.assign({}, settings, {
    flowDir: s.flowDir, _flowRotA: s.rotA, _flowRotB: s.rotB, _flowSwapAB: false,
    _flowSeq: s.seq || 'alt-flip', _flowAdvance: s.advance || 'full', _flowOffset: s.offset || 0,
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
    if (best) {
      best.flowLabel = bestLabel;
      console.log(`[CuttingFlow${tag}] winner: ${bestLabel} with ${best.placed} placed`);
    }
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
      flowLabel: first ? first.flowLabel : undefined,
    };
  }

  return { run, STRATEGIES, SEQUENCES, strategiesFor };
})();
