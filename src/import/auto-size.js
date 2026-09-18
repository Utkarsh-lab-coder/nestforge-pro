/*
 * NestForge Pro — AutoSize — auto-detect and validate sheet dimensions
 *
 * Original location: lines 16283..16375 of nestforge-pro.html (93 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const AutoSize = {

  /* ── AUTO-SIZE SHEET MODAL ─────────────────────────────────────── */
  _autoSizeData: null,
  _isAutoSizeRun: false,
  _fillSheetMode: false,

  _showAutoSizeModal(placed, total, settings) {
    this._autoSizeData = { placed, total, settings };
    document.getElementById('as-placed').textContent = placed;
    document.getElementById('as-total').textContent = total;
    document.getElementById('as-cur-size').textContent = `${settings.sheetW}×${settings.sheetH}mm`;
    document.getElementById('as-dim-val').value = settings.sheetW;
    this._updateAutoSizeLabels();
    this._updateAutoSizeEstimate();
    document.getElementById('autosize-modal').classList.add('active');
  },

  _updateAutoSizeLabels() {
    const lock = document.getElementById('as-lock-dim').value;
    if (lock === 'width') {
      document.getElementById('as-dim-label').textContent = 'Width (mm)';
      document.getElementById('as-auto-label').textContent = 'Auto Height (mm)';
      document.getElementById('as-dim-val').value = this._autoSizeData?.settings.sheetW || 1200;
    } else {
      document.getElementById('as-dim-label').textContent = 'Height (mm)';
      document.getElementById('as-auto-label').textContent = 'Auto Width (mm)';
      document.getElementById('as-dim-val').value = this._autoSizeData?.settings.sheetH || 600;
    }
    this._updateAutoSizeEstimate();
  },

  _updateAutoSizeEstimate() {
    if (!this._autoSizeData) return;
    const { total, settings } = this._autoSizeData;
    const lock = document.getElementById('as-lock-dim').value;
    const fixedDim = parseFloat(document.getElementById('as-dim-val').value) || 500;
    const margin = settings.margin;
    const gap = settings.gap;

    // Estimate needed area: sum of all part areas × copies, divided by ~65% utilization estimate
    const totalPartArea = this.parts.reduce((s, p) => s + polyArea(p.pts), 0);
    const copies = parseInt(document.getElementById('s-copies').value) || 1;
    const neededArea = totalPartArea * copies / 0.60; // assume ~60% utilization

    const usableFixed = fixedDim - 2 * margin;
    const neededOther = Math.ceil(neededArea / usableFixed) + 2 * margin;
    // Minimum: at least as big as the largest part
    const maxPartDim = this.parts.reduce((m, p) => {
      const bb = polyBBox(p.pts);
      return Math.max(m, lock === 'width' ? bb.h : bb.w);
    }, 0);
    const autoDim = Math.max(Math.ceil(maxPartDim + 2 * margin), Math.ceil(neededOther));

    document.getElementById('as-auto-val').value = autoDim;
  },

  cancelAutoSize() {
    document.getElementById('autosize-modal').classList.remove('active');
    this._autoSizeData = null;
    document.getElementById('nest-status').textContent = 'Ready';
  },

  confirmAutoSize() {
    const lock = document.getElementById('as-lock-dim').value;
    const fixedDim = parseFloat(document.getElementById('as-dim-val').value) || 1200;
    const autoDim = parseFloat(document.getElementById('as-auto-val').value) || 600;

    let newW, newH;
    if (lock === 'width') {
      newW = fixedDim;
      newH = autoDim;
    } else {
      newW = autoDim;
      newH = fixedDim;
    }

    // Update the sheet size inputs in the UI
    document.getElementById('s-width').value = Math.round(newW);
    document.getElementById('s-height').value = Math.round(newH);
    Renderer.sheetW = newW;
    Renderer.sheetH = newH;

    document.getElementById('autosize-modal').classList.remove('active');
    this._autoSizeData = null;

    // Re-run nesting with flag so it doesn't re-trigger auto-size
    this._isAutoSizeRun = true;
    this.runNesting();
  },
};



