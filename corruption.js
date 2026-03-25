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

// ── Dissolve field builder ────────────────────────────────────────────────────
// Returns a Float32Array [0..1] per pixel: 0 = survived, 1 = fully erased.
// Randomly selects from several structural modes, then modulates with streaky
// anisotropic noise. Survival pockets punch back through erased regions.

function buildDissolveField(w, h, rng, nfn) {
  const lacunarity = 1.7 + rng() * 0.6;
  const field = new Float32Array(w * h);

  // ── Mode selection ────────────────────────────────────────────────────────
  const modeRoll = rng();
  let mode;
  if      (modeRoll < 0.28) mode = 'edge';        // single edge/corner origin (original)
  else if (modeRoll < 0.48) mode = 'interior';     // burn from inside outward
  else if (modeRoll < 0.63) mode = 'band';         // horizontal or vertical band dissolves
  else if (modeRoll < 0.78) mode = 'dual';         // two competing origins
  else                       mode = 'centre-out';  // centre survives, edges burn

  // ── Shared warp field ─────────────────────────────────────────────────────
  const warpS     = 0.5 + rng() * 1.5;
  const noiseWarp = 0.08 + rng() * 0.22;

  // ── Streaky anisotropic boundary noise ────────────────────────────────────
  // Angle rotates slowly across the image (spatially varying) for curved streaks
  const baseAngle     = rng() * Math.PI;
  const angleVaryAmp  = rng() * 0.6;   // 0 = uniform direction, 0.6 = gently curving
  const angleVaryFreq = 0.8 + rng() * 1.5;
  const streakStretch = 3.0 + rng() * 6.0;
  const streakScale   = 2.5 + rng() * 5.5;
  const streakWeight  = 1.2 + rng() * 0.8;  // how much streaks distort the boundary

  // ── Mode-specific params ──────────────────────────────────────────────────
  // Edge/corner origin
  const originX = rng() < 0.5 ? rng() * 0.25 : 0.75 + rng() * 0.25;
  const originY = rng() < 0.5 ? rng() * 0.25 : 0.75 + rng() * 0.25;

  // Second origin for dual mode
  const origin2X = 1 - originX + (rng() - 0.5) * 0.3;
  const origin2Y = 1 - originY + (rng() - 0.5) * 0.3;

  // Interior burn origin (mid-image)
  const intX = 0.25 + rng() * 0.5;
  const intY = 0.25 + rng() * 0.5;

  // Band axis and position
  const bandVertical = rng() > 0.5;
  const bandCentre   = 0.2 + rng() * 0.6;
  const bandWidth    = 0.15 + rng() * 0.35;

  // Survival radius / dissolve width (shared)
  const survivalRadius = 0.18 + rng() * 0.42;
  const dissolveWidth  = 0.22 + rng() * 0.48;

  // ── Survival pockets ──────────────────────────────────────────────────────
  // Islands of surviving image inside erased zones
  const numPockets = Math.floor(rng() * 5);  // 0–4 pockets
  const pockets = Array.from({ length: numPockets }, () => ({
    x:      0.1 + rng() * 0.8,
    y:      0.1 + rng() * 0.8,
    radius: 0.04 + rng() * 0.12,
    soft:   0.03 + rng() * 0.06
  }));

  // ── Build field ───────────────────────────────────────────────────────────
  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;

      // Domain warp
      const wx = (fbm(nfn, nx*warpS+7.3, ny*warpS+2.1, 3, lacunarity, rng) + 1) / 2;
      const wy = (fbm(nfn, nx*warpS+3.1, ny*warpS+8.7, 3, lacunarity, rng) + 1) / 2;
      const warpX = nx + (wx - 0.5) * noiseWarp;
      const warpY = ny + (wy - 0.5) * noiseWarp;

      // Spatially-varying streak angle
      const angleVar = (nfn(nx * angleVaryFreq + 5.1, ny * angleVaryFreq + 2.7)) * angleVaryAmp;
      const angle = baseAngle + angleVar;
      const sc = Math.cos(angle), ss = Math.sin(angle);
      const rx = (nx - 0.5) * sc - (ny - 0.5) * ss;
      const ry = (nx - 0.5) * ss + (ny - 0.5) * sc;

      const sn  = (fbm(nfn, rx*streakScale*streakStretch+31, ry*streakScale+11, 5, lacunarity, rng)+1)/2;
      const sn2 = (fbm(nfn, rx*streakScale*streakStretch*0.5+73, ry*streakScale*0.5+53, 4, lacunarity, rng)+1)/2;
      const streakMask = sn * 0.6 + sn2 * 0.4;

      // Base distance per mode
      let baseDist;
      if (mode === 'edge') {
        baseDist = Math.sqrt((warpX-originX)**2 + (warpY-originY)**2);
      } else if (mode === 'interior') {
        // Invert: centre burns outward, edges survive
        const d = Math.sqrt((warpX-intX)**2 + (warpY-intY)**2);
        baseDist = survivalRadius * 1.5 - d;
      } else if (mode === 'band') {
        const pos = bandVertical ? warpX : warpY;
        baseDist = Math.abs(pos - bandCentre) < bandWidth
          ? (bandWidth - Math.abs(pos - bandCentre)) / bandWidth * 0.8
          : 0.05;
        // Invert: band itself dissolves, rest survives
        baseDist = 0.6 - baseDist;
      } else if (mode === 'dual') {
        const d1 = Math.sqrt((warpX-originX)**2 + (warpY-originY)**2);
        const d2 = Math.sqrt((warpX-origin2X)**2 + (warpY-origin2Y)**2);
        // Minimum of two fields — both corners dissolving toward centre
        baseDist = Math.min(d1, d2);
      } else { // centre-out
        const d = Math.sqrt((warpX-0.5)**2 + (warpY-0.5)**2);
        // Centre survives, edges burn
        baseDist = d;
      }

      // Dissolve field value
      const distNorm = (baseDist - survivalRadius) / dissolveWidth;
      let dissolve = clamp(distNorm + (streakMask - 0.5) * streakWeight, 0, 1);
      dissolve = smoothstep(dissolve);

      // ── Punch survival pockets through erased areas ──
      for (const p of pockets) {
        const pd = Math.sqrt((nx - p.x)**2 + (ny - p.y)**2);
        if (pd < p.radius + p.soft) {
          const t = clamp(1 - (pd - p.radius) / p.soft, 0, 1);
          const pocketSurvival = smoothstep(t);
          // Mix noise in pocket too so it doesn't look like a clean circle
          const pn = (nfn(nx*4+p.x*20, ny*4+p.y*20) + 1) / 2;
          dissolve = dissolve * (1 - pocketSurvival * (0.5 + pn * 0.5));
        }
      }

      field[py * w + px] = dissolve;
    }
  }

  return { field, streakField: buildStreakField(w, h, rng, nfn, baseAngle, streakScale, streakStretch, lacunarity) };
}

