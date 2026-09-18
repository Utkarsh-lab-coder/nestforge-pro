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
 * WHY IT CAN RUN IN PARALLEL WITH NO CHANGE IN RESULT
 * Each layout is a full, independent run of the engine's _flowNestSingle().
 * That run is deterministic: it uses no randomness and has no time limit
 * (its only timing code yields to the screen every 40 ms and never cuts the
 * work short), and it writes to no shared state - not the engine, not the
 * part list, not the settings. So a layout gives the same answer however
 * many others run beside it, and picking the winner in list order with the
 * original comparison reproduces the one-by-one result exactly.
 *
 * Layouts therefore run in Web Workers, one per spare CPU thread. If
 * workers cannot be used for any reason, the original one-by-one loop runs
 * instead, so the worst case is exactly the old behaviour.
 *
 * FlowStrategies.mode:
 *   'auto'        parallel, falling back to one by one (default)
 *   'sequential'  always one by one
 *   'parallel'    parallel only; throw rather than fall back
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. It is not loaded into the workers; they only need the engines.
 */

const FlowStrategies = (() => {
  const BASE_ANGLES = [0, 30, 45, 60, 90, 120, 135, 150];

  // Order matters: an exact tie keeps the earlier layout.
  const STRATEGIES = [];
  for (const ang of BASE_ANGLES) {
    STRATEGIES.push({ flowDir: 'horizontal', rotA: ang, rotB: (ang + 180) % 360, label: 'H-lanes ' + ang + '°' });
    STRATEGIES.push({ flowDir: 'vertical',   rotA: ang, rotB: (ang + 180) % 360, label: 'V-lanes ' + ang + '°' });
  }

  // The engine-side modules a worker needs to run _flowNestSingle, in load
  // order. None of them touches the page.
  const WORKER_MODULES = new Set([
    'src/data/hide-data.js',
    'src/geometry/clipper-shim.js',
    'src/geometry/geo-utils.js',
    'src/geometry/poly-utils.js',
    'src/nesting/rasterizer.js',
    'src/nesting/raster-engine.js',
    'vendor/clipper.js',
    'src/geometry/clipper-global.js',
    'src/nesting/leather.js',
    'src/nesting/nfp.js',
    'src/nesting/poly-engine.js',
  ]);

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

  // ── One by one: the original loop ─────────────────────────────────────
  async function runSequential(engine, partDefs, settings, onProgress, isCancelled) {
    const results = new Array(STRATEGIES.length);
    for (let si = 0; si < STRATEGIES.length; si++) {
      const strat = STRATEGIES[si];
      if (isCancelled && isCancelled()) break;
      const wrapProg = (pct, msg) =>
        onProgress((si + Math.min(pct, 1)) / STRATEGIES.length, `${strat.label} — ${msg}`);
      // A quiet placement emitter, so the preview does not flicker between
      // layouts. Only the winner is replayed.
      const result = await engine._flowNestSingle(partDefs, settingsFor(settings, strat), wrapProg, isCancelled, () => {});
      if (isCancelled && isCancelled()) break;   // a cancelled layout is partial; drop it
      results[si] = result;
    }
    return results;
  }

  // ── In parallel ───────────────────────────────────────────────────────
  // What each worker runs once the engine modules are loaded into it.
  const WORKER_MAIN = `
self.onmessage = async (e) => {
  const job = e.data;
  const engine = job.engine === 'poly' ? PolyNestEngine : NestEngineRaster;
  try {
    const progress = (pct) => self.postMessage({ id: job.id, type: 'progress', pct });
    const result = await engine._flowNestSingle(job.partDefs, job.settings, progress, () => false, () => {});
    self.postMessage({ id: job.id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id: job.id, type: 'error', message: String((err && err.message) || err) });
  }
};
self.postMessage({ type: 'ready',
  ok: typeof NestEngineRaster !== 'undefined' && typeof PolyNestEngine !== 'undefined'
      && typeof ClipperLib !== 'undefined' });
`;

  let sourcePromise = null;

  // The workers run the same engine code as the page, read straight from it:
  // the inline blocks of the built single file, or the src/ files that
  // index.html loads during development.
  async function collectEngineSource() {
    const chunks = [];
    for (const s of Array.from(document.scripts)) {
      const src = s.getAttribute('src');
      if (src) {
        if (!WORKER_MODULES.has(src)) continue;
        const res = await fetch(s.src);     // fails on file:// - caught, falls back
        if (!res.ok) throw new Error('could not read ' + src);
        chunks.push(await res.text());
      } else {
        const m = /INLINED FROM (\S+)/.exec(s.textContent.slice(0, 300));
        if (m && WORKER_MODULES.has(m[1])) chunks.push(s.textContent);
      }
    }
    if (!chunks.length) throw new Error('nesting engine source not found on the page');
    return chunks;
  }

  function workerCount() {
    const threads = navigator.hardwareConcurrency || 4;
    return Math.max(1, Math.min(STRATEGIES.length, threads - 1));   // leave one for the page
  }

  async function runParallel(engine, partDefs, settings, onProgress, isCancelled) {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      throw new Error('this browser has no Web Workers');
    }
    if (!sourcePromise) sourcePromise = collectEngineSource();
    let chunks;
    try { chunks = await sourcePromise; } catch (e) { sourcePromise = null; throw e; }

    const source =
      'self.window = self;\n' +              // the engines read window.ClipperLib; a worker has only self
      chunks.join('\n;\n') + '\n;\n' +
      // sleep() only yields to the screen, and a worker has none. Making it a
      // microtask removes the ~4 ms timer clamp per yield. Timing only, never results.
      'try { sleep = () => Promise.resolve(); } catch (_) {}\n' +
      WORKER_MAIN;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

    const which = engine === PolyNestEngine ? 'poly' : 'raster';
    const total = STRATEGIES.length;
    const n = workerCount();
    const results = new Array(total);         // layout index -> result, null if the engine returned none
    const pct = new Array(total).fill(0);
    const workers = [];
    let nextJob = 0, finished = 0;

    return new Promise((resolve, reject) => {
      let settled = false, timer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        for (const w of workers) w.terminate();
        URL.revokeObjectURL(url);
        fn(value);
      };

      const report = () => {
        let sum = finished;
        for (let i = 0; i < total; i++) if (results[i] === undefined) sum += Math.min(pct[i], 1);
        onProgress(sum / total,
          `${finished} of ${total} layouts done, ${Math.min(n, total - finished)} running in parallel`);
      };

      const give = (w) => {
        if (nextJob >= total) return;
        const i = nextJob++;
        try {
          w.postMessage({ id: i, engine: which, partDefs, settings: settingsFor(settings, STRATEGIES[i]) });
        } catch (err) {           // something in the parts or settings cannot be copied to a worker
          finish(reject, err);
        }
      };

      // Cancelling stops every worker. As before, only layouts that finished count.
      timer = setInterval(() => { if (isCancelled && isCancelled()) finish(resolve, results); }, 100);

      for (let k = 0; k < n; k++) {
        let w;
        try { w = new Worker(url); } catch (err) { return finish(reject, err); }
        workers.push(w);
        w.onerror = (ev) => {
          if (ev && ev.preventDefault) ev.preventDefault();
          finish(reject, new Error('worker failed: ' + ((ev && ev.message) || 'could not start')));
        };
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') {
            if (!m.ok) return finish(reject, new Error('worker could not load the nesting engines'));
            return give(w);
          }
          if (m.type === 'progress') { pct[m.id] = m.pct; return report(); }
          if (m.type === 'error') return finish(reject, new Error(m.message));
          if (m.type === 'done') {
            results[m.id] = m.result || null;
            finished++;
            report();
            if (finished === total) return finish(resolve, results);
            give(w);
          }
        };
      }
    });
  }

  // ── Entry point, called by both engines' flowNest() ───────────────────
  async function run(engine, partDefs, settings, onProgress, isCancelled, onPlacement) {
    const tag = engine === PolyNestEngine ? ' polygon' : '';
    const t0 = performance.now();
    let results = null, how = 'one by one';

    if (api.mode !== 'sequential') {
      try {
        results = await runParallel(engine, partDefs, settings, onProgress, isCancelled);
        how = 'in parallel on ' + workerCount() + ' workers';
      } catch (err) {
        if (api.mode === 'parallel') throw err;
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

  const api = { mode: 'auto', run, STRATEGIES };
  return api;
})();
