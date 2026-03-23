/**
 * app.js — The Museum of Memory
 * Orchestrates single and double exposure flows.
 */

(function () {

  // ── Elements ──────────────────────────────────────────────────────────────
  const modeSection    = document.getElementById('mode-section');
  const singleSection  = document.getElementById('single-section');
  const doubleSection  = document.getElementById('double-section');
  const resultSection  = document.getElementById('result-section');

  const modeSingleBtn  = document.getElementById('mode-single');
  const modeDoubleBtn  = document.getElementById('mode-double');

  // Single
  const singleZone     = document.getElementById('single-zone');
  const singleInput    = document.getElementById('single-input');
  const singleBack     = document.getElementById('single-back');

  // Double
  const zoneA          = document.getElementById('zone-a');
  const inputA         = document.getElementById('input-a');
  const thumbA         = document.getElementById('thumb-a');
  const thumbImgA      = document.getElementById('thumb-img-a');
  const clearA         = document.getElementById('clear-a');

  const zoneB          = document.getElementById('zone-b');
  const inputB         = document.getElementById('input-b');
  const thumbB         = document.getElementById('thumb-b');
  const thumbImgB      = document.getElementById('thumb-img-b');
  const clearB         = document.getElementById('clear-b');

  const developBtn     = document.getElementById('develop-btn');
  const doubleBack     = document.getElementById('double-back');

  // Result
  const canvas         = document.getElementById('canvas');
  const ctx            = canvas.getContext('2d');
  const developing     = document.getElementById('developing');
  const anotherBtn     = document.getElementById('another-btn');
  const saveBtn        = document.getElementById('save-btn');



  // ── State ─────────────────────────────────────────────────────────────────
  let mode   = null;   // 'single' | 'double'
  let imgA   = null;
  let imgB   = null;
  let seeds  = {};     // { a, b, c }

  // ── Navigation ────────────────────────────────────────────────────────────
  function show(section) {
    [modeSection, singleSection, doubleSection, resultSection]
      .forEach(s => s.style.display = 'none');
    section.style.display = 'flex';
    if (section === doubleSection) section.style.display = 'block';
    if (section === resultSection) section.style.display = 'block';
  }

  modeSingleBtn.addEventListener('click', () => {
    mode = 'single';
    show(singleSection);
  });

  modeDoubleBtn.addEventListener('click', () => {
    mode = 'double';
    show(doubleSection);
  });

  singleBack.addEventListener('click', () => {
    imgA = null; singleInput.value = '';
    show(modeSection);
  });

  doubleBack.addEventListener('click', () => {
    resetDouble();
    show(modeSection);
  });

  anotherBtn.addEventListener('click', () => {
    resetAll();
    show(modeSection);
  });

  // ── Single flow ───────────────────────────────────────────────────────────
  setupDropZone(singleZone, singleInput, file => {
    loadImage(file, img => {
      imgA  = img;
      seeds = { a: rand32() };
      develop();
    });
  });

  // ── Double flow ───────────────────────────────────────────────────────────
  setupDropZone(zoneA, inputA, file => {
    loadImage(file, img => {
      imgA = img;
      thumbImgA.src = imageToDataURL(img);
      zoneA.style.display = 'none';
      thumbA.style.display = 'block';
      checkDoubleReady();
    });
  });

  setupDropZone(zoneB, inputB, file => {
    loadImage(file, img => {
      imgB = img;
      thumbImgB.src = imageToDataURL(img);
      zoneB.style.display = 'none';
      thumbB.style.display = 'block';
      checkDoubleReady();
    });
  });

  clearA.addEventListener('click', e => {
    e.stopPropagation();
    imgA = null; inputA.value = '';
    thumbA.style.display = 'none';
    zoneA.style.display = 'block';
    checkDoubleReady();
  });

  clearB.addEventListener('click', e => {
    e.stopPropagation();
    imgB = null; inputB.value = '';
    thumbB.style.display = 'none';
    zoneB.style.display = 'block';
    checkDoubleReady();
  });

  function checkDoubleReady() {
    developBtn.disabled = !(imgA && imgB);
  }

  developBtn.addEventListener('click', () => {
    seeds = { a: rand32(), b: rand32(), c: rand32() };
    develop();
  });

  // ── Develop ───────────────────────────────────────────────────────────────
  function develop() {
    show(resultSection);
    developing.classList.add('active');

    requestAnimationFrame(() => {
      setTimeout(() => {
        let result;

        if (mode === 'single') {
          result = window.MemoryCorruption.single(imgA, seeds.a);
        } else {
          result = window.MemoryCorruption.double(imgA, imgB, seeds.a, seeds.b, seeds.c);
        }

        canvas.width  = result.width;
        canvas.height = result.height;
        ctx.drawImage(result, 0, 0);

        const seedStr = mode === 'single'
          ? seeds.a.toString(16).padStart(8, '0')
          : `${seeds.a.toString(16).padStart(8,'0')} · ${seeds.b.toString(16).padStart(8,'0')} · ${seeds.c.toString(16).padStart(8,'0')}`;

        developing.classList.remove('active');
      }, 40);
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const link    = document.createElement('a');
    const nameStr = mode === 'single'
      ? seeds.a.toString(16).padStart(8, '0')
      : `${seeds.a.toString(16).padStart(8,'0')}-${seeds.c.toString(16).padStart(8,'0')}`;
    link.download = `memory-${nameStr}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function rand32() { return (Math.random() * 0xffffffff) >>> 0; }

  function setupDropZone(zone, input, onFile) {
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) onFile(f);
    });
    input.addEventListener('change', e => {
      if (e.target.files[0]) onFile(e.target.files[0]);
    });
  }

  function loadImage(file, cb) {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => cb(img);
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  function imageToDataURL(img) {
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext('2d').drawImage(img, 0, 0);
    return cv.toDataURL();
  }

  function resetDouble() {
    imgA = null; imgB = null;
    inputA.value = ''; inputB.value = '';
    thumbA.style.display = 'none'; zoneA.style.display = 'block';
    thumbB.style.display = 'none'; zoneB.style.display = 'block';
    developBtn.disabled = true;
  }

  function resetAll() {
    resetDouble();
    imgA = null;
    singleInput.value = '';
  }

})();
