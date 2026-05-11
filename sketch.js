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
  p5cnv:       null,
  originalImg: null,
};

let recommendedScale = 0.25;

const TARGET_PIXELS = 160000;

function computeRecommendedScale(origW, origH) {
  const origPixels = origW * origH;
  if (origPixels <= TARGET_PIXELS) return 1.0;
  const raw = Math.sqrt(TARGET_PIXELS / origPixels);
  return Math.max(0.05, Math.min(1.0, Math.round(raw / 0.05) * 0.05));
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
    warnEl.textContent = `⚠ Recommended scale: ${recommendedScale}`;
    warnEl.classList.remove('hidden');
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
  const R = 3.5; // dot radius in display pixels

  for (const pt of state.points) {
    const x = ox + pt.x * scaleX;
    const y = oy + pt.y * scaleY;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${pt.r},${pt.g},${pt.b})`;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 1.2;
    ctx.fill();
    ctx.stroke();
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

function applyScale(img) {
  const scale = parseFloat(document.getElementById('img-scale').value) || 1;
  const W = Math.max(1, Math.round(img.naturalWidth  * scale));
  const H = Math.max(1, Math.round(img.naturalHeight * scale));

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
  state.points = [];
  document.getElementById('metric-frob').textContent = '—';
  document.getElementById('metric-ssim').textContent = '—';

  const canvA = document.getElementById('canvas-a');
  canvA.width  = W; canvA.height = H;
  canvA.getContext('2d').drawImage(img, 0, 0, W, H);

  const canvC = document.getElementById('canvas-c');
  canvC.width = W; canvC.height = H;
  canvC.getContext('2d').clearRect(0, 0, W, H);

  setStatus(`${W}×${H} px`);
  updateImgInfo();
  redraw();
}

function loadImageAndAutoScale(img) {
  recommendedScale = computeRecommendedScale(img.naturalWidth, img.naturalHeight);
  const sl = document.getElementById('img-scale');
  const nm = document.getElementById('img-scale-num');
  if (sl) { sl.value = recommendedScale; nm.value = recommendedScale; }
  state.originalImg = img;
  applyScale(img);
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

function syncSliderNum(sliderId, numId) {
  const sl = document.getElementById(sliderId);
  const nm = document.getElementById(numId);
  sl.addEventListener('input',  () => { nm.value = sl.value; });
  nm.addEventListener('change', () => { sl.value = nm.value; });
}

function getParams() {
  const useSeed = document.getElementById('use-seed').checked;
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

  document.getElementById('sigma1').value     = r.sigma1;
  document.getElementById('sigma1-num').value = r.sigma1;
  document.getElementById('sigma2').value     = r.sigma2;
  document.getElementById('sigma2-num').value = r.sigma2;
  document.getElementById('p-param').value    = r.p;
  document.getElementById('p-num').value      = r.p;
  document.getElementById('delta').value      = r.delta;
  document.getElementById('delta-num').value  = r.delta;
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

  // Body
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = sortedResults().map(r => `
    <tr data-rid="${r.id}" class="${r.id === selectedResultId ? 'selected-row' : ''}">
      <td>${r.id}</td>
      <td>${r.kernel === 'wendland' ? 'Wendland' : 'Gaussian'}</td>
      <td>${r.sigma1}</td><td>${r.sigma2}</td>
      <td>${r.p}</td><td>${r.delta}</td><td>${r.nPoints}</td>
      <td>${r.frob.toFixed(1)}</td><td>${r.ssim.toFixed(4)}</td>
      <td><button class="load-btn">Load</button></td>
    </tr>
  `).join('');
}

function renderBarChart(container, sortedEntries, getValue, ascending) {
  if (!sortedEntries.length) { container.innerHTML = ''; return; }

  const W = container.clientWidth || 240;
  const H = 150;
  const pL = 44, pB = 22, pT = 6, pR = 6;
  const cW = W - pL - pR, cH = H - pT - pB;
  const n  = sortedEntries.length;
  const slotW = cW / n;
  const barW  = Math.max(3, Math.min(slotW * 0.75, 36));

  const vals = sortedEntries.map(e => getValue(e));
  const maxV = Math.max(...vals) * 1.08 || 1;

  let grid = '', rects = '', labels = '';
  for (let t = 0; t <= 4; t++) {
    const v  = maxV * t / 4;
    const y  = pT + cH - cH * t / 4;
    const lbl = v >= 100 ? v.toFixed(0) : v < 0.01 ? v.toExponential(1) : v.toFixed(2);
    grid += `<line x1="${pL}" y1="${y.toFixed(1)}" x2="${pL + cW}" y2="${y.toFixed(1)}" stroke="#e0e0e0" stroke-width="1"/>`;
    grid += `<text x="${pL - 3}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="8" fill="#999">${lbl}</text>`;
  }

  sortedEntries.forEach((e, i) => {
    const v    = getValue(e);
    const barH = Math.max(2, cH * v / maxV);
    const x    = pL + i * slotW + (slotW - barW) / 2;
    const y    = pT + cH - barH;
    const sel  = e.id === selectedResultId;
    rects  += `<rect data-rid="${e.id}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${barH.toFixed(1)}" fill="${sel ? '#2a4a7a' : '#5b7fa6'}" stroke="${sel ? '#111' : 'none'}" stroke-width="${sel ? 1.5 : 0}" rx="2" style="cursor:pointer"/>`;
    labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${pT + cH + 14}" text-anchor="middle" font-size="9" fill="${sel ? '#111' : '#777'}" font-weight="${sel ? 'bold' : 'normal'}">${e.id}</text>`;
  });

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

