/**
 * corruption.js — The Museum of Memory
 * Organic decay engine + double exposure compositing.
 * Everything is seed-driven. Nothing is exposed as a parameter.
 */

// ── Noise utilities ──────────────────────────────────────────────────────────

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

function buildPerm(rng) {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

function makeNoise(rng) {
  const perm = buildPerm(rng);
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  const grad = (h, x, y) => { const a = h * 2.3998; return Math.cos(a) * x + Math.sin(a) * y; };
  return function (x, y) {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = perm[(perm[xi] + yi) & 255], ab = perm[(perm[xi] + yi + 1) & 255];
    const ba = perm[(perm[xi + 1] + yi) & 255], bb = perm[(perm[xi + 1] + yi + 1) & 255];
    return lerp(lerp(grad(aa,xf,yf), grad(ba,xf-1,yf), u), lerp(grad(ab,xf,yf-1), grad(bb,xf-1,yf-1), u), v);
  };
}

function fbm(nfn, x, y, oct, lac, rng) {
  let v = 0, a = 0.5, f = 1, m = 0;
  const ox = Array.from({length: oct}, () => rng() * 80 - 40);
  const oy = Array.from({length: oct}, () => rng() * 80 - 40);
  for (let i = 0; i < oct; i++) { v += nfn(x*f+ox[i], y*f+oy[i])*a; m+=a; a*=0.5; f*=lac; }
  return v / m;
}

function toSepia(r, g, b, t) {
  return [
    r + (r*0.393 + g*0.769 + b*0.189 - r) * t,
    g + (r*0.349 + g*0.686 + b*0.168 - g) * t,
    b + (r*0.272 + g*0.534 + b*0.131 - b) * t
  ];
}

function smoothstep(t) { return t * t * (3 - 2 * t); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ── B&W detection ────────────────────────────────────────────────────────────

function detectBW(data, w, h) {
  const step = Math.max(1, Math.floor(Math.sqrt(w * h) / 80));
  let totalSat = 0, count = 0;
  for (let py = 0; py < h; py += step) {
    for (let px = 0; px < w; px += step) {
      const i = (py * w + px) * 4;
      const r = data[i] / 255, g = data[i+1] / 255, b = data[i+2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      totalSat += max > 0 ? (max - min) / max : 0;
      count++;
    }
  }
  return (totalSat / count) < 0.08;
}

// ── Shared dust map ───────────────────────────────────────────────────────────

function buildDustMap(w, h, rng) {
  const num = Math.floor(w * h * (0.001 + rng() * 0.004));
  const map = new Float32Array(w * h);
  for (let i = 0; i < num; i++) {
    const dx = Math.floor(rng() * w), dy = Math.floor(rng() * h);
    const dr = 0.4 + rng() * 1.6;
    const x0 = Math.max(0, Math.floor(dx-dr-1)), x1 = Math.min(w-1, Math.ceil(dx+dr+1));
    const y0 = Math.max(0, Math.floor(dy-dr-1)), y1 = Math.min(h-1, Math.ceil(dy+dr+1));
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const d = Math.sqrt((ix-dx)**2+(iy-dy)**2);
        if (d <= dr) map[iy*w+ix] = Math.max(map[iy*w+ix], 1 - d/dr);
      }
    }
  }
  return map;
}

// ── B&W corruption ────────────────────────────────────────────────────────────
// Directional dissolve: surviving core gets contrast-boosted,
// boundary disintegrates into black particle grain on white.

function corruptBW(data, w, h, seed, rng, nfn) {
  const lacunarity = 1.7 + rng() * 0.6;

  // Survival origin — biased to edge/corner so one side survives, other fades
  const originX = rng() < 0.5 ? rng() * 0.3 : 0.7 + rng() * 0.3;
  const originY = rng() < 0.5 ? rng() * 0.3 : 0.7 + rng() * 0.3;

  const survivalRadius = 0.2 + rng() * 0.4;
  const dissolveWidth  = 0.25 + rng() * 0.45;
  const noiseScale     = 2.5 + rng() * 5.0;
  const warpS          = 0.5 + rng() * 1.5;
  const noiseWarp      = 0.1 + rng() * 0.2;
  const contrastBoost  = 0.3 + rng() * 0.5;
  const grainDensity   = 0.45 + rng() * 0.55;
  const grainScale     = 0.7 + rng() * 1.4;

  const dustMap = buildDustMap(w, h, rng);

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;
      let r = data[idx], g = data[idx+1], b = data[idx+2];

      // Greyscale
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r = g = b = lum;

      // Distance from survival origin, domain-warped for organic boundary
      const distRaw = Math.sqrt((nx - originX)**2 + (ny - originY)**2);
      const wx = (fbm(nfn, nx*warpS+7.3, ny*warpS+2.1, 3, lacunarity, rng) + 1) / 2;
      const wy = (fbm(nfn, nx*warpS+3.1, ny*warpS+8.7, 3, lacunarity, rng) + 1) / 2;
      const warpedDist = distRaw + (wx - 0.5) * noiseWarp * 2 + (wy - 0.5) * noiseWarp;

      // Fine particulate noise for the dissolving boundary texture
      const fn1 = (fbm(nfn, nx*noiseScale,            ny*noiseScale,            6, lacunarity, rng) + 1) / 2;
      const fn2 = (fbm(nfn, nx*noiseScale*2.3 + 19,   ny*noiseScale*2.3 + 41,   4, lacunarity, rng) + 1) / 2;
      const boundary = fn1 * 0.6 + fn2 * 0.4;

      // Dissolve field: 0 = survived, 1 = erased
      const distNorm = (warpedDist - survivalRadius) / dissolveWidth;
      const dissolveField = clamp(distNorm + (boundary - 0.5) * 1.4, 0, 1);
      const eraseAmt = smoothstep(dissolveField);
      const survived = 1 - eraseAmt;
      const boundaryZone = eraseAmt * survived * 4;

      // Contrast boost on surviving areas — blacks pushed darker
      if (survived > 0.02) {
        const norm = lum / 255;
        r = g = b = Math.pow(norm, 1 + contrastBoost * survived) * 255;
      }

      // Erase to white
      r = r + (255 - r) * eraseAmt;
      g = g + (255 - g) * eraseAmt;
      b = b + (255 - b) * eraseAmt;

      // Particulate grain — thresholded dark dots, dense at boundary
      const gn = (nfn(px * grainScale + (seed & 0xff), py * grainScale + ((seed >> 8) & 0xff)) + 1) / 2;
      const thresh = 1 - grainDensity * (boundaryZone * 0.85 + survived * 0.12);
      if (gn > thresh) {
        const str = (gn - thresh) / (1 - thresh);
        const dark = str * str * 210 * (boundaryZone * 0.75 + survived * 0.18);
        r = clamp(r - dark, 0, 255);
        g = clamp(g - dark, 0, 255);
        b = clamp(b - dark, 0, 255);
      }

      // Dust
      const dv = dustMap[py * w + px];
      if (dv > 0) {
        r = clamp(r * (1 - dv * 0.8), 0, 255);
        g = clamp(g * (1 - dv * 0.8), 0, 255);
        b = clamp(b * (1 - dv * 0.8), 0, 255);
      }

      data[idx] = r; data[idx+1] = g; data[idx+2] = b;
    }
  }
}

