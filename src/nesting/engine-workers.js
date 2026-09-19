/*
 * NestForge Pro — worker pool for the nesting engines
 *
 * Runs independent engine jobs on Web Workers, one per spare CPU thread, so
 * work that used to happen one job after another happens at once. Used by
 *   - flow-strategies.js  (the 16 Cutting Flow layouts)
 *   - poly-engine.js      (the 6 polygon-engine passes of a sheet)
 *
 * WHY THIS CANNOT CHANGE A RESULT
 * A job is only ever a deterministic piece of engine work: no randomness, no
 * wall-clock limits (every limit in the engines is a count), and no shared
 * state - each worker holds its own engine. So a job's answer does not depend
 * on when or where it runs, and the caller combines the answers in the same
 * order, with the same rules, as the one-after-another code it replaces.
 *
 * The workers run the same engine code as the page, read straight from it:
 * the inline blocks of the built single file, or the src/ files index.html
 * loads during development (fetch() cannot read file://, so a dev page opened
 * from disk falls back to running jobs one by one - same result, slower).
 *
 * EngineWorkers.mode: 'auto' (parallel, else fall back), 'sequential',
 * 'parallel' (never fall back; throw instead).
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. It is not itself loaded into the workers.
 */

const EngineWorkers = (() => {
  // The engine-side modules a worker needs, in load order. None touches the page.
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

  // What each worker runs once the engine modules are loaded into it.
  // A job is { id, kind, ...args }. Kinds:
  //   flowSingle  { engine: 'raster'|'poly', partDefs, settings }
  //   nestPass    { partDefs, settings }   settings carries _singlePass
  const WORKER_MAIN = `
self.onmessage = async (e) => {
  const job = e.data;
  const progress = (pct) => self.postMessage({ id: job.id, type: 'progress', pct: pct });
  try {
    let result;
    if (job.kind === 'flowSingle') {
      const engine = job.engine === 'poly' ? PolyNestEngine : NestEngineRaster;
      result = await engine._flowNestSingle(job.partDefs, job.settings, progress, () => false, () => {});
    } else if (job.kind === 'nestPass') {
      result = await PolyNestEngine.nest(job.partDefs, job.settings, progress, () => false, () => {});
    } else {
      throw new Error('unknown job kind ' + job.kind);
    }
    self.postMessage({ id: job.id, type: 'done', result: result });
  } catch (err) {
    self.postMessage({ id: job.id, type: 'error', message: String((err && err.message) || err) });
  }
};
self.postMessage({ type: 'ready',
  ok: typeof NestEngineRaster !== 'undefined' && typeof PolyNestEngine !== 'undefined'
      && typeof ClipperLib !== 'undefined' });
`;

  let sourcePromise = null;

  async function collectEngineSource() {
    const chunks = [];
    for (const s of Array.from(document.scripts)) {
      const src = s.getAttribute('src');
      if (src) {
        if (!WORKER_MODULES.has(src)) continue;
        const res = await fetch(s.src);      // fails on file:// - caught by the caller
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

  async function workerUrl() {
    if (!sourcePromise) sourcePromise = collectEngineSource();
    let chunks;
    try { chunks = await sourcePromise; } catch (e) { sourcePromise = null; throw e; }
    const source =
      'self.window = self;\n' +              // clipper-global.js reads window.ClipperLib
      chunks.join('\n;\n') + '\n;\n' +
      // sleep() only yields to the screen, and a worker has none. A microtask
      // avoids the ~4 ms timer clamp per yield. Timing only, never results.
      'try { sleep = () => Promise.resolve(); } catch (_) {}\n' +
      WORKER_MAIN;
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  }

  function available() {
    return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof document !== 'undefined';
  }

  function threads() {
    return Math.max(1, (navigator.hardwareConcurrency || 4) - 1);   // leave one for the page
  }

  // Run `jobs` (array of job objects, each given an id = its index) across up
  // to `threads()` workers. Resolves to an array of results by job index; a job
  // that returned nothing is null. `onProgress(fractionDone, text)`.
  // Cancel stops every worker; results already finished are still returned.
  async function run(jobs, onProgress, isCancelled, label) {
    if (!available()) throw new Error('this browser has no Web Workers');
    const url = await workerUrl();
    const total = jobs.length;
    const n = Math.min(total, threads());
    const results = new Array(total);
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
        if (onProgress) onProgress(sum / total,
          `${finished} of ${total} ${label || 'jobs'} done, ${Math.min(n, total - finished)} running in parallel`);
      };
      const give = (w) => {
        if (nextJob >= total) return;
        const i = nextJob++;
        try { w.postMessage(Object.assign({ id: i }, jobs[i])); }
        catch (err) { finish(reject, err); }   // something in the job cannot be copied to a worker
      };
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

  return { mode: 'auto', available, threads, run };
})();