// Separate streak field for boundary texture (reused in both BW and colour)
function buildStreakField(w, h, rng, nfn, baseAngle, streakScale, streakStretch, lacunarity) {
  const map = new Float32Array(w * h);
  const sc = Math.cos(baseAngle), ss = Math.sin(baseAngle);
  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const rx = (nx-0.5)*sc - (ny-0.5)*ss;
      const ry = (nx-0.5)*ss + (ny-0.5)*sc;
      const sn  = (fbm(nfn, rx*streakScale*streakStretch+31, ry*streakScale+11, 5, lacunarity, rng)+1)/2;
      const sn2 = (fbm(nfn, rx*streakScale*streakStretch*0.5+73, ry*streakScale*0.5+53, 4, lacunarity, rng)+1)/2;
      map[py*w+px] = sn * 0.6 + sn2 * 0.4;
    }
  }
  return map;
}

// ── B&W corruption ────────────────────────────────────────────────────────────

function corruptBW(data, w, h, seed, rng, nfn) {
  const lacunarity = 1.7 + rng() * 0.6;

  const contrastGamma    = 1.4 + rng() * 1.4;
  const blackLift        = rng() * 0.08;
  const whiteCrush       = 0.90 + rng() * 0.10;
  const coarseScale      = 1.5 + rng() * 3.0;
  const fineScale        = 8.0 + rng() * 16.0;
  const tonerNoiseAmp    = 0.10 + rng() * 0.25;
  const boundaryNoiseAmp = 0.30 + rng() * 0.40;

  const { field: dissolve, streakField } = buildDissolveField(w, h, rng, nfn);

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;
      let r = data[idx], g = data[idx+1], b = data[idx+2];

      let lum = r * 0.299 + g * 0.587 + b * 0.114;

      const eraseAmt    = dissolve[py * w + px];
      const survived    = 1 - eraseAmt;
      const streakMask  = streakField[py * w + px];
      const boundaryZone = eraseAmt * survived * 4;

      if (survived > 0.01) {
        let n = lum / 255;
        const cn = (fbm(nfn, nx*coarseScale+5, ny*coarseScale+17, 4, lacunarity, rng) + 1) / 2;
        const fn = (nfn(px*fineScale*0.01+(seed&0xff)*0.1, py*fineScale*0.01) + 1) / 2;
        const tonerNoise = (cn*0.6 + fn*0.4 - 0.5) * tonerNoiseAmp * survived;
        n = clamp(n + tonerNoise, 0, 1);
        n = Math.pow(n, contrastGamma);
        n = blackLift + n * (whiteCrush - blackLift);
        lum = n * 255;
      }

      if (boundaryZone > 0.01) {
        lum = clamp(lum + boundaryZone * boundaryNoiseAmp * streakMask * 255, 0, 255);
      }

      r = g = b = lum;
      r = r + (255 - r) * eraseAmt;
      g = g + (255 - g) * eraseAmt;
      b = b + (255 - b) * eraseAmt;

      data[idx] = r; data[idx+1] = g; data[idx+2] = b;
    }
  }
}

