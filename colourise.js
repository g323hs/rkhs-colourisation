// colourise.js — RKHS colourisation kernel, matching the Python implementation.
//
// Kernel formula (Gaussian RBF):
//   k(z_i, z_j) = exp(-(r1)^2) * exp(-(r2)^2)
//   r1 = dist(z_i, z_j) / (sigma1 * diag)     diag = sqrt(W^2 + H^2)
//   r2 = |I(z_i) - I(z_j)|^p / (sigma2 * 255^p)
//
// Solve (K_D + delta*I) alpha = colours, then evaluate f(z) = K_Omega @ alpha.

// ── Linear algebra ────────────────────────────────────────────────────────────

// Solve A·X = B for k right-hand sides simultaneously.
// A: n×n (array of Float64Arrays), B: k×n (array of arrays).
// Returns X: k×n (array of Float64Arrays).
function solveMultiRHS(A, B) {
  const n = A.length;
  const k = B.length;

  // Build augmented matrix [A | B^T]
  const M = A.map((row, i) => {
    const r = new Float64Array(n + k);
    for (let j = 0; j < n; j++) r[j] = row[j];
    for (let ki = 0; ki < k; ki++) r[n + ki] = B[ki][i];
    return r;
  });

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    if (maxRow !== col) { const tmp = M[col]; M[col] = M[maxRow]; M[maxRow] = tmp; }

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-14) continue;

    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / pivot;
      for (let j = col; j < n + k; j++) M[row][j] -= f * M[col][j];
    }
  }

  // Back substitution
  const X = Array.from({ length: k }, () => new Float64Array(n));
  for (let i = n - 1; i >= 0; i--) {
    for (let ki = 0; ki < k; ki++) {
      let v = M[i][n + ki];
      for (let j = i + 1; j < n; j++) v -= M[i][j] * X[ki][j];
      X[ki][i] = Math.abs(M[i][i]) > 1e-14 ? v / M[i][i] : 0;
    }
  }
  return X;
}

// ── Kernel ────────────────────────────────────────────────────────────────────

// ── Kernel functions ──────────────────────────────────────────────────────────

function _gaussianK(r1, r2) {
  return Math.exp(-(r1 * r1)) * Math.exp(-(r2 * r2));
}

function _wendlandC2(r) {
  if (r >= 1) return 0;
  const t = 1 - r;
  return t * t * t * t * (4 * r + 1);
}

function _wendlandK(r1, r2) {
  return _wendlandC2(r1) * _wendlandC2(r2);
}

function _pickKernel(type) {
  return type === 'wendland' ? _wendlandK : _gaussianK;
}

function buildKD(pts, W, H, greyFlat, sigma1, sigma2, p, delta, kernel) {
  const n    = pts.length;
  const diag = Math.sqrt(W * W + H * H);
  const s2pow = sigma2 * Math.pow(255.0, p);
  const kfn  = _pickKernel(kernel);

  const K = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const Ii = greyFlat[pts[i].y * W + pts[i].x];
    for (let j = i; j < n; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const r1 = Math.sqrt(dx * dx + dy * dy) / (sigma1 * diag);
      const dI = Math.pow(Math.abs(Ii - greyFlat[pts[j].y * W + pts[j].x]), p);
      const r2 = dI / s2pow;
      const v  = kfn(r1, r2);
      K[i][j] = v;
      K[j][i] = v;
    }
    K[i][i] += delta;
  }
  return K;
}

// ── Main colourisation ────────────────────────────────────────────────────────

