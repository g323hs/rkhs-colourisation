// sketch.js — p5.js sketch for the interactive greyscale+points panel (b),
// plus all UI wiring for the colourisation webapp.

// ── Shared state ──────────────────────────────────────────────────────────────

const state = {
  W: 0, H: 0,
  greyFlat:    null,  // Uint8Array  W*H
  colourFlat:  null,  // Uint8Array  W*H*4
  points:      [],    // [{x, y, r, g, b}]
  tool:        'pick',
  method:      'random',
  mode:        'manual',   // 'manual' | 'automatic'
  p5cnv:       null,
  originalImg: null,
};

// Defaults for the master parameters (Automatic mode).
const MASTER_DEFAULTS = Object.freeze({
  p:        0.5,      // intensity kernel exponent
  delta:    2e-4,     // Tikhonov regularisation
  beta1:    0.95,     // sigma1 coverage confidence
  beta2:    0.95,     // sigma2 coverage confidence
  nFrac:    0.01,     // fraction of pixels sampled
  fillFrac: 0.02,     // greedy spatial fill share of n
  density:  3.0,      // edge/smooth density ratio
});

let recommendedScale = 0.25;
// Counter for user-uploaded images; populates "UPLOAD N" labels in the
// default-image dropdown so previous uploads stay selectable.
let uploadCounter = 0;

const TARGET_PIXELS = 160000;

function computeRecommendedScale(origW, origH) {
  const origPixels = origW * origH;
  if (origPixels <= TARGET_PIXELS) return 1.0;  const raw = Math.sqrt(TARGET_PIXELS / origPixels);
  const snapped = Math.max(0.05, Math.min(1.0, Math.round(raw / 0.05) * 0.05));
  // Clean up floating-point dust (e.g. 0.30000000000000004 → 0.3).
  return Math.round(snapped * 100) / 100;
}

function updateImgInfo() {
  const infoEl = document.getElementById('img-info');
  const warnEl = document.getElementById('img-scale-warn');
  if (!state.originalImg) { infoEl.innerHTML = ''; warnEl.classList.add('hidden'); return; }

  const oW = state.originalImg.naturalWidth;
  const oH = state.originalImg.naturalHeight;
  const scale = parseFloat(document.getElementById('img-scale').value) || 1;
  const sW = Math.max(1, Math.round(oW * scale));
  const sH = Math.max(1, Math.round(oH * scale));
  const fmt = n => n.toLocaleString();

  infoEl.innerHTML =
    `<span>Original: ${oW} &times; ${oH} = ${fmt(oW * oH)} px</span>` +
    `<span>Scaled &nbsp;: ${sW} &times; ${sH} = ${fmt(sW * sH)} px</span>`;

  if (Math.abs(scale - recommendedScale) > 0.001) {
    const rec = (+recommendedScale).toPrecision(2);
    warnEl.innerHTML =
      `<span>⚠ Recommended scale: ${rec}</span>` +
      `<button type="button" id="use-recommended-scale" class="warn-btn">Use</button>`;
    warnEl.classList.remove('hidden');
    document.getElementById('use-recommended-scale').addEventListener('click', () => {
      const sl = document.getElementById('img-scale');
      const nm = document.getElementById('img-scale-num');
      sl.value = recommendedScale;
      nm.value = recommendedScale;
      updateImgInfo();
      sl.dispatchEvent(new Event('change', { bubbles: true }));
    });
  } else {
    warnEl.classList.add('hidden');
  }
}

// ── Results state ─────────────────────────────────────────────────────────────

const results = [];
let selectedResultId = -1;
let sortKey = 'id';
let sortAsc = true;

// ── p5.js sketch ─────────────────────────────────────────────────────────────

function setup() {
  pixelDensity(1);
  const cnv = createCanvas(320, 240);
  cnv.parent('canvas-b-wrap');
  cnv.style('width', 'auto');
  cnv.style('height', 'auto');
  cnv.style('max-width', '100%');
  cnv.style('max-height', '320px');
  cnv.style('image-rendering', 'pixelated');
  state.p5cnv = cnv;
  noLoop();
}

function draw() {
  background(230);
  if (!state.greyFlat) {
    fill(160); noStroke();
    textAlign(CENTER, CENTER); textSize(13);
    text('Upload an image to begin', width / 2, height / 2);
    return;
  }

  const idata = new ImageData(state.W, state.H);
  for (let i = 0; i < state.W * state.H; i++) {
    const g = state.greyFlat[i];
    idata.data[i * 4]     = g;
    idata.data[i * 4 + 1] = g;
    idata.data[i * 4 + 2] = g;
    idata.data[i * 4 + 3] = 255;
  }
  drawingContext.putImageData(idata, 0, 0);

  drawDots();
}

