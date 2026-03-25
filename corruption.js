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
  const warpS          = 0.5 + rng() * 1.5;
  const noiseWarp      = 0.1 + rng() * 0.2;

  // Photocopy contrast: strong curves push collapsing midtones toward black/white
  const contrastGamma  = 1.4 + rng() * 1.2;   // power curve — higher = more crushed midtones
  const blackLift      = 0.0 + rng() * 0.08;   // lift blacks slightly (photocopy grey cast)
  const whiteCrush     = 0.92 + rng() * 0.08;  // compress highlights

  // Tonal noise: integrated into the image, not placed on top
  // Two layers: coarse (large tonal regions) and fine (halftone breakdown)
  const coarseScale    = 1.5 + rng() * 2.5;
  const fineScale      = 8.0 + rng() * 14.0;   // high frequency for halftone feel
  const tonerNoiseAmp  = 0.12 + rng() * 0.22;  // how much tonal noise in survived areas
  const boundaryNoiseAmp = 0.35 + rng() * 0.35; // stronger noise at dissolve boundary

  // Dissolve boundary texture: streaky, directional (like toner running out)
  // Use anisotropic noise — stretched in one axis — for streaky feel
  const streakAngle    = rng() * Math.PI;
  const streakCos      = Math.cos(streakAngle), streakSin = Math.sin(streakAngle);
  const streakStretch  = 3.0 + rng() * 5.0;    // how elongated the streaks are
  const streakScale    = 3.0 + rng() * 5.0;

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;
      let r = data[idx], g = data[idx+1], b = data[idx+2];

      // Greyscale
      let lum = r * 0.299 + g * 0.587 + b * 0.114;

      // Distance from survival origin, domain-warped
      const distRaw = Math.sqrt((nx - originX)**2 + (ny - originY)**2);
      const wx = (fbm(nfn, nx*warpS+7.3, ny*warpS+2.1, 3, lacunarity, rng) + 1) / 2;
      const wy = (fbm(nfn, nx*warpS+3.1, ny*warpS+8.7, 3, lacunarity, rng) + 1) / 2;
      const warpedDist = distRaw + (wx - 0.5) * noiseWarp * 2 + (wy - 0.5) * noiseWarp;

      // Streaky anisotropic noise for boundary texture
      // Rotate coords, then stretch one axis — creates elongated toner-streak shapes
      const rx = (nx - 0.5) * streakCos - (ny - 0.5) * streakSin;
      const ry = (nx - 0.5) * streakSin + (ny - 0.5) * streakCos;
      const sn = (fbm(nfn, rx * streakScale * streakStretch + 31, ry * streakScale + 11, 5, lacunarity, rng) + 1) / 2;
      const sn2 = (fbm(nfn, rx * streakScale * streakStretch * 0.5 + 73, ry * streakScale * 0.5 + 53, 4, lacunarity, rng) + 1) / 2;
      const streakMask = sn * 0.6 + sn2 * 0.4;

      // Dissolve field driven by streaky noise
      const distNorm = (warpedDist - survivalRadius) / dissolveWidth;
      const dissolveField = clamp(distNorm + (streakMask - 0.5) * 1.6, 0, 1);
      const eraseAmt = smoothstep(dissolveField);
      const survived = 1 - eraseAmt;
      const boundaryZone = eraseAmt * survived * 4; // peaks at boundary edge

      // ── Photocopy contrast treatment on survived areas ──
      if (survived > 0.01) {
        let n = lum / 255;

        // 1. Tonal noise integrated into luminance BEFORE threshold
        //    Coarse noise creates regional tonal variation (uneven toner)
        const cn = (fbm(nfn, nx*coarseScale+5, ny*coarseScale+17, 4, lacunarity, rng) + 1) / 2;
        //    Fine noise creates halftone-breakdown texture
        const fn = (nfn(px * fineScale * 0.01 + (seed & 0xff) * 0.1, py * fineScale * 0.01) + 1) / 2;
        const tonerNoise = (cn * 0.6 + fn * 0.4 - 0.5) * tonerNoiseAmp * survived;
        n = clamp(n + tonerNoise, 0, 1);

        // 2. Power curve — collapses midtones, pushes toward black/white
        n = Math.pow(n, contrastGamma);

        // 3. Black lift + white crush (photocopy doesn't reach true black or white)
        n = blackLift + n * (whiteCrush - blackLift);

        lum = n * 255;
      }

      // ── Boundary zone: toner running out ──
      // In the dissolve zone, add streaky tonal noise that pushes lum toward white
      if (boundaryZone > 0.01) {
        const bleach = boundaryZone * boundaryNoiseAmp * streakMask;
        lum = clamp(lum + bleach * 255, 0, 255);
      }

      r = g = b = lum;

      // ── Erase to white ──
      r = r + (255 - r) * eraseAmt;
      g = g + (255 - g) * eraseAmt;
      b = b + (255 - b) * eraseAmt;

      data[idx] = r; data[idx+1] = g; data[idx+2] = b;
    }
  }
}