// ── Colour corruption ─────────────────────────────────────────────────────────

function corruptColour(data, w, h, seed, rng, nfn) {
  const lacunarity = 1.7 + rng() * 0.6;

  const contrastGamma    = 1.2 + rng() * 0.9;
  const satBoost         = 1.1 + rng() * 0.5;
  const coarseScale      = 1.5 + rng() * 2.5;
  const fineScale        = 7.0 + rng() * 12.0;
  const tonerNoiseAmp    = 0.08 + rng() * 0.16;
  const boundaryNoiseAmp = 0.3  + rng() * 0.3;
  const bleachR          = 0.82 + rng() * 0.18;
  const bleachG          = 0.76 + rng() * 0.18;
  const bleachB          = 0.65 + rng() * 0.22;

  const { field: dissolve, streakField } = buildDissolveField(w, h, rng, nfn);

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;
      let r = data[idx], g = data[idx+1], b = data[idx+2];

      const eraseAmt    = dissolve[py * w + px];
      const survived    = 1 - eraseAmt;
      const streakMask  = streakField[py * w + px];
      const boundaryZone = eraseAmt * survived * 4;

      if (survived > 0.01) {
        const cn = (fbm(nfn, nx*coarseScale+5, ny*coarseScale+17, 4, lacunarity, rng) + 1) / 2;
        const fn = (nfn(px*fineScale*0.01+(seed&0xff)*0.1, py*fineScale*0.01) + 1) / 2;
        const tonerNoise = (cn*0.6 + fn*0.4 - 0.5) * tonerNoiseAmp * survived;

        let rn = clamp(r/255 + tonerNoise, 0, 1);
        let gn = clamp(g/255 + tonerNoise, 0, 1);
        let bn = clamp(b/255 + tonerNoise, 0, 1);

        rn = Math.pow(rn, contrastGamma);
        gn = Math.pow(gn, contrastGamma);
        bn = Math.pow(bn, contrastGamma);

        const lumN = rn*0.299 + gn*0.587 + bn*0.114;
        rn = clamp(lumN + (rn - lumN) * satBoost * survived, 0, 1);
        gn = clamp(lumN + (gn - lumN) * satBoost * survived, 0, 1);
        bn = clamp(lumN + (bn - lumN) * satBoost * survived, 0, 1);

        r = rn*255; g = gn*255; b = bn*255;
      }

      if (boundaryZone > 0.01) {
        const bleach = boundaryZone * boundaryNoiseAmp * streakMask;
        r = clamp(r + bleach*255, 0, 255);
        g = clamp(g + bleach*255, 0, 255);
        b = clamp(b + bleach*255, 0, 255);
      }

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