function drawDots() {
  const dotCnv = document.getElementById('canvas-b-dots');
  const dpr    = window.devicePixelRatio || 1;
  const boxW   = dotCnv.clientWidth  || 0;
  const boxH   = dotCnv.clientHeight || 0;
  if (!boxW || !boxH) return;

  const needW = Math.round(boxW * dpr);
  const needH = Math.round(boxH * dpr);
  if (dotCnv.width !== needW || dotCnv.height !== needH) {
    dotCnv.width  = needW;
    dotCnv.height = needH;
  }

  const ctx = dotCnv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, boxH);

  // Compute where the greyscale image is rendered within the overlay box
  // (mirrors CSS object-fit: contain on the p5 canvas)
  const imgAspect = state.W / state.H;
  const boxAspect = boxW / boxH;
  let renderW, renderH, ox, oy;
  if (imgAspect >= boxAspect) {
    renderW = boxW; renderH = boxW / imgAspect;
    ox = 0; oy = (boxH - renderH) / 2;
  } else {
    renderH = boxH; renderW = boxH * imgAspect;
    ox = (boxW - renderW) / 2; oy = 0;
  }

  // User-mode selection border
  if (state.method === 'user') {
    ctx.strokeStyle = state.tool === 'pick' ? '#00b400' : '#c80000';
    ctx.lineWidth = 3;
    ctx.strokeRect(ox + 2, oy + 2, renderW - 4, renderH - 4);
  }

  const showPts = document.getElementById('show-points').checked;
  if (!state.greyFlat || !showPts) return;

  const scaleX = renderW / state.W;
  const scaleY = renderH / state.H;

  // Adaptive radius: shrinks as point count grows so greyscale remains visible.
  // Target: dots cover roughly 15% of image area at most.
  const n = state.points.length || 1;
  const pixelsPerDot = (renderW * renderH) / n;
  const maxR = Math.sqrt(pixelsPerDot * 0.15 / Math.PI);
  const R = Math.min(4.5, Math.max(1.2, maxR));

  // Fixed thin border widths regardless of R
  const blackW = 1.2;
  const ringW  = 1.0;

  for (const pt of state.points) {
    const x = ox + pt.x * scaleX;
    const y = oy + pt.y * scaleY;

    // 1. Black outer ring
    ctx.beginPath();
    ctx.arc(x, y, R + ringW + blackW * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = blackW;
    ctx.stroke();

    // 2. White ring inside the black one
    ctx.beginPath();
    ctx.arc(x, y, R + ringW * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = ringW;
    ctx.stroke();

    // 3. Coloured filled disc
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${pt.r},${pt.g},${pt.b})`;
    ctx.fill();
  }
}

function mouseToImageCoords() {
  const el   = state.p5cnv && state.p5cnv.elt;
  if (!el) return null;
  const boxW = el.clientWidth  || width;
  const boxH = el.clientHeight || height;

  // Convert p5 canvas logical coords → CSS pixel position within element
  const cssX = mouseX * boxW / state.W;
  const cssY = mouseY * boxH / state.H;

  // Compute object-fit: contain rendered image rect (mirrors drawDots)
  const imgAspect = state.W / state.H;
  const boxAspect = boxW / boxH;
  let renderW, renderH, ox, oy;
  if (imgAspect >= boxAspect) {
    renderW = boxW; renderH = boxW / imgAspect;
    ox = 0; oy = (boxH - renderH) / 2;
  } else {
    renderH = boxH; renderW = boxH * imgAspect;
    ox = (boxW - renderW) / 2; oy = 0;
  }

  // Reject clicks outside the rendered image area
  if (cssX < ox || cssX > ox + renderW || cssY < oy || cssY > oy + renderH) return null;

  return {
    x: Math.floor((cssX - ox) * state.W / renderW),
    y: Math.floor((cssY - oy) * state.H / renderH),
  };
}

function windowResized() {
  redraw();
}

function mouseClicked() {
  if (state.method !== 'user' || !state.greyFlat) return;
  const pos = mouseToImageCoords();
  if (!pos) return;

  const mx = Math.max(0, Math.min(state.W - 1, pos.x));
  const my = Math.max(0, Math.min(state.H - 1, pos.y));

  if (state.tool === 'pick') {
    const base = (my * state.W + mx) * 4;
    state.points.push({
      x: mx, y: my,
      r: state.colourFlat[base],
      g: state.colourFlat[base + 1],
      b: state.colourFlat[base + 2],
    });
  } else {
    let minDist = Infinity, minIdx = -1;
    for (let i = 0; i < state.points.length; i++) {
      const d = Math.hypot(state.points[i].x - mx, state.points[i].y - my);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    if (minIdx >= 0 && minDist < 12) state.points.splice(minIdx, 1);
  }
  redraw();
}

// ── Image loading ─────────────────────────────────────────────────────────────

function applyScale(img, preservePoints) {
  const scale = parseFloat(document.getElementById('img-scale').value) || 1;
  const W = Math.max(1, Math.round(img.naturalWidth  * scale));
  const H = Math.max(1, Math.round(img.naturalHeight * scale));

  // Preserve points across rescales: remap (x, y) by the W/H ratio change and
  // re-sample their colour from the freshly-scaled image.
  const oldW = state.W, oldH = state.H;
  const savedPts = preservePoints && oldW && oldH
    ? state.points.map(p => ({ x: p.x, y: p.y })) : null;

  const oc  = document.createElement('canvas');
  oc.width  = W; oc.height = H;
  const ctx = oc.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, W, H);
  const idata = ctx.getImageData(0, 0, W, H);

  state.W = W; state.H = H;
  state.colourFlat = new Uint8Array(idata.data.buffer.slice(0));
  state.greyFlat   = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const b = i * 4;
    state.greyFlat[i] = Math.round(
      0.2126 * idata.data[b] + 0.7152 * idata.data[b + 1] + 0.0722 * idata.data[b + 2]
    );
  }

  resizeCanvas(W, H);
  if (state.p5cnv) {
    state.p5cnv.style('width', '100%');
    state.p5cnv.style('height', '100%');
    state.p5cnv.style('max-width', '');
    state.p5cnv.style('max-height', '');
  }
  if (savedPts) {
    const sx = W / oldW, sy = H / oldH;
    state.points = savedPts.map(p => {
      const nx = Math.max(0, Math.min(W - 1, Math.round(p.x * sx)));
      const ny = Math.max(0, Math.min(H - 1, Math.round(p.y * sy)));
      const base = (ny * W + nx) * 4;
      return {
        x: nx, y: ny,
        r: state.colourFlat[base],
        g: state.colourFlat[base + 1],
        b: state.colourFlat[base + 2],
      };
    });
  } else {
    state.points = [];
  }
  document.getElementById('metric-frob').textContent = '—';
  document.getElementById('metric-ssim').textContent = '—';

  const canvA = document.getElementById('canvas-a');
  canvA.width  = W; canvA.height = H;
  canvA.getContext('2d').drawImage(img, 0, 0, W, H);

  // Draw pure greyscale for the pipeline panel
  const canvGrey = document.getElementById('canvas-grey');
  canvGrey.width = W; canvGrey.height = H;
  const greyRGBA = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = state.greyFlat[i];
    greyRGBA[i*4] = greyRGBA[i*4+1] = greyRGBA[i*4+2] = v;
    greyRGBA[i*4+3] = 255;
  }
  canvGrey.getContext('2d').putImageData(new ImageData(greyRGBA, W, H), 0, 0);

  // Clear mask canvases until edge detection runs
  ['canvas-raw-mask', 'canvas-smooth-mask'].forEach(id => {
    const c = document.getElementById(id);
    c.width = W; c.height = H;
    c.getContext('2d').clearRect(0, 0, W, H);
  });

  const canvC = document.getElementById('canvas-c');
  canvC.width = W; canvC.height = H;
  canvC.getContext('2d').clearRect(0, 0, W, H);

  setStatus(`${W}×${H} px`);
  updateImgInfo();
  if (typeof updateAutoSummary === 'function') updateAutoSummary();
  redraw();
}

function loadImageAndAutoScale(img) {
  recommendedScale = computeRecommendedScale(img.naturalWidth, img.naturalHeight);
  const sl = document.getElementById('img-scale');
  const nm = document.getElementById('img-scale-num');
  if (sl) { sl.value = recommendedScale; nm.value = recommendedScale; }
  state.originalImg = img;
  // Mirror the just-loaded image into the Image-box preview at full resolution
  // (the wrap caps its display height; max-width keeps it bounded).
  const preview = document.getElementById('image-preview');
  if (preview && img.src) preview.src = img.src;
  applyScale(img);
}

function drawEdgeMasks(greyFlat, W, H, precomputed) {
  const { rawMask, smoothMask } = precomputed || detectEdges(greyFlat, W, H);
  const N = W * H;

  const rawRGBA = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const v = rawMask[i] ? 255 : 0;
    rawRGBA[i*4] = rawRGBA[i*4+1] = rawRGBA[i*4+2] = v;
    rawRGBA[i*4+3] = 255;
  }
  const cr = document.getElementById('canvas-raw-mask');
  cr.width = W; cr.height = H;
  cr.getContext('2d').putImageData(new ImageData(rawRGBA, W, H), 0, 0);

  const smRGBA = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    if (smoothMask[i]) { smRGBA[i*4]=220; smRGBA[i*4+1]=50;  smRGBA[i*4+2]=50;  }
    else               { smRGBA[i*4]=50;  smRGBA[i*4+1]=100; smRGBA[i*4+2]=200; }
    smRGBA[i*4+3] = 255;
  }
  const cs = document.getElementById('canvas-smooth-mask');
  cs.width = W; cs.height = H;
  cs.getContext('2d').putImageData(new ImageData(smRGBA, W, H), 0, 0);
}

function loadImageFromFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    loadImageAndAutoScale(img);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function syncSliderNum(sliderId, numId, decimals) {
  const sl = document.getElementById(sliderId);
  const nm = document.getElementById(numId);
  sl.addEventListener('input',  () => {
    nm.value = decimals != null ? parseFloat(sl.value).toFixed(decimals) : sl.value;
  });
  nm.addEventListener('change', () => { sl.value = nm.value; });
}

// Log-scale slider: slider stores log10(value), num shows actual value.
function syncLogSlider(sliderId, numId, fmtFn) {
  const sl = document.getElementById(sliderId);
  const nm = document.getElementById(numId);
  sl.addEventListener('input', () => {
    nm.value = fmtFn(Math.pow(10, parseFloat(sl.value)));
  });
  nm.addEventListener('change', () => {
    const v = parseFloat(nm.value);
    if (v > 0) sl.value = Math.log10(v);
  });
}

function fmtSigma(v) {
  return parseFloat(v.toPrecision(3)).toString();
}

function fmtDelta(v) {
  if (v >= 1) return v.toFixed(0);
  const dp = Math.max(1, -Math.floor(Math.log10(v)));
  return v.toFixed(dp);
}

// Set a log-scale slider + its number readout from an actual value.
function setLogSlider(sliderId, numId, value, fmtFn) {
  const sl = document.getElementById(sliderId);
  const nm = document.getElementById(numId);
  if (sl && value > 0) sl.value = Math.log10(value);
  if (nm && value > 0) nm.value = fmtFn(value);
}

function getParams() {
  // Read seed-mode from the manual sampling panel's radio group.
  const seedMode = (document.querySelector('input[name=seed-mode]:checked') || {}).value || 'seed';
  const useSeed  = seedMode === 'seed';
  return {
    sigma1:  parseFloat(document.getElementById('sigma1-num').value),
    sigma2:  parseFloat(document.getElementById('sigma2-num').value),
    p:       parseFloat(document.getElementById('p-num').value),
    delta:   parseFloat(document.getElementById('delta-num').value),
    gridW:   parseInt(document.getElementById('grid-w').value,   10),
    gridH:   parseInt(document.getElementById('grid-h').value,   10),
    nRandom: parseInt(document.getElementById('n-random').value, 10),
    seed:    useSeed ? parseInt(document.getElementById('seed').value, 10)
                     : Math.floor(Math.random() * 2 ** 31),
    kernel:  document.getElementById('kernel-type').value,
  };
}

// ── Master parameters & automatic-mode heuristics ─────────────────────────────

function getMasterParams() {
  const numOr = (id, fallback) => {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  // β₁, β₂, N_frac, Fill_frac are exposed as percentages — convert to fractions.
  return {
    p:        MASTER_DEFAULTS.p,        // fixed
    delta:    MASTER_DEFAULTS.delta,    // fixed
    beta1:    numOr('m-beta1',    MASTER_DEFAULTS.beta1    * 100) / 100,
    beta2:    numOr('m-beta2',    MASTER_DEFAULTS.beta2    * 100) / 100,
    nFrac:    numOr('m-nfrac',    MASTER_DEFAULTS.nFrac    * 100) / 100,
    fillFrac: numOr('m-fillfrac', MASTER_DEFAULTS.fillFrac * 100) / 100,
    density:  numOr('m-density',  MASTER_DEFAULTS.density),
  };
}

function resetMasterParams() {
  // Sliders hold percentages; only β/N/Fill are editable now.
  document.getElementById('m-beta1').value    = MASTER_DEFAULTS.beta1    * 100;
  document.getElementById('m-beta2').value    = MASTER_DEFAULTS.beta2    * 100;
  document.getElementById('m-nfrac').value    = MASTER_DEFAULTS.nFrac    * 100;
  document.getElementById('m-fillfrac').value = MASTER_DEFAULTS.fillFrac * 100;
  document.getElementById('m-density').value         = MASTER_DEFAULTS.density.toFixed(1);
  document.getElementById('m-density-slider').value  = MASTER_DEFAULTS.density;
  refreshMasterReadouts();
  updateAutoSummary();
}

// Sync each slider's numeric readout to its current value.
function refreshMasterReadouts() {
  const set = (id, outId, decimals) => {
    const el = document.getElementById(id);
    const o  = document.getElementById(outId);
    if (el && o && document.activeElement !== o) {
      const v = parseFloat(el.value);
      o.value = Number.isFinite(v) ? v.toFixed(decimals) : '';
    }
  };
  set('m-beta1',    'm-beta1-out',    0);
  set('m-beta2',    'm-beta2-out',    0);
  set('m-nfrac',    'm-nfrac-out',    1);
  set('m-fillfrac', 'm-fillfrac-out', 1);
}

// Number of sample points implied by N_FRACTION at the current image size.
function autoSampleCount(W, H, nFrac) {
  if (!W || !H) return 0;
  return Math.max(4, Math.round(nFrac * W * H));
}

// Coverage-based heuristics for sigma1 / sigma2.
//   sigma1: spatial bandwidth, normalised by image diagonal.
//   sigma2: intensity bandwidth, normalised against 255^p.
// Both target "at the typical sample spacing, k drops to (1 - beta)."
function autoSigmas(W, H, n, p, beta1, beta2) {
  if (!W || !H || !n) return { sigma1: null, sigma2: null };
  const diag = Math.sqrt(W * W + H * H);

  // Average nearest-neighbour distance for n uniform samples in W*H.
  const meanNN = 0.5 * Math.sqrt((W * H) / n);
  const eps1   = meanNN / diag;

  const safe = b => Math.max(1e-4, Math.min(0.9999, b));
  const k1   = Math.sqrt(-Math.log(1 - safe(beta1)));
  const k2   = Math.sqrt(-Math.log(1 - safe(beta2)));

  // Assume typical intensity gap between neighbouring samples ≈ 0.1 in [0,1].
  const typIntensityGap = 0.1;

  return {
    sigma1: eps1 / k1,
    sigma2: Math.pow(typIntensityGap, p) / k2,
  };
}

function formatNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1)    return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(3);
  return v.toExponential(2);
}

function updateAutoSummary() {
  const nEl  = document.getElementById('auto-n');
  const s1El = document.getElementById('auto-s1');
  const s2El = document.getElementById('auto-s2');
  if (!nEl) return;

  const m = getMasterParams();
  if (!state.W || !state.H) {
    nEl.textContent = '—'; s1El.textContent = '—'; s2El.textContent = '—';
    return;
  }
  const n = autoSampleCount(state.W, state.H, m.nFrac);
  const { sigma1, sigma2 } = autoSigmas(state.W, state.H, n, m.p, m.beta1, m.beta2);
  nEl.textContent  = n.toString();
  s1El.textContent = formatNum(sigma1);
  s2El.textContent = formatNum(sigma2);
}

function getAutoParams() {
  const m = getMasterParams();
  const n = autoSampleCount(state.W, state.H, m.nFrac);
  const { sigma1, sigma2 } = autoSigmas(state.W, state.H, n, m.p, m.beta1, m.beta2);
  // Master-side seed mode: explicit Random or fixed Seed.
  const seedMode = (document.querySelector('input[name=m-seed-mode]:checked') || {}).value || 'seed';
  const seed = seedMode === 'seed'
    ? parseInt(document.getElementById('m-seed').value, 10)
    : Math.floor(Math.random() * 2 ** 31);
  return {
    sigma1, sigma2,
    p:       m.p,
    delta:   m.delta,
    nRandom: n,
    seed,
    kernel:  document.getElementById('kernel-type').value,
    master:  m,
  };
}

// Mirror an auto-computed set of params into the Manual-mode inputs so the
// user can switch to Manual and continue tuning from the auto baseline.
function pushAutoToManual(ap) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el || val == null || !Number.isFinite(val)) return;
    el.value = val;
  };
  if (ap.sigma1 > 0) setLogSlider('sigma1', 'sigma1-num', ap.sigma1, fmtSigma);
  if (ap.sigma2 > 0) setLogSlider('sigma2', 'sigma2-num', ap.sigma2, fmtSigma);
  set('p-param', ap.p);
  set('p-num',   ap.p);
  if (ap.delta > 0)  setLogSlider('delta', 'delta-num', ap.delta, fmtDelta);
  set('n-random', ap.nRandom);
}

// ── Results: table and charts ─────────────────────────────────────────────────

function selectResult(id) {
  selectedResultId = id;
  document.querySelectorAll('#results-tbody tr').forEach(tr => {
    tr.classList.toggle('selected-row', parseInt(tr.dataset.rid) === id);
  });
  renderCharts();
}

function loadResult(id) {
  const r = results.find(x => x.id === id);
  if (!r) return;

  state.W = r.W; state.H = r.H;
  state.greyFlat   = new Uint8Array(r.greyFlat);
  state.colourFlat = new Uint8Array(r.colourFlat);
  state.points     = r.pts.map(p => ({ ...p }));

  setLogSlider('sigma1', 'sigma1-num', r.sigma1, fmtSigma);
  setLogSlider('sigma2', 'sigma2-num', r.sigma2, fmtSigma);
  document.getElementById('p-param').value = r.p;
  document.getElementById('p-num').value   = r.p;
  setLogSlider('delta', 'delta-num', r.delta, fmtDelta);
  document.getElementById('kernel-type').value = r.kernel;

  resizeCanvas(r.W, r.H);
  if (state.p5cnv) {
    state.p5cnv.style('width', '100%');
    state.p5cnv.style('height', '100%');
    state.p5cnv.style('max-width', '');
    state.p5cnv.style('max-height', '');
  }

  const canvA = document.getElementById('canvas-a');
  canvA.width = r.W; canvA.height = r.H;
  canvA.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(r.colourFlat), r.W, r.H), 0, 0
  );

  const canvC = document.getElementById('canvas-c');
  canvC.width = r.W; canvC.height = r.H;
  canvC.getContext('2d').putImageData(new ImageData(r.out, r.W, r.H), 0, 0);

  document.getElementById('metric-frob').textContent = r.frob.toFixed(1);
  document.getElementById('metric-ssim').textContent = r.ssim.toFixed(4);

  setStatus(`Loaded attempt #${r.id}`);
  redraw();
  selectResult(id);
}

const TABLE_COLS = [
  { key: 'id',      label: '#' },
  { key: 'kernel',  label: 'Kernel' },
  { key: 'sigma1',  label: '&#963;&#8321;' },
  { key: 'sigma2',  label: '&#963;&#8322;' },
  { key: 'p',       label: 'p' },
  { key: 'delta',   label: '&#948;' },
  { key: 'nPoints', label: 'n' },
  { key: 'frob',    label: '&#8214;&#183;&#8214;<sub>F</sub>' },
  { key: 'ssim',    label: 'SSIM' },
];

function sortedResults() {
  return [...results].sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });
}