function corruptColour(data, w, h, seed, rng, nfn) {
  const lacunarity = 1.7 + rng() * 0.6;

  // Same directional dissolve logic as B&W — one side survives, other bleaches out
  const originX = rng() < 0.5 ? rng() * 0.3 : 0.7 + rng() * 0.3;
  const originY = rng() < 0.5 ? rng() * 0.3 : 0.7 + rng() * 0.3;

  const survivalRadius = 0.2 + rng() * 0.4;
  const dissolveWidth  = 0.25 + rng() * 0.45;
  const warpS          = 0.5 + rng() * 1.5;
  const noiseWarp      = 0.1 + rng() * 0.2;

  // Contrast: surviving areas get their colours intensified
  const contrastGamma  = 1.2 + rng() * 0.8;   // slightly gentler than B&W
  const satBoost       = 1.1 + rng() * 0.4;    // push colours more vivid where survived

  // Tonal noise — same two-layer approach as B&W
  const coarseScale    = 1.5 + rng() * 2.5;
  const fineScale      = 7.0 + rng() * 12.0;
  const tonerNoiseAmp  = 0.08 + rng() * 0.16;
  const boundaryNoiseAmp = 0.3 + rng() * 0.3;

  // Streaky anisotropic boundary noise
  const streakAngle   = rng() * Math.PI;
  const streakCos     = Math.cos(streakAngle), streakSin = Math.sin(streakAngle);
  const streakStretch = 3.0 + rng() * 5.0;
  const streakScale   = 3.0 + rng() * 5.0;

  // Overexposure colour: each channel bleaches at slightly different rate
  // — red bleaches fastest (like cyan dye fading), blue slowest
  // This gives the faint colour whisper in burned areas
  const bleachR = 0.85 + rng() * 0.15;  // how far red channel bleaches (toward 255)
  const bleachG = 0.80 + rng() * 0.15;
  const bleachB = 0.70 + rng() * 0.20;  // blue retains more — slightly cool cast in burned areas

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;
      let r = data[idx], g = data[idx+1], b = data[idx+2];

      // Distance from survival origin, domain-warped
      const distRaw = Math.sqrt((nx - originX)**2 + (ny - originY)**2);
      const wx = (fbm(nfn, nx*warpS+7.3, ny*warpS+2.1, 3, lacunarity, rng) + 1) / 2;
      const wy = (fbm(nfn, nx*warpS+3.1, ny*warpS+8.7, 3, lacunarity, rng) + 1) / 2;
      const warpedDist = distRaw + (wx - 0.5) * noiseWarp * 2 + (wy - 0.5) * noiseWarp;

      // Streaky anisotropic noise for boundary
      const rx = (nx - 0.5) * streakCos - (ny - 0.5) * streakSin;
      const ry = (nx - 0.5) * streakSin + (ny - 0.5) * streakCos;
      const sn  = (fbm(nfn, rx * streakScale * streakStretch + 31, ry * streakScale + 11, 5, lacunarity, rng) + 1) / 2;
      const sn2 = (fbm(nfn, rx * streakScale * streakStretch * 0.5 + 73, ry * streakScale * 0.5 + 53, 4, lacunarity, rng) + 1) / 2;
      const streakMask = sn * 0.6 + sn2 * 0.4;

      // Dissolve field
      const distNorm = (warpedDist - survivalRadius) / dissolveWidth;
      const dissolveField = clamp(distNorm + (streakMask - 0.5) * 1.6, 0, 1);
      const eraseAmt = smoothstep(dissolveField);
      const survived = 1 - eraseAmt;
      const boundaryZone = eraseAmt * survived * 4;

      // ── Contrast + saturation boost on surviving areas ──
      if (survived > 0.01) {
        const lum = r * 0.299 + g * 0.587 + b * 0.114;

        // Tonal noise — same two-layer approach, per-channel for colour variation
        const cn  = (fbm(nfn, nx*coarseScale+5, ny*coarseScale+17, 4, lacunarity, rng) + 1) / 2;
        const fn  = (nfn(px * fineScale * 0.01 + (seed & 0xff) * 0.1, py * fineScale * 0.01) + 1) / 2;
        const tonerNoise = (cn * 0.6 + fn * 0.4 - 0.5) * tonerNoiseAmp * survived;

        // Apply power curve to each channel independently (richer colour contrast)
        let rn = clamp(r / 255 + tonerNoise, 0, 1);
        let gn = clamp(g / 255 + tonerNoise, 0, 1);
        let bn = clamp(b / 255 + tonerNoise, 0, 1);

        rn = Math.pow(rn, contrastGamma);
        gn = Math.pow(gn, contrastGamma);
        bn = Math.pow(bn, contrastGamma);

        // Saturation boost: move each channel away from luminance
        const lumN = rn * 0.299 + gn * 0.587 + bn * 0.114;
        rn = clamp(lumN + (rn - lumN) * satBoost * survived, 0, 1);
        gn = clamp(lumN + (gn - lumN) * satBoost * survived, 0, 1);
        bn = clamp(lumN + (bn - lumN) * satBoost * survived, 0, 1);

        r = rn * 255; g = gn * 255; b = bn * 255;
      }

      // ── Boundary: streaky tonal bleach ──
      if (boundaryZone > 0.01) {
        const bleach = boundaryZone * boundaryNoiseAmp * streakMask;
        r = clamp(r + bleach * 255, 0, 255);
        g = clamp(g + bleach * 255, 0, 255);
        b = clamp(b + bleach * 255, 0, 255);
      }

      // ── Overexposure burn — channels fade at different rates ──
      // Each channel bleaches toward 255 at its own speed,
      // leaving a faint colour whisper in the most burned areas.
      r = r + (255 - r) * eraseAmt * bleachR;
      g = g + (255 - g) * eraseAmt * bleachG;
      b = b + (255 - b) * eraseAmt * bleachB;

      data[idx] = r; data[idx+1] = g; data[idx+2] = b;
    }
  }
}

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
