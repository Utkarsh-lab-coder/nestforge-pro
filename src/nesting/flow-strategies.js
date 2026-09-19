/*
 * NestForge Pro — Cutting Flow multi-strategy search, shared by both engines
 *
 * Tries sixteen lane layouts, eight angles across horizontal and vertical
 * lanes, and keeps the best: the most parts placed, then the smaller used
 * height, then whichever comes first in the list.
 *
 * This replaces two identical copies of the search that used to live in
 * raster-engine.js and poly-engine.js. Both engines' flowNest() now call
 * FlowStrategies.run().
 *
 * The layouts run in parallel through EngineWorkers. Each layout is a full,
 * independent, deterministic run of the engine's _flowNestSingle() - no
 * randomness, no wall-clock limit, no shared state - so it gives the same
 * answer however many others run beside it, and picking the winner in list
 * order with the original comparison reproduces the one-by-one result
 * exactly. If workers cannot be used, the original one-by-one loop runs.
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

  const settingsFor = (settings, s) => Object.assign({}, settings, {
    flowDir: s.flowDir, _flowRotA: s.rotA, _flowRotB: s.rotB, _flowSwapAB: false,
  });

  // The original comparison: more parts placed wins, then the smaller used
  // height. Strict, so an exact tie keeps the earlier layout.
  const isBetter = (r, best) => !best
    || r.placed > best.placed
    || (r.placed === best.placed && r.usableH < best.usableH);

  function pickBest(results, tag) {
    let best = null, bestLabel = '';
    for (let i = 0; i < STRATEGIES.length; i++) {
      const r = results[i];
      if (!r) continue;
      if (isBetter(r, best)) { best = r; bestLabel = STRATEGIES[i].label; }
      console.log(`[CuttingFlow${tag} strategy] ${STRATEGIES[i].label}: placed=${r.placed}`);
    }
    return { best, bestLabel };
  }

  // One by one: the original loop.
  async function runSequential(engine, partDefs, settings, onProgress, isCancelled) {
    const results = new Array(STRATEGIES.length);
    for (let si = 0; si < STRATEGIES.length; si++) {
      const strat = STRATEGIES[si];
      if (isCancelled && isCancelled()) break;
      const wrapProg = (pct, msg) =>
        onProgress((si + Math.min(pct, 1)) / STRATEGIES.length, `${strat.label} — ${msg}`);
      const result = await engine._flowNestSingle(partDefs, settingsFor(settings, strat), wrapProg, isCancelled, () => {});
      if (isCancelled && isCancelled()) break;   // a cancelled layout is partial; drop it
      results[si] = result;
    }
    return results;
  }

  async function runParallel(engine, partDefs, settings, onProgress, isCancelled) {
    const which = engine === PolyNestEngine ? 'poly' : 'raster';
    const jobs = STRATEGIES.map(s => ({ kind: 'flowSingle', engine: which, partDefs, settings: settingsFor(settings, s) }));
    return EngineWorkers.run(jobs, onProgress, isCancelled, 'layouts');
  }

  async function run(engine, partDefs, settings, onProgress, isCancelled, onPlacement) {
    const tag = engine === PolyNestEngine ? ' polygon' : '';
    const t0 = performance.now();
    let results = null, how = 'one by one';
    const mode = (typeof EngineWorkers !== 'undefined') ? EngineWorkers.mode : 'sequential';

    if (mode !== 'sequential') {
      try {
        results = await runParallel(engine, partDefs, settings, onProgress, isCancelled);
        how = 'in parallel on ' + Math.min(STRATEGIES.length, EngineWorkers.threads()) + ' workers';
      } catch (err) {
        if (mode === 'parallel') throw err;
        console.warn('[CuttingFlow] parallel run not available (' + ((err && err.message) || err) +
          '), running the layouts one by one');
      }
    }
    if (!results) results = await runSequential(engine, partDefs, settings, onProgress, isCancelled);

    const { best, bestLabel } = pickBest(results, tag);
    console.log(`[CuttingFlow${tag}] ${STRATEGIES.length} layouts ${how} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    if (best) {
      console.log(`[CuttingFlow${tag}] winner: ${bestLabel} with ${best.placed} placed`);
      if (onPlacement && best.placements) {
        for (let i = 0; i < best.placements.length; i++) {
          try { onPlacement({ placement: best.placements[i], totalPlaced: i + 1, sheetIdx: best.placements[i].sheet || 0 }); } catch (_) {}
        }
      }
    }
    return best;
  }

  return { run, STRATEGIES };
})();