// ── Colour corruption ─────────────────────────────────────────────────────────
// Organic patch/vignette dissolution. No scratches, no warm paper bias.
// Fade destination derived from the image's own average tone.

function corruptColour(data, w, h, seed, rng, nfn) {
  const globalDecay   = 0.75 + rng() * 0.25;
  const scaleX        = 1.0 + rng() * 5.0;
  const scaleY        = 1.0 + rng() * 5.0;
  const lacunarity    = 1.6 + rng() * 0.8;
  const vigCx         = 0.2 + rng() * 0.6;
  const vigCy         = 0.2 + rng() * 0.6;
  const vigPow        = 0.7 + rng() * 3.0;
  const vigStr        = 0.9 + rng() * 1.6;
  const warpS         = 0.4 + rng() * 2.0;
  const warpA         = 0.1 + rng() * 0.22;
  const eraseThresh   = 0.22 + rng() * 0.28;
  const edgeSharpness = 8 + rng() * 22;
  const grainAmp      = 35 + rng() * 65;
  const grainScale    = 0.25 + rng() * 0.5;

  // Sample image to derive a bleach fade tone (image-specific, not warm paper)
  let sumR = 0, sumG = 0, sumB = 0, n = 0;
  const step = Math.max(4, Math.floor(Math.sqrt(w * h) / 60));
  for (let py = 0; py < h; py += step) {
    for (let px = 0; px < w; px += step) {
      const i = (py * w + px) * 4;
      sumR += data[i]; sumG += data[i+1]; sumB += data[i+2]; n++;
    }
  }
  const avgLum = (sumR/n * 0.299 + sumG/n * 0.587 + sumB/n * 0.114);
  const fadeR = clamp(sumR/n * 0.3 + avgLum * 0.5 + 80, 200, 252);
  const fadeG = clamp(sumG/n * 0.3 + avgLum * 0.5 + 80, 200, 252);
  const fadeB = clamp(sumB/n * 0.3 + avgLum * 0.5 + 80, 200, 252);

  const numP = 14 + Math.floor(rng() * 24);
  const patches = Array.from({length: numP}, () => ({
    cx: rng(), cy: rng(),
    rx: 0.05 + rng() * 0.40, ry: 0.04 + rng() * 0.30,
    angle: rng() * Math.PI, str: 0.65 + rng() * 0.35
  }));
  const w0 = 0.25 + rng() * 0.5, w1 = 0.15 + rng() * 0.5, w2 = 0.15 + rng() * 0.5;
  const wSum = w0 + w1 + w2;

  const dustMap = buildDustMap(w, h, rng);

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;
      let r = data[idx], g = data[idx+1], b = data[idx+2];

      const wx = fbm(nfn, nx*warpS+3.7, ny*warpS+9.2, 3, lacunarity, rng);
      const wy = fbm(nfn, nx*warpS+1.3, ny*warpS+6.8, 3, lacunarity, rng);
      const n1 = (fbm(nfn, nx*scaleX+wx*warpA*scaleX, ny*scaleY+wy*warpA*scaleY, 7, lacunarity, rng)+1)/2;
      const n2 = (fbm(nfn, nx*scaleX*1.8+41, ny*scaleY*1.8+17, 4, lacunarity, rng)+1)/2;
      const noiseMask = n1*0.6 + n2*0.4;

      const dxv = (nx-vigCx)*1.6, dyv = (ny-vigCy)*1.6;
      const vigMask = clamp(Math.pow(Math.max(0, Math.sqrt(dxv*dxv+dyv*dyv)-0.18), vigPow)*vigStr, 0, 1);

      let patchMask = 0;
      for (const p of patches) {
        const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
        const rdx = (nx-p.cx)*ca - (ny-p.cy)*sa;
        const rdy = (nx-p.cx)*sa + (ny-p.cy)*ca;
        const dist = Math.sqrt((rdx/p.rx)**2 + (rdy/p.ry)**2);
        if (dist < 1) {
          const pn = (nfn(px*0.09+p.cx*30, py*0.09+p.cy*30)+1)/2;
          patchMask = Math.max(patchMask, (1 - dist*(0.7+pn*0.3)) * p.str);
        }
      }

      const raw      = (noiseMask*w0 + vigMask*w1 + patchMask*w2) / wSum * globalDecay;
      const norm     = (raw - eraseThresh) * edgeSharpness;
      const eraseAmt = clamp(1 / (1 + Math.exp(-norm)), 0, 1);
      const survived = 1 - eraseAmt;
      const surviveDecay = clamp(raw / eraseThresh, 0, 1);

      r = r + (fadeR - r) * eraseAmt;
      g = g + (fadeG - g) * eraseAmt;
      b = b + (fadeB - b) * eraseAmt;

      const boundaryZone = eraseAmt * survived * 4;
      const gn = (nfn(px*grainScale+(seed&0xff), py*grainScale)+1)/2;
      const grain = (gn - 0.5) * grainAmp * (0.04 + surviveDecay*0.2 + boundaryZone*1.0);
      r = clamp(r + grain, 0, 255);
      g = clamp(g + grain, 0, 255);
      b = clamp(b + grain, 0, 255);

      const dv = dustMap[py * w + px];
      if (dv > 0) {
        r = clamp(r * (1 - dv * 0.8), 0, 255);
        g = clamp(g * (1 - dv * 0.8), 0, 255);
        b = clamp(b * (1 - dv * 0.8), 0, 255);
      }

      data[idx] = r; data[idx+1] = g; data[idx+2] = b;
    }
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function corruptImageData(imgData, w, h, seed) {
  const data = imgData.data;
  const rng  = seededRng(seed);
  const nfn  = makeNoise(rng);
  const isBW = detectBW(data, w, h);
  if (isBW) {
    corruptBW(data, w, h, seed, rng, nfn);
  } else {
    corruptColour(data, w, h, seed, rng, nfn);
  }
  return imgData;
}