// pts: [{x, y, r, g, b}], greyFlat: Uint8Array (W*H), returns Uint8ClampedArray (W*H*4).
function colourise(pts, W, H, greyFlat, sigma1, sigma2, p, delta, kernel) {
  const n = pts.length;
  if (n === 0) return null;

  const diag  = Math.sqrt(W * W + H * H);
  const s2pow = sigma2 * Math.pow(255.0, p);
  const kfn   = _pickKernel(kernel);

  const K  = buildKD(pts, W, H, greyFlat, sigma1, sigma2, p, delta, kernel);
  const cR = pts.map(pt => pt.r);
  const cG = pts.map(pt => pt.g);
  const cB = pts.map(pt => pt.b);
  const [alphaR, alphaG, alphaB] = solveMultiRHS(K, [cR, cG, cB]);

  const ptI = pts.map(pt => greyFlat[pt.y * W + pt.x]);

  const out = new Uint8ClampedArray(W * H * 4);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const pix = py * W + px;
      const Iz  = greyFlat[pix];
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < n; i++) {
        const dx = px - pts[i].x;
        const dy = py - pts[i].y;
        const r1 = Math.sqrt(dx * dx + dy * dy) / (sigma1 * diag);
        const dI = Math.pow(Math.abs(Iz - ptI[i]), p);
        const r2 = dI / s2pow;
        const k  = kfn(r1, r2);
        r += k * alphaR[i];
        g += k * alphaG[i];
        b += k * alphaB[i];
      }
      const base   = pix * 4;
      out[base]     = r + 0.5;
      out[base + 1] = g + 0.5;
      out[base + 2] = b + 0.5;
      out[base + 3] = 255;
    }
  }
  return out;
}

// ── Point generators ──────────────────────────────────────────────────────────

class SeededRNG {
  constructor(seed) { this.s = ((seed ^ 0x12345678) >>> 0) || 1; }
  next() {
    this.s ^= this.s << 13;
    this.s ^= this.s >> 17;
    this.s ^= this.s << 5;
    return (this.s >>> 0) / 4294967296;
  }
  nextInt(max) { return Math.floor(this.next() * max); }
}

function generateGrid(W, H, colourFlat, gridW, gridH) {
  const pts = [];
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const x = Math.min(Math.round((gx + 0.5) * W / gridW), W - 1);
      const y = Math.min(Math.round((gy + 0.5) * H / gridH), H - 1);
      const b = (y * W + x) * 4;
      pts.push({ x, y, r: colourFlat[b], g: colourFlat[b + 1], b: colourFlat[b + 2] });
    }
  }
  return pts;
}

function generateRandom(W, H, colourFlat, n, seed) {
  const rng  = new SeededRNG(seed);
  const seen = new Set();
  const pts  = [];
  let iters  = 0;
  while (pts.length < n && iters < n * 100) {
    iters++;
    const x = rng.nextInt(W);
    const y = rng.nextInt(H);
    const key = y * W + x;
    if (!seen.has(key)) {
      seen.add(key);
      const b = key * 4;
      pts.push({ x, y, r: colourFlat[b], g: colourFlat[b + 1], b: colourFlat[b + 2] });
    }
  }
  return pts;
}

// ── Pipeline: blue-noise sampling + sigma heuristics ─────────────────────────

// Multi-source BFS Voronoi: for each pixel returns index of its nearest seed point
// (4-connectivity approximation to Euclidean nearest neighbour).
function voronoiLabel(pts, W, H) {
  const label = new Int32Array(W * H).fill(-1);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = Math.max(0, Math.min(W - 1, Math.round(pts[i].x)));
    const y = Math.max(0, Math.min(H - 1, Math.round(pts[i].y)));
    const idx = y * W + x;
    if (label[idx] === -1) { label[idx] = i; queue[tail++] = idx; }
  }
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  while (head < tail) {
    const idx = queue[head++];
    const cy = (idx / W) | 0, cx = idx % W, lbl = label[idx];
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const nidx = ny * W + nx;
      if (label[nidx] === -1) { label[nidx] = lbl; queue[tail++] = nidx; }
    }
  }
  return label;
}

// Multi-source BFS distance transform (4-connectivity).
// mask: Uint8Array(W*H), 1=seed. Returns Int32Array of distances in grid steps.
function distTransformBFS(mask, W, H) {
  const dist = new Int32Array(W * H).fill(-1);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
  }
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  while (head < tail) {
    const idx = queue[head++];
    const cy = (idx / W) | 0, cx = idx % W, d = dist[idx];
    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + DX[dir], ny = cy + DY[dir];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const nidx = ny * W + nx;
      if (dist[nidx] === -1) { dist[nidx] = d + 1; queue[tail++] = nidx; }
    }
  }
  return dist;
}

