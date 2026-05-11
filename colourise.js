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