// ── Double exposure compositing ──────────────────────────────────────────────

/**
 * Available Canvas composite operations that produce interesting double exposures.
 * Excludes destructive/invisible modes.
 */
const BLEND_MODES = [
  'multiply',
  'screen',
  'overlay',
  'soft-light',
  'hard-light',
  'color-dodge',
  'color-burn',
  'difference',
  'exclusion',
  'luminosity',
  'color',
];

/**
 * Composite two already-corrupted canvases into a final ImageData.
 * @param {HTMLCanvasElement} canvasA - corrupted image A (reference size)
 * @param {HTMLCanvasElement} canvasB - corrupted image B (will be scaled/shifted)
 * @param {number} seed               - compositing seed
 * @returns {ImageData}
 */
function composeDouble(canvasA, canvasB, seed) {
  const rng = seededRng(seed ^ 0xdeadbeef);

  const W = canvasA.width;
  const H = canvasA.height;

  // Pick blend mode randomly
  const blendMode = BLEND_MODES[Math.floor(rng() * BLEND_MODES.length)];

  // Opacity weights — never fully transparent, always interesting
  const opacityA = 0.5 + rng() * 0.45;   // dominant layer
  const opacityB = 0.35 + rng() * 0.55;  // second layer

  // Positional drift — slight misalignment like a double-exposed frame
  // Max ±6% offset in each axis, seeded
  const driftX = (rng() - 0.5) * W * 0.12;
  const driftY = (rng() - 0.5) * H * 0.12;

  // Scale of second image — can be slightly zoomed in or out
  const scaleB = 0.88 + rng() * 0.26;

  // Optional horizontal flip of B (like winding the film backwards)
  const flipB = rng() > 0.6;

  // Compose on an offscreen canvas
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');

  // Layer A
  ctx.globalAlpha = opacityA;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(canvasA, 0, 0, W, H);

  // Layer B — transformed
  ctx.save();
  ctx.globalAlpha = opacityB;
  ctx.globalCompositeOperation = blendMode;
  ctx.translate(W/2 + driftX, H/2 + driftY);
  ctx.scale(flipB ? -scaleB : scaleB, scaleB);
  ctx.drawImage(canvasB, -W/2, -H/2, W, H);
  ctx.restore();

  // Subtle unified tone pass — reinforce the sense of a single surface
  ctx.globalAlpha = 0.08 + rng() * 0.12;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgb(${Math.floor(180 + rng()*30)},${Math.floor(160 + rng()*25)},${Math.floor(130 + rng()*25)})`;
  ctx.fillRect(0, 0, W, H);

  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

window.MemoryCorruption = {
  /**
   * Corrupt a single image. Returns a canvas element.
   * @param {HTMLImageElement} img
   * @param {number} seed
   */
  single(img, seed) {
    const MAX = 1400;
    let sw = img.naturalWidth, sh = img.naturalHeight;
    if (sw > MAX) { sh = Math.round(sh * MAX / sw); sw = MAX; }

    const cv = document.createElement('canvas');
    cv.width = sw; cv.height = sh;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, sw, sh);
    const id = ctx.getImageData(0, 0, sw, sh);
    corruptImageData(id, sw, sh, seed);
    ctx.putImageData(id, 0, 0);
    return cv;
  },

  /**
   * Create a double exposure from two images.
   * Each is independently corrupted, then composited.
   * @param {HTMLImageElement} imgA
   * @param {HTMLImageElement} imgB
   * @param {number} seedA  - corruption seed for image A
   * @param {number} seedB  - corruption seed for image B
   * @param {number} seedC  - compositing seed
   * @returns {HTMLCanvasElement}
   */
  double(imgA, imgB, seedA, seedB, seedC) {
    // Normalise both images to the same dimensions (A drives the frame)
    const MAX = 1400;
    let W = imgA.naturalWidth, H = imgA.naturalHeight;
    if (W > MAX) { H = Math.round(H * MAX / W); W = MAX; }

    // Corrupt A
    const cvA = document.createElement('canvas');
    cvA.width = W; cvA.height = H;
    const ctxA = cvA.getContext('2d');
    ctxA.drawImage(imgA, 0, 0, W, H);
    const idA = ctxA.getImageData(0, 0, W, H);
    corruptImageData(idA, W, H, seedA);
    ctxA.putImageData(idA, 0, 0);

    // Corrupt B (scaled to match A's frame)
    const cvB = document.createElement('canvas');
    cvB.width = W; cvB.height = H;
    const ctxB = cvB.getContext('2d');
    // Fit B into A's frame, preserving B's aspect ratio (cover)
    const ratioB = imgB.naturalWidth / imgB.naturalHeight;
    const ratioA = W / H;
    let bw, bh, bx, by;
    if (ratioB > ratioA) { bh = H; bw = bh * ratioB; bx = (W-bw)/2; by = 0; }
    else                 { bw = W; bh = bw / ratioB; bx = 0; by = (H-bh)/2; }
    ctxB.drawImage(imgB, bx, by, bw, bh);
    const idB = ctxB.getImageData(0, 0, W, H);
    corruptImageData(idB, W, H, seedB);
    ctxB.putImageData(idB, 0, 0);

    // Composite
    return composeDouble(cvA, cvB, seedC);
  }
};