function renderTable() {
  // Headers
  const thead = document.querySelector('#results-table thead tr');
  thead.innerHTML = TABLE_COLS.map(col => {
    const active = col.key === sortKey;
    const arrow  = active ? (sortAsc ? ' ▲' : ' ▼') : '';
    return `<th data-col="${col.key}" style="cursor:pointer;user-select:none">${col.label}${arrow}</th>`;
  }).join('') + '<th></th>';

  // Body — render results, then pad with empty placeholder rows so the table
  // always fills the same vertical space as the side-by-side charts.
  const MIN_ROWS = 14;
  const tbody = document.getElementById('results-tbody');
  const rows = sortedResults().map(r => `
    <tr data-rid="${r.id}" class="${r.id === selectedResultId ? 'selected-row' : ''}">
      <td>${r.id}</td>
      <td>${r.kernel === 'wendland' ? 'Wendland' : 'Gaussian'}</td>
      <td>${r.sigma1}</td><td>${r.sigma2}</td>
      <td>${r.p}</td><td>${r.delta}</td><td>${r.nPoints}</td>
      <td>${r.frob.toFixed(1)}</td><td>${r.ssim.toFixed(4)}</td>
      <td><button class="load-btn">Load</button></td>
    </tr>
  `);
  const blanksNeeded = Math.max(0, MIN_ROWS - rows.length);
  const colCount = TABLE_COLS.length + 1; // +1 for the Load button column
  for (let i = 0; i < blanksNeeded; i++) {
    rows.push(`<tr class="blank-row">${'<td>&nbsp;</td>'.repeat(colCount)}</tr>`);
  }
  tbody.innerHTML = rows.join('');
  // Only enable vertical scrolling when the user has added more results than
  // the default placeholder row count.
  document.getElementById('results-table-wrap')
    .classList.toggle('scrollable', sortedResults().length > MIN_ROWS);
}