// Poisson-disk sampling from an array of candidate pixel objects {x, y}.
// Returns indices into pixels[] of the selected subset (length <= nTarget).
function _poissonDisk(pixels, nTarget, rng) {
  if (nTarget <= 0 || pixels.length === 0) return [];
  if (pixels.length <= nTarget) return Array.from({ length: pixels.length }, (_, i) => i);

  const r  = 0.75 * Math.sqrt(pixels.length / nTarget);
  const r2 = r * r;

  // Fisher-Yates shuffle
  const perm = Array.from({ length: pixels.length }, (_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = (rng.next() * (i + 1)) | 0;
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
  }

  // Bounding box for grid
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pixels) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const cell = Math.max(1, r);
  const gW = Math.ceil((maxX - minX) / cell) + 2;
  const gH = Math.ceil((maxY - minY) / cell) + 2;
  const grid = Array.from({ length: gW * gH }, () => []);

  const gIdx = (x, y) => (((y - minY) / cell) | 0) * gW + (((x - minX) / cell) | 0);

  const tooClose = (px, py) => {
    const gx = ((px - minX) / cell) | 0, gy = ((py - minY) / cell) | 0;
    for (let dgy = -2; dgy <= 2; dgy++) {
      const ngy = gy + dgy; if (ngy < 0 || ngy >= gH) continue;
      for (let dgx = -2; dgx <= 2; dgx++) {
        const ngx = gx + dgx; if (ngx < 0 || ngx >= gW) continue;
        for (const [qx, qy] of grid[ngy * gW + ngx]) {
          const dx = px - qx, dy = py - qy;
          if (dx * dx + dy * dy < r2) return true;
        }
      }
    }
    return false;
  };

  const selected = [];
  for (const idx of perm) {
    if (selected.length >= nTarget) break;
    const { x, y } = pixels[idx];
    if (!tooClose(x, y)) { selected.push(idx); grid[gIdx(x, y)].push([x, y]); }
  }
  // Pad with random draws if Poisson disk fell short
  if (selected.length < nTarget) {
    const selSet = new Set(selected);
    for (const idx of perm) {
      if (selected.length >= nTarget) break;
      if (!selSet.has(idx)) { selected.push(idx); selSet.add(idx); }
    }
  }
  return selected.slice(0, nTarget);
}

// Full blue-noise + greedy-fill sampling (matches 07b_sigma_heuristic._sample_blue_noise).
// smoothMask: Uint8Array(W*H), 1=edge 0=smooth.  Returns [{x,y,r,g,b}].
function sampleBlueNoise(W, H, colourFlat, greyFlat, n, smoothMask, densityRatio, fillFraction, seed) {
  const rng = new SeededRNG(seed);
  const edgePx = [], smoothPx = [];
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    if (smoothMask[i]) edgePx.push({ x, y }); else smoothPx.push({ x, y });
  }

  const nFill   = Math.max(1, Math.ceil(fillFraction * n));
  const nMain   = n - nFill;
  const totalW  = densityRatio * edgePx.length + smoothPx.length;
  const nEdge   = edgePx.length > 0 ? Math.round(nMain * densityRatio * edgePx.length / totalW) : 0;
  const nSmooth = nMain - nEdge;

  const edgeIdx  = _poissonDisk(edgePx,  nEdge,  rng);
  const smthIdx  = _poissonDisk(smoothPx, nSmooth, rng);

  const pts = [];
  const addPt = ({ x, y }) => {
    const b = (y * W + x) * 4;
    pts.push({ x, y, r: colourFlat[b], g: colourFlat[b + 1], b: colourFlat[b + 2] });
  };
  for (const i of edgeIdx)  addPt(edgePx[i]);
  for (const i of smthIdx)  addPt(smoothPx[i]);

  // Greedy fill: each step places a point at the pixel furthest from any existing point
  const mask = new Uint8Array(W * H);
  for (const p of pts) mask[p.y * W + p.x] = 1;
  for (let f = 0; f < nFill; f++) {
    const dist = distTransformBFS(mask, W, H);
    let maxD = -1, maxIdx = 0;
    for (let i = 0; i < W * H; i++) { if (dist[i] > maxD) { maxD = dist[i]; maxIdx = i; } }
    const nx = maxIdx % W, ny = (maxIdx / W) | 0;
    const b = (ny * W + nx) * 4;
    pts.push({ x: nx, y: ny, r: colourFlat[b], g: colourFlat[b + 1], b: colourFlat[b + 2] });
    mask[maxIdx] = 1;
  }
  return pts;
}