document.addEventListener('DOMContentLoaded', () => {
  syncSliderNum('sigma1',    'sigma1-num');
  syncSliderNum('sigma2',    'sigma2-num');
  syncSliderNum('p-param',   'p-num');
  syncSliderNum('delta',     'delta-num');
  syncSliderNum('img-scale', 'img-scale-num');

  document.getElementById('img-scale').addEventListener('input', updateImgInfo);
  document.getElementById('img-scale-num').addEventListener('input', updateImgInfo);
  document.getElementById('img-scale').addEventListener('change', () => {
    if (state.originalImg) { state.points = []; applyScale(state.originalImg); }
  });

  renderTable(); // populate headers immediately

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
    if (e.target.files[0]) loadImageFromFile(e.target.files[0]);
  });

  const useSeedCb = document.getElementById('use-seed');
  const seedInput = document.getElementById('seed');
  useSeedCb.addEventListener('change', () => {
    seedInput.disabled = !useSeedCb.checked;
  });

  const methodPanels = { grid: 'grid-panel', random: 'random-panel', user: 'user-panel' };
  document.getElementById('point-method').addEventListener('change', e => {
    state.method = e.target.value;
    Object.entries(methodPanels).forEach(([m, id]) =>
      document.getElementById(id).classList.toggle('hidden', m !== state.method)
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

  document.getElementById('clear-pts').addEventListener('click', () => {
    state.points = [];
    redraw();
  });

  document.getElementById('show-points').addEventListener('change', () => redraw());

  document.getElementById('gen-pts-btn').addEventListener('click', () => {
    if (!state.colourFlat) { setStatus('Upload an image first.'); return; }
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

  document.getElementById('colourise-btn').addEventListener('click', () => {
    if (!state.greyFlat)         { setStatus('Upload an image first.'); return; }
    if (state.points.length < 1) { setStatus('Add at least one point first.'); return; }

    setStatus('Computing…');
    setTimeout(() => {
      const pr = getParams();
      try {
        const out = colourise(
          state.points, state.W, state.H, state.greyFlat,
          pr.sigma1, pr.sigma2, pr.p, pr.delta, pr.kernel
        );
        if (out) {
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
            sigma1:     pr.sigma1, sigma2: pr.sigma2,
            p:          pr.p,      delta:  pr.delta,
            pts:        state.points.map(p => ({ ...p })),
            nPoints:    state.points.length,
            W:          state.W,   H:      state.H,
            greyFlat:   new Uint8Array(state.greyFlat),
            colourFlat: new Uint8Array(state.colourFlat),
            out,
            frob, ssim,
          });

          setStatus(`Done — ${state.points.length} point${state.points.length !== 1 ? 's' : ''}`);
        }
      } catch (err) {
        setStatus('Error: ' + err.message);
        console.error(err);
      }
    }, 20);
  });
});