function renderBarChart(container, sortedEntries, getValue, ascending) {
  const W = container.clientWidth || 240;
  const H = 150;
  const pL = 44, pB = 22, pT = 6, pR = 6;
  const cW = W - pL - pR, cH = H - pT - pB;
  const n  = sortedEntries.length;

  // Grid + axes are drawn even when there are no entries so the chart keeps
  // a stable shape and size before the first result is added.
  const vals = sortedEntries.map(e => getValue(e));
  const maxV = n ? (Math.max(...vals) * 1.08 || 1) : 1;

  let grid = '', rects = '', labels = '';
  for (let t = 0; t <= 4; t++) {
    const v  = maxV * t / 4;
    const y  = pT + cH - cH * t / 4;
    const lbl = n
      ? (v >= 100 ? v.toFixed(0) : v < 0.01 ? v.toExponential(1) : v.toFixed(2))
      : '';
    grid += `<line x1="${pL}" y1="${y.toFixed(1)}" x2="${pL + cW}" y2="${y.toFixed(1)}" stroke="#e0e0e0" stroke-width="1"/>`;
    if (lbl) grid += `<text x="${pL - 3}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="8" fill="#999">${lbl}</text>`;
  }

  if (n) {
    const slotW = cW / n;
    const barW  = Math.max(3, Math.min(slotW * 0.75, 36));
    sortedEntries.forEach((e, i) => {
      const v    = getValue(e);
      const barH = Math.max(2, cH * v / maxV);
      const x    = pL + i * slotW + (slotW - barW) / 2;
      const y    = pT + cH - barH;
      const sel  = e.id === selectedResultId;
      rects  += `<rect data-rid="${e.id}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${barH.toFixed(1)}" fill="${sel ? '#2a4a7a' : '#5b7fa6'}" stroke="${sel ? '#111' : 'none'}" stroke-width="${sel ? 1.5 : 0}" rx="2" style="cursor:pointer"/>`;
      labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${pT + cH + 14}" text-anchor="middle" font-size="9" fill="${sel ? '#111' : '#777'}" font-weight="${sel ? 'bold' : 'normal'}">${e.id}</text>`;
    });
  } else {
    labels = `<text x="${pL + cW / 2}" y="${pT + cH / 2}" text-anchor="middle" font-size="11" fill="#bbb" font-style="italic">No results yet</text>`;
  }

  const axes = `<line x1="${pL}" y1="${pT}" x2="${pL}" y2="${pT + cH}" stroke="#bbb" stroke-width="1"/>
    <line x1="${pL}" y1="${pT + cH}" x2="${pL + cW}" y2="${pT + cH}" stroke="#bbb" stroke-width="1"/>`;

  container.innerHTML = `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}">${axes}${grid}${rects}${labels}</svg>`;
  container.querySelectorAll('rect[data-rid]').forEach(rect => {
    rect.addEventListener('click', () => selectResult(parseInt(rect.dataset.rid)));
  });
}