// Sigma heuristics from placed points (matches 09_pipeline.py inline computation).
// Returns { sigma1, sigma2 }.
function computeSigmasFromPoints(pts, W, H, greyFlat, p, beta1, beta2) {
  const diag  = Math.sqrt(W * W + H * H);
  const label = voronoiLabel(pts, W, H);

  // h_D: max Euclidean distance from any pixel to its nearest sample (covering radius)
  let hD = 0;
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    const nb = pts[label[i]];
    const dx = x - nb.x, dy = y - nb.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > hD) hD = d;
  }
  const sigma1 = hD / (diag * Math.sqrt(-Math.log(beta1)));

  // h_gamma = max over pixels of |grey[pixel] - grey[nearest_sample]|^p
  // Matches 09_pipeline.py: gap = abs(...)^p, sigma2 = h_gamma / (255^p * sqrt(-ln beta2))
  let hGamma = 0;
  for (let i = 0; i < W * H; i++) {
    const nb = pts[label[i]];
    const gap = Math.abs(greyFlat[i] - greyFlat[nb.y * W + nb.x]);
    const gapP = Math.pow(gap, p);
    if (gapP > hGamma) hGamma = gapP;
  }
  const MIN_SIGMA2 = 0.01;
  const sigma2 = Math.max(MIN_SIGMA2,
    hGamma > 0 ? hGamma / (Math.pow(255, p) * Math.sqrt(-Math.log(beta2))) : MIN_SIGMA2
  );

  return { sigma1, sigma2 };
}

// ── Edge detection ────────────────────────────────────────────────────────────
// Returns { rawMask, smoothMask } as Uint8Array(W*H), 1=edge 0=smooth.
// Matches the Python pipeline in 07_edge_detection.
function detectEdges(greyFlat, W, H) {
  const N = W * H;

  // 1. Gradient magnitude (forward finite differences)
  const grad = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i  = y * W + x;
      const gx = x < W - 1 ? greyFlat[i + 1] - greyFlat[i] : 0;
      const gy = y < H - 1 ? greyFlat[i + W] - greyFlat[i] : 0;
      grad[i]  = Math.sqrt(gx * gx + gy * gy);
    }
  }

  // 2. Clip at 95th percentile to suppress outlier spikes
  const sorted   = Float32Array.from(grad).sort();
  const clipVal  = sorted[Math.floor(0.95 * N)];
  const clipped  = new Float32Array(N);
  for (let i = 0; i < N; i++) clipped[i] = Math.min(grad[i], clipVal);

  // 3. Otsu threshold on clipped gradient (256-bin histogram)
  const bins     = 256;
  const invClip  = clipVal > 0 ? (bins - 1) / clipVal : 0;
  const hist     = new Float32Array(bins);
  for (let i = 0; i < N; i++) {
    hist[Math.min(bins - 1, Math.floor(clipped[i] * invClip))] += 1 / N;
  }
  let totalMean = 0;
  for (let i = 0; i < bins; i++) totalMean += i * hist[i];
  let bestVar = -1, tauBin = 0, cumW = 0, cumM = 0;
  for (let t = 0; t < bins; t++) {
    cumW += hist[t]; cumM += t * hist[t];
    if (cumW <= 0 || cumW >= 1) continue;
    const w2 = 1 - cumW, m2 = (totalMean - cumM) / w2;
    const v  = cumW * w2 * (cumM / cumW - m2) ** 2;
    if (v > bestVar) { bestVar = v; tauBin = t; }
  }
  let tau = clipVal > 0 ? tauBin / invClip : 0;

  // Constrain: 10th–90th percentile of clipped gradient
  tau = Math.max(sorted[Math.floor(0.10 * N)], Math.min(sorted[Math.floor(0.90 * N)], tau));

  // 4. Raw binary mask
  const rawMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) rawMask[i] = clipped[i] >= tau ? 1 : 0;

  // 5. Gaussian smooth (sigma=1, truncate=3.5) and re-threshold at 0.5
  const sigma = 1, tr = 3.5;
  const r     = Math.ceil(tr * sigma);
  const k     = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = 0; i <= 2 * r; i++) { k[i] = Math.exp(-0.5 * ((i - r) / sigma) ** 2); s += k[i]; }
  for (let i = 0; i <= 2 * r; i++) k[i] /= s;

  const blurred    = _gaussFilter(rawMask, W, H, k);
  const smoothMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) smoothMask[i] = blurred[i] >= 0.5 ? 1 : 0;

  return { rawMask, smoothMask };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

