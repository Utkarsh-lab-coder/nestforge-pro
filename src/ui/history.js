/*
 * NestForge Pro — Undo / redo
 *
 * Every operation that changes the work is undoable: importing or
 * removing parts, quantities, renames, flips, sheet type, hide outline and
 * defects, every kind of nesting run, moving / rotating / duplicating /
 * deleting / replacing a placed part, worksheet changes, opening a project.
 * Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes; the ↶ ↷ buttons in the
 * header do the same and their tooltips name the step.
 *
 * How: before an operation runs, the whole project state is snapshotted
 * with the same serializer Save Project uses (worksheets, parts, results,
 * rules, hide, defects, zones) plus every settings control on the right
 * panel, and pushed on the undo stack. Undo restores a snapshot through
 * _loadProject, keeping the current zoom and pan. Operations that turn out
 * to change nothing (an import that was cancelled, a click that did not
 * move a part) leave no step: a snapshot identical to the current state is
 * dropped when undo reaches it.
 *
 * The operations are wrapped by name in History.install(), so the app's
 * own methods stay untouched.
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. It must come after app.js (it wraps App's methods) and runs
 * install() on DOMContentLoaded.
 */

const History = {
  undoStack: [],
  redoStack: [],
  LIMIT: 60,
  _busy: false,        // true while restoring: wrapped methods must not record

  // Operation → step name shown in the tooltip. Methods are looked up on
  // App at install time; a missing one is skipped.
  OPS: [
    ['loadFiles',                    'import parts'],
    ['_loadProject',                 'open project'],
    ['renamePart',                   'rename part'],
    ['flipPart',                     'flip part'],
    ['changeQty',                    'change quantity'],
    ['removePart',                   'remove part'],
    ['clearAll',                     'clear all'],
    ['_onSheetTypeChange',           'change sheet type'],
    ['_onLeatherGradeChange',        'change leather grade'],
    ['_onLeatherDimChange',          'change hide size'],
    ['_regenerateDefects',           'regenerate defects'],
    ['_onDefectClick',               'edit defect'],
    ['_importCustomSheet',           'import custom sheet'],
    ['confirmAutoSize',              'auto-size sheet'],
    ['_runNestingProceed',           'nest'],
    ['runAdvancedNesting',           'advanced nesting'],
    ['tryImprove',                   'improve'],
    ['_beginPlacementDrag',          'move part'],
    ['_duplicatePlacement',          'duplicate part'],
    ['flipSelectedPlacement',        'flip placed part'],
    ['replaceDeleteSelected',        'delete placed part'],
    ['_performReplacement',          'replace part'],
    ['addWorksheet',                 'add sheet'],
    ['removeWorksheet',              'remove sheet'],
    ['mergeSelectedSheets',          'merge sheets'],
  ],

  install() {
    for (const [name, label] of this.OPS) {
      const orig = App[name];
      if (typeof orig !== 'function') continue;
      App[name] = function (...args) {
        // A duplicate-drag records once, as "duplicate part"
        if (!(name === '_beginPlacementDrag' && args[2])) History.record(label);
        return orig.apply(this, args);
      };
    }
    // An import is one step however many files it has: the step is taken
    // when the files arrive (loadFiles), and nothing records while the
    // import's own sheet creation and per-file confirmations run.
    if (typeof App._chooseSheet === 'function') {
      const orig = App._chooseSheet;
      App._chooseSheet = function (...args) {
        History._inImport = true;
        try { return orig.apply(this, args); } finally { History._inImport = false; }
      };
    }
    // Norm Calculator "Apply to Canvas" lives in its own module
    if (typeof LeatherNorm !== 'undefined' && typeof LeatherNorm.applyToCanvas === 'function') {
      const orig = LeatherNorm.applyToCanvas;
      LeatherNorm.applyToCanvas = function (...args) { History.record('apply norm sheet'); return orig.apply(this, args); };
    }
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
    });
    this._updateButtons();
  },

  // ── snapshots ─────────────────────────────────────────────────────────
  // Everything Save Project writes, plus the live settings controls and a
  // few view-independent bits of state the serializer leaves out.
  snapshot() {
    const payload = App._buildProjectPayload();
    const controls = {};
    for (const el of document.querySelectorAll('#right-panel input[id], #right-panel select[id]')) {
      controls[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? !!el.checked : el.value;
    }
    return structuredClone({
      payload, controls,
      rulesMode: App._rulesMode || null,
      sheetSetByNormCalc: !!App._sheetSetByNormCalc,
      normCalcDecoration: Renderer.normCalcDecoration || null,
      currentSheet: Renderer.currentSheet || 0,
      fillSheetMode: !!App._fillSheetMode,
    });
  },

  // Two snapshots are the same work if their serializations match; the
  // save timestamp is left out of the comparison.
  _key(snap) {
    const p = Object.assign({}, snap.payload, { __savedAt: null });
    return JSON.stringify(Object.assign({}, snap, { payload: p }));
  },

  // True while an import is still being confirmed file by file.
  importInProgress() {
    return !!(this._inImport || App._pendingFiles || App._pendingImport
      || (App._importQueue && App._importQueue.length)
      || (App._worksheets && App._worksheets.some(ws => ws._pendingImportFile)));
  },

  record(label) {
    if (this._busy || this.importInProgress()) return;
    try {
      this.undoStack.push({ label, snap: this.snapshot() });
      if (this.undoStack.length > this.LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this._updateButtons();
    } catch (e) {
      console.warn('[History] snapshot failed, step not recorded:', e);
    }
  },

  restore(snap) {
    this._busy = true;
    const view = { zoom: Renderer.zoom, offsetX: Renderer.offsetX, offsetY: Renderer.offsetY };
    try {
      if (typeof App.replaceCancelSelection === 'function') App.replaceCancelSelection();
      if (typeof Measure !== 'undefined') { Measure.pending = null; Measure.hover = null; }
      App._loadProject(structuredClone(snap.payload));
      // Every settings control, restored silently (no change events: those
      // would regenerate outlines and defects), then the bits of UI that
      // depend on them.
      for (const [id, v] of Object.entries(snap.controls || {})) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v; else el.value = v;
      }
      const flowOn = document.getElementById('flow-enable').checked;
      document.getElementById('flow-options').style.display = flowOn ? 'block' : 'none';
      document.getElementById('btn-flow').classList.toggle('flow-on', flowOn);
      App._updateFlowPills && App._updateFlowPills();
      const st = document.getElementById('s-sheet-type');
      if (st) {
        const isLeather = st.value !== 'rectangle' && st.value !== 'custom';
        const isCustom = st.value === 'custom';
        const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
        show('leather-grade-row', isLeather);
        show('leather-defect-row', isLeather || isCustom);
        show('leather-custom-row', isCustom);
        show('leather-zones-row', isLeather);
      }
      App._rulesMode = snap.rulesMode || null;
      App._sheetSetByNormCalc = !!snap.sheetSetByNormCalc;
      App._fillSheetMode = !!snap.fillSheetMode;
      Renderer.normCalcDecoration = snap.normCalcDecoration || null;
      Renderer.currentSheet = snap.currentSheet || 0;
      // Sheet size from the restored controls (the project payload only
      // carries it in mm; the controls are in the display unit).
      const u = App._unitToMM ? App._unitToMM() : 1;
      Renderer.sheetW = (parseFloat(document.getElementById('s-width').value) || Renderer.sheetW / u) * u;
      Renderer.sheetH = (parseFloat(document.getElementById('s-height').value) || Renderer.sheetH / u) * u;
      App._refreshAreaDisplay && App._refreshAreaDisplay();
      App.updateUI && App.updateUI();
      if (App.nestResult && App.nestResult.sheets) App.renderSheetTabs(App.nestResult.sheets);
    } finally {
      Renderer.zoom = view.zoom; Renderer.offsetX = view.offsetX; Renderer.offsetY = view.offsetY;
      const zv = document.getElementById('zoom-val'); if (zv) zv.textContent = Math.round(view.zoom * 100) + '%';
      Renderer.draw();
      this._busy = false;
    }
  },

  undo() {
    if (!this.undoStack.length) return false;
    const now = this.snapshot();
    const nowKey = this._key(now);
    // Drop steps that changed nothing
    let step = null;
    while (this.undoStack.length) {
      const s = this.undoStack.pop();
      if (this._key(s.snap) !== nowKey) { step = s; break; }
    }
    if (!step) { this._updateButtons(); return false; }
    this.redoStack.push({ label: step.label, snap: now });
    this.restore(step.snap);
    this._status('Undid: ' + step.label);
    this._updateButtons();
    return true;
  },

  redo() {
    if (!this.redoStack.length) return false;
    const step = this.redoStack.pop();
    this.undoStack.push({ label: step.label, snap: this.snapshot() });
    this.restore(step.snap);
    this._status('Redid: ' + step.label);
    this._updateButtons();
    return true;
  },

  _status(msg) {
    const el = document.getElementById('nest-status');
    if (el) el.textContent = msg;
  },

  _updateButtons() {
    const u = document.getElementById('btn-undo'), r = document.getElementById('btn-redo');
    if (u) {
      u.disabled = !this.undoStack.length;
      u.title = this.undoStack.length ? 'Undo: ' + this.undoStack[this.undoStack.length - 1].label + ' (Ctrl+Z)' : 'Nothing to undo (Ctrl+Z)';
    }
    if (r) {
      r.disabled = !this.redoStack.length;
      r.title = this.redoStack.length ? 'Redo: ' + this.redoStack[this.redoStack.length - 1].label + ' (Ctrl+Y)' : 'Nothing to redo (Ctrl+Y)';
    }
  },
};

document.addEventListener('DOMContentLoaded', () => History.install());