function renderCharts() {
  const sortedFrob = [...results].sort((a, b) => a.frob - b.frob);
  const sortedSSIM = [...results].sort((a, b) => b.ssim - a.ssim);
  renderBarChart(document.getElementById('chart-frob'), sortedFrob, r => r.frob, true);
  renderBarChart(document.getElementById('chart-ssim'), sortedSSIM, r => r.ssim, false);
}

function addResult(r) {
  results.push(r);
  renderTable();
  renderCharts();
  selectResult(r.id);
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

// ── p > 1 warning modal ───────────────────────────────────────────────────────
(function () {
  let warned = false;

  function closeModal() {
    document.getElementById('p-modal-backdrop').classList.add('hidden');
    document.getElementById('p-modal-backdrop').setAttribute('aria-hidden', 'true');
  }

  function maybeWarn(value) {
    if (warned || parseFloat(value) <= 1) return;
    warned = true;
    const backdrop = document.getElementById('p-modal-backdrop');
    backdrop.classList.remove('hidden');
    backdrop.setAttribute('aria-hidden', 'false');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('p-modal-close').addEventListener('click', closeModal);
    document.getElementById('p-modal-backdrop').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.getElementById('p-param').addEventListener('input',  e => maybeWarn(e.target.value));
    document.getElementById('p-num'  ).addEventListener('change', e => maybeWarn(e.target.value));
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  syncLogSlider('sigma1',  'sigma1-num', fmtSigma);
  syncLogSlider('sigma2',  'sigma2-num', fmtSigma);
  syncSliderNum('p-param', 'p-num');
  syncLogSlider('delta',   'delta-num',  fmtDelta);
  syncSliderNum('img-scale',        'img-scale-num');
  syncSliderNum('n-random-slider',  'n-random');
  syncSliderNum('m-density-slider', 'm-density');

  document.getElementById('img-scale').addEventListener('input', updateImgInfo);
  document.getElementById('img-scale-num').addEventListener('input', updateImgInfo);
  const rescale = () => {
    if (state.originalImg) {
      applyScale(state.originalImg, /* preservePoints */ true);
      redraw();
    }
  };
  document.getElementById('img-scale').addEventListener('change', rescale);
  document.getElementById('img-scale-num').addEventListener('change', rescale);

  renderTable(); // populate headers immediately
  renderCharts(); // draw empty axes/grid before any results exist

  // Table header sort
  document.querySelector('#results-table thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    if (sortKey === col) sortAsc = !sortAsc; else { sortKey = col; sortAsc = true; }
    renderTable();
  });

  // Table body click delegation (set once; renderTable only updates innerHTML)
  document.getElementById('results-tbody').addEventListener('click', e => {
    const tr  = e.target.closest('tr');
    if (!tr) return;
    const id = parseInt(tr.dataset.rid);
    if (e.target.closest('.load-btn')) loadResult(id); else selectResult(id);
  });

  function loadDefaultByName(filename) {
    fetch(filename)
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { loadImageAndAutoScale(img); };
        img.src = url;
      })
      .catch(() => {});
  }

  document.getElementById('default-img').addEventListener('change', e => {
    loadDefaultByName(e.target.value);
  });

  loadDefaultByName(document.getElementById('default-img').value);

  document.getElementById('img-upload').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    // Keep a persistent blob URL so the user can re-select this upload later.
    const url = URL.createObjectURL(file);
    uploadCounter += 1;
    const label = `UPLOAD ${uploadCounter}`;
    const sel   = document.getElementById('default-img');
    const opt   = document.createElement('option');
    opt.value = url;
    opt.textContent = label;
    opt.dataset.upload = 'true';
    // Insert at top, then select it.
    sel.insertBefore(opt, sel.firstChild);
    sel.value = url;
    loadDefaultByName(url);
    // Reset the file-input value so re-selecting the same file still fires change.
    e.target.value = '';
  });

  // (Seed mode is wired via radio CSS :has — no JS needed for the UI state.)

  const methodPanels = { grid: 'grid-panel', random: 'random-panel', user: 'user-panel' };
  document.getElementById('point-method').addEventListener('change', e => {
    state.method = e.target.value;
    Object.entries(methodPanels).forEach(([m, id]) =>
      document.getElementById(id).classList.toggle('invis', m !== state.method)
    );
    document.getElementById('gen-pts-btn').classList.toggle('hidden', state.method === 'user');
    redraw();
  });

  document.getElementById('tool-pick').addEventListener('click', () => {
    state.tool = 'pick';
    document.getElementById('tool-pick').classList.add('active');
    document.getElementById('tool-remove').classList.remove('active');
    redraw();
  });
  document.getElementById('tool-remove').addEventListener('click', () => {
    state.tool = 'remove';
    document.getElementById('tool-remove').classList.add('active');
    document.getElementById('tool-pick').classList.remove('active');
    redraw();
  });

  document.getElementById('clear-pts-btn').addEventListener('click', () => {
    state.points = [];
    redraw();
  });

  document.getElementById('clear-results-btn').addEventListener('click', () => {
    results.length = 0;
    selectedResultId = -1;
    renderTable();
    renderCharts();
  });

  document.getElementById('show-points').addEventListener('change', () => redraw());

  // ── Shared Generate-points handler (branches on mode) ──────────────────────
  document.getElementById('gen-pts-btn').addEventListener('click', () => {
    if (!state.colourFlat) { setStatus('Upload an image first.'); return; }

    if (state.mode === 'automatic') {
      const ap = getAutoParams();
      state.points = generateRandom(state.W, state.H, state.colourFlat, ap.nRandom, ap.seed);
      pushAutoToManual(ap);
      setStatus(`${state.points.length} point${state.points.length !== 1 ? 's' : ''} placed (auto)`);
      updateAutoSummary();
      redraw();
      return;
    }

    // Manual mode
    const pr = getParams();
    if (state.method === 'grid') {
      state.points = generateGrid(state.W, state.H, state.colourFlat, pr.gridW, pr.gridH);
    } else if (state.method === 'random') {
      state.points = generateRandom(state.W, state.H, state.colourFlat, pr.nRandom, pr.seed);
    } else {
      setStatus('Click on the image to add points.');
      return;
    }
    setStatus(`${state.points.length} point${state.points.length !== 1 ? 's' : ''} placed`);
    redraw();
  });

  // ── Slow-run warning modal ─────────────────────────────────────────────────
  // Warn when n × pixels > this; roughly corresponds to ~10 s on a mid-range laptop.
  const SLOW_THRESHOLD = 200_000_000;

  const slowBackdrop = document.getElementById('slow-modal-backdrop');
  let pendingColourise = null; // thunk to run if user clicks "Continue"

  function closeSlowModal() {
    slowBackdrop.classList.add('hidden');
    slowBackdrop.setAttribute('aria-hidden', 'true');
    pendingColourise = null;
  }

  document.getElementById('slow-modal-close').addEventListener('click', closeSlowModal);
  slowBackdrop.addEventListener('click', e => { if (e.target === slowBackdrop) closeSlowModal(); });
  document.getElementById('slow-cancel').addEventListener('click', closeSlowModal);

  document.getElementById('slow-rescale').addEventListener('click', () => {
    closeSlowModal();
    const recScale = computeRecommendedScale(
      state.originalImg.naturalWidth, state.originalImg.naturalHeight
    );
    const sl  = document.getElementById('img-scale');
    const num = document.getElementById('img-scale-num');
    sl.value  = recScale;
    num.value = recScale;
    updateImgInfo();
    applyScale(state.originalImg, /* preservePoints */ true);
    redraw();
  });

  document.getElementById('slow-continue').addEventListener('click', () => {
    const fn = pendingColourise;
    closeSlowModal();
    if (fn) fn();
  });

  // ── Shared Colourise handler (branches on mode) ────────────────────────────
  function runColourise() {
    const isAuto = state.mode === 'automatic';
    const pipelineMode = isAuto && document.getElementById('show-pipeline').checked;

    let pr;
    if (pipelineMode) {
      // Full pipeline: edge detection → blue-noise sampling → sigma heuristics
      const m = getMasterParams();
      const n = autoSampleCount(state.W, state.H, m.nFrac);
      const seedMode = (document.querySelector('input[name=m-seed-mode]:checked') || {}).value || 'seed';
      const seed = seedMode === 'seed'
        ? parseInt(document.getElementById('m-seed').value, 10)
        : Math.floor(Math.random() * 2 ** 31);

      setStatus('Edge detection…');
      const masks = detectEdges(state.greyFlat, state.W, state.H);
      drawEdgeMasks(null, state.W, state.H, masks);

      setStatus('Sampling…');
      state.points = sampleBlueNoise(
        state.W, state.H, state.colourFlat, state.greyFlat,
        n, masks.smoothMask, m.density, m.fillFrac, seed
      );

      setStatus('Computing σ heuristics…');
      const { sigma1, sigma2 } = computeSigmasFromPoints(
        state.points, state.W, state.H, state.greyFlat, m.p, m.beta1, m.beta2
      );

      pr = {
        sigma1, sigma2,
        p:       m.p,
        delta:   m.delta,
        nRandom: n,
        seed,
        kernel:  document.getElementById('kernel-type').value,
      };
      pushAutoToManual(pr);
      redraw();
    } else if (isAuto) {
      pr = getAutoParams();
      pushAutoToManual(pr);
      if (state.points.length < 1) {
        state.points = generateRandom(state.W, state.H, state.colourFlat, pr.nRandom, pr.seed);
        redraw();
      }
    } else {
      if (state.points.length < 1) {
        setStatus('Add at least one point first.');
        return;
      }
      pr = getParams();
    }

    setStatus(isAuto ? 'Computing (auto)…' : 'Computing…');
    setTimeout(() => {
      try {
        const out = colourise(
          state.points, state.W, state.H, state.greyFlat,
          pr.sigma1, pr.sigma2, pr.p, pr.delta, pr.kernel
        );
        if (!out) return;

        const canvC = document.getElementById('canvas-c');
        canvC.width  = state.W; canvC.height = state.H;
        canvC.getContext('2d').putImageData(new ImageData(out, state.W, state.H), 0, 0);

        const frob = frobeniusNorm(state.colourFlat, out, state.W, state.H);
        const ssim = ssimIndex(state.colourFlat, out, state.W, state.H);

        document.getElementById('metric-frob').textContent = frob.toFixed(1);
        document.getElementById('metric-ssim').textContent = ssim.toFixed(4);

        addResult({
          id:         results.length + 1,
          kernel:     pr.kernel,
          sigma1:     isAuto ? +pr.sigma1.toFixed(4) : pr.sigma1,
          sigma2:     isAuto ? +pr.sigma2.toFixed(4) : pr.sigma2,
          p:          pr.p,
          delta:      pr.delta,
          pts:        state.points.map(p => ({ ...p })),
          nPoints:    state.points.length,
          W:          state.W,   H:      state.H,
          greyFlat:   new Uint8Array(state.greyFlat),
          colourFlat: new Uint8Array(state.colourFlat),
          out,
          frob, ssim,
        });

        if (isAuto && !pipelineMode) drawEdgeMasks(state.greyFlat, state.W, state.H);

        setStatus(isAuto
          ? `Auto done — n=${state.points.length}, σ₁=${formatNum(pr.sigma1)}, σ₂=${formatNum(pr.sigma2)}`
          : `Done — ${state.points.length} point${state.points.length !== 1 ? 's' : ''}`);
      } catch (err) {
        setStatus('Error: ' + err.message);
        console.error(err);
      }
    }, 20);
  }

  document.getElementById('colourise-btn').addEventListener('click', () => {
    if (!state.greyFlat) { setStatus('Upload an image first.'); return; }

    // Estimate work: n × W×H kernel evaluations.
    const isAuto = state.mode === 'automatic';
    const nEst = isAuto
      ? autoSampleCount(state.W, state.H, getMasterParams().nFrac)
      : (state.points.length || parseInt(document.getElementById('n-random').value) || 1);
    const work = nEst * state.W * state.H;

    if (work > SLOW_THRESHOLD) {
      const px     = state.W * state.H;
      const secs   = Math.round(work / 20_000_000); // rough 20M evals/s estimate
      document.getElementById('slow-modal-body').innerHTML =
        `With <b>${nEst.toLocaleString()} sample points</b> and a
        <b>${state.W}&times;${state.H}</b> image
        (${px.toLocaleString()} pixels), this run involves roughly
        <b>${(work / 1e6).toFixed(0)}M</b> kernel evaluations and may take
        <b>~${secs} seconds</b> in your browser.`;
      pendingColourise = runColourise;
      slowBackdrop.classList.remove('hidden');
      slowBackdrop.setAttribute('aria-hidden', 'false');
      return;
    }

    runColourise();
  });

  // ── Mode toggle (Manual / Automatic) ───────────────────────────────────────
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.getElementById('manual-mode').classList.toggle('hidden', mode !== 'manual');
    document.getElementById('auto-mode'  ).classList.toggle('hidden', mode !== 'automatic');
    // In Automatic mode, "Generate points" should always be available, even if
    // the (hidden) manual method is set to user-selected.
    const gen = document.getElementById('gen-pts-btn');
    if (mode === 'automatic') gen.classList.remove('hidden');
    else                      gen.classList.toggle('hidden', state.method === 'user');
    if (mode === 'automatic') updateAutoSummary();
  }
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // ── Master parameter live wiring ───────────────────────────────────────────
  // Slider → number readout + summary
  ['m-beta1','m-beta2','m-nfrac','m-fillfrac','m-density','m-density-slider'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      refreshMasterReadouts();
      updateAutoSummary();
    });
  });

  // Number readout → slider (bidirectional editing for master params)
  [
    ['m-beta1-out',    'm-beta1'],
    ['m-beta2-out',    'm-beta2'],
    ['m-nfrac-out',    'm-nfrac'],
    ['m-fillfrac-out', 'm-fillfrac'],
  ].forEach(([numId, sliderId]) => {
    const num = document.getElementById(numId);
    const sl  = document.getElementById(sliderId);
    if (!num || !sl) return;
    num.addEventListener('input',  () => { sl.value = num.value; updateAutoSummary(); });
    num.addEventListener('change', () => { sl.value = num.value; updateAutoSummary(); });
  });

  document.getElementById('reset-master').addEventListener('click', resetMasterParams);

  // Initialise summary on load.
  refreshMasterReadouts();
  updateAutoSummary();

  // ── Pipeline stage toggle ──────────────────────────────────────────────────
  document.getElementById('show-pipeline').addEventListener('change', function () {
    const on = this.checked;
    document.getElementById('panels').classList.toggle('pipeline-mode', on);
    document.getElementById('panel-b-label').innerHTML = on
      ? '<b>(e)</b> Greyscale with data points <i>D</i>'
      : '<b>(b)</b> Greyscale with data points <i>D</i>';
    document.getElementById('panel-c-label').innerHTML = on
      ? '<b>(f)</b> Colourised output'
      : '<b>(c)</b> Colourised output';
  });
});