// Frobenius norm ||ref - out||_F over RGB channels (matches Python implementation)
function frobeniusNorm(refFlat, outFlat, W, H) {
  let sum = 0;
  for (let i = 0; i < W * H; i++) {
    const b = i * 4;
    const dr = refFlat[b]     - outFlat[b];
    const dg = refFlat[b + 1] - outFlat[b + 1];
    const db = refFlat[b + 2] - outFlat[b + 2];
    sum += dr * dr + dg * dg + db * db;
  }
  return Math.sqrt(sum);
}

// 1-D normalised Gaussian kernel, sigma=1.5, truncate=3.5 (matches scipy default)
function _gaussKernel1D() {
  const sigma = 1.5, truncate = 3.5;
  const r = Math.ceil(truncate * sigma);
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = 0; i <= 2 * r; i++) {
    k[i] = Math.exp(-0.5 * ((i - r) / sigma) ** 2);
    s += k[i];
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

// Separable 2-D Gaussian filter, reflect boundary (matches scipy reflect mode)
function _gaussFilter(data, W, H, k) {
  const r   = (k.length - 1) / 2;
  const tmp = new Float64Array(W * H);
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let t = 0; t < k.length; t++) {
        let xi = x + t - r;
        if (xi < 0) xi = -xi; else if (xi >= W) xi = 2 * W - 2 - xi;
        v += data[y * W + xi] * k[t];
      }
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let t = 0; t < k.length; t++) {
        let yi = y + t - r;
        if (yi < 0) yi = -yi; else if (yi >= H) yi = 2 * H - 2 - yi;
        v += tmp[yi * W + x] * k[t];
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

// SSIM matching skimage: gaussian_weights=True, sigma=1.5, use_sample_covariance=False
// refFlat / outFlat: Uint8Array or Uint8ClampedArray, W*H*4 RGBA
function ssimIndex(refFlat, outFlat, W, H) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const k  = _gaussKernel1D();
  let total = 0;
  for (let ch = 0; ch < 3; ch++) {
    const a = new Float64Array(W * H);
    const b = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) { a[i] = refFlat[i * 4 + ch]; b[i] = outFlat[i * 4 + ch]; }
    const ux  = _gaussFilter(a, W, H, k);
    const uy  = _gaussFilter(b, W, H, k);
    const ab  = new Float64Array(W * H);
    const aa  = new Float64Array(W * H);
    const bb  = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) { aa[i] = a[i]*a[i]; bb[i] = b[i]*b[i]; ab[i] = a[i]*b[i]; }
    const uxx = _gaussFilter(aa, W, H, k);
    const uyy = _gaussFilter(bb, W, H, k);
    const uxy = _gaussFilter(ab, W, H, k);
    let s = 0;
    for (let i = 0; i < W * H; i++) {
      const vx  = uxx[i] - ux[i] * ux[i];
      const vy  = uyy[i] - uy[i] * uy[i];
      const vxy = uxy[i] - ux[i] * uy[i];
      s += (2 * ux[i] * uy[i] + C1) * (2 * vxy + C2)
         / ((ux[i] ** 2 + uy[i] ** 2 + C1) * (vx + vy + C2));
    }
    total += s / (W * H);
  }
  return total / 3;
}
