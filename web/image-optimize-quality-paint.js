const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.image-optimize-compare');
const original = compare?.querySelector('[data-opt-original]');
const tuning = document.querySelector('.image-optimize-tuning');
const qualitySlider = document.querySelector('[data-opt-quality]');
const formats = document.querySelector('[data-opt-formats]');

if (viewer && compare && original && tuning && qualitySlider) {
  const MASK_MAX_EDGE = 256;
  const DEFAULT_LOW_QUALITY = 12;
  const LEVELS = { high:255, normal:128, low:0 };

  const style = document.createElement('style');
  style.textContent = `
.image-optimize-quality-map-row{grid-template-columns:auto 1fr}.image-optimize-quality-map-row>.image-optimize-choice{justify-self:end;width:110px}
.image-optimize-quality-map-panel{display:grid;gap:9px;padding-top:1px}.image-optimize-quality-map-panel[hidden]{display:none!important}
.image-optimize-quality-tools{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.image-optimize-quality-tools .image-optimize-choice{min-height:32px}.image-optimize-quality-reset{min-height:30px!important;font-size:10.5px!important}
.image-optimize-quality-map-panel .image-optimize-slider{gap:5px}.image-optimize-quality-map-panel .image-optimize-tune-head{font-size:10.5px}
.image-optimize-quality-mask,.image-optimize-quality-cursor{position:absolute;z-index:2;display:none;pointer-events:none;user-select:none;-webkit-user-select:none;image-rendering:auto}
.image-optimize-quality-cursor{z-index:3;opacity:.95}
.image-optimize-compare.image-optimize-quality-painting{cursor:none}.image-optimize-compare.image-optimize-quality-painting .image-optimize-quality-mask,.image-optimize-compare.image-optimize-quality-painting .image-optimize-quality-cursor{display:block}
`;
  document.head.append(style);

  const row = document.createElement('div');
  row.className = 'image-optimize-segmented image-optimize-quality-map-row';
  row.innerHTML = `
    <span class="image-optimize-tune-head">Regions</span>
    <button class="image-optimize-choice" type="button" data-quality-map-toggle>Paint</button>`;

  const panel = document.createElement('div');
  panel.className = 'image-optimize-quality-map-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="image-optimize-quality-tools">
      <button class="image-optimize-choice active" type="button" data-quality-tool="high">High</button>
      <button class="image-optimize-choice" type="button" data-quality-tool="normal">Normal</button>
      <button class="image-optimize-choice" type="button" data-quality-tool="low">Who cares</button>
    </div>
    <button class="image-optimize-choice image-optimize-quality-reset" type="button" data-quality-reset>Who cares · whole image</button>
    <div class="image-optimize-slider">
      <div class="image-optimize-tune-head"><span>Who cares AVIF quality</span><output data-quality-low-label>${DEFAULT_LOW_QUALITY}</output></div>
      <input data-quality-low type="range" min="1" max="40" value="${DEFAULT_LOW_QUALITY}" aria-label="AVIF quality for who-cares regions">
    </div>
    <div class="image-optimize-slider">
      <div class="image-optimize-tune-head"><span>Brush</span><output data-quality-brush-label>32</output></div>
      <input data-quality-brush type="range" min="6" max="96" value="32" aria-label="Quality paint brush size">
    </div>`;
  tuning.append(row, panel);

  const toggle = row.querySelector('[data-quality-map-toggle]');
  const lowInput = panel.querySelector('[data-quality-low]');
  const lowLabel = panel.querySelector('[data-quality-low-label]');
  const brushInput = panel.querySelector('[data-quality-brush]');
  const brushLabel = panel.querySelector('[data-quality-brush-label]');
  const resetButton = panel.querySelector('[data-quality-reset]');

  const paintCanvas = document.createElement('canvas');
  paintCanvas.className = 'image-optimize-quality-mask';
  paintCanvas.setAttribute('aria-hidden', 'true');
  compare.append(paintCanvas);
  const paintContext = paintCanvas.getContext('2d');

  const cursorCanvas = document.createElement('canvas');
  cursorCanvas.className = 'image-optimize-quality-cursor';
  cursorCanvas.setAttribute('aria-hidden', 'true');
  compare.append(cursorCanvas);
  const cursorContext = cursorCanvas.getContext('2d');

  const maskCanvas = document.createElement('canvas');
  const maskContext = maskCanvas.getContext('2d');

  let enabled = false;
  let initialized = false;
  let tool = 'high';
  let brush = 32;
  let lowQuality = DEFAULT_LOW_QUALITY;
  let activePointer = null;
  let lastPoint = null;
  let previewTimer = 0;
  let geometryFrame = 0;
  let cursorPoint = null;

  const optimizerActive = () => viewer.classList.contains('image-optimize-active');

  function toolColor(name) {
    if (name === 'high') return [92, 178, 255, 96];
    if (name === 'normal') return [255, 190, 92, 82];
    return [255, 92, 92, 72];
  }

  // Rebuild the display overlay from the mask instead of painting translucent
  // strokes onto translucent strokes. Overpainting can therefore never become
  // more opaque. High is blue, Normal is amber, and Who cares is unpainted.
  function renderOverlay() {
    if (!initialized) return;
    const width = maskCanvas.width;
    const height = maskCanvas.height;
    const mask = maskContext.getImageData(0, 0, width, height).data;
    const image = paintContext.createImageData(width, height);
    const output = image.data;

    for (let index = 0; index < width * height; index++) {
      const level = mask[index * 4];
      const offset = index * 4;
      if (level >= 192) {
        output[offset] = 92;
        output[offset + 1] = 178;
        output[offset + 2] = 255;
        output[offset + 3] = 96;
      } else if (level >= 64) {
        output[offset] = 255;
        output[offset + 1] = 190;
        output[offset + 2] = 92;
        output[offset + 3] = 82;
      }
    }
    paintContext.putImageData(image, 0, 0);
  }

  function clearCursor() {
    cursorContext.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  }

  function renderCursor() {
    clearCursor();
    if (!enabled || !initialized || !cursorPoint) return;
    const radius = Math.max(1, brush / 2);
    const activeTool = activePointer?.button === 2 ? 'low' : tool;
    const [r, g, b, a] = toolColor(activeTool);
    cursorContext.save();
    cursorContext.lineWidth = 2;
    cursorContext.strokeStyle = `rgba(${r},${g},${b},0.95)`;
    cursorContext.fillStyle = `rgba(${r},${g},${b},${Math.max(0.08, a / 255 * 0.22)})`;
    cursorContext.beginPath();
    cursorContext.arc(cursorPoint.x, cursorPoint.y, radius, 0, Math.PI * 2);
    cursorContext.fill();
    cursorContext.stroke();
    cursorContext.restore();
  }

  function initializeMask(force = false) {
    if ((!force && initialized) || !original.naturalWidth || !original.naturalHeight) return initialized;
    const scale = Math.min(1, MASK_MAX_EDGE / Math.max(original.naturalWidth, original.naturalHeight));
    const width = Math.max(1, Math.round(original.naturalWidth * scale));
    const height = Math.max(1, Math.round(original.naturalHeight * scale));
    paintCanvas.width = maskCanvas.width = cursorCanvas.width = width;
    paintCanvas.height = maskCanvas.height = cursorCanvas.height = height;
    initialized = true;
    lowAll(false);
    queueGeometry();
    return true;
  }

  function lowAll(refresh = true) {
    if (!initialized) return;
    maskContext.save();
    maskContext.globalCompositeOperation = 'source-over';
    maskContext.fillStyle = '#000';
    maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskContext.restore();
    renderOverlay();
    renderCursor();
    if (refresh) requestPreview();
  }

  function syncGeometry() {
    geometryFrame = 0;
    if (!initialized || !optimizerActive()) return;
    const imageRect = original.getBoundingClientRect();
    const compareRect = compare.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height || !compareRect.width || !compareRect.height) return;
    const left = imageRect.left - compareRect.left;
    const top = imageRect.top - compareRect.top;
    for (const canvas of [paintCanvas, cursorCanvas]) {
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${imageRect.width}px`;
      canvas.style.height = `${imageRect.height}px`;
    }
    renderCursor();
  }

  function queueGeometry() {
    if (geometryFrame) return;
    geometryFrame = requestAnimationFrame(syncGeometry);
  }

  function payload() {
    if (!enabled || !initializeMask()) return null;
    return {
      enabled: true,
      mode: 'avif-base-v1',
      lowQuality,
      mask: maskCanvas.toDataURL('image/png')
    };
  }

  function requestPreview(delay = 220) {
    clearTimeout(previewTimer);
    if (!optimizerActive()) return;
    previewTimer = setTimeout(() => {
      previewTimer = 0;
      qualitySlider.dispatchEvent(new Event('input', { bubbles:true }));
    }, delay);
  }

  function setTool(next) {
    tool = Object.hasOwn(LEVELS, next) ? next : 'high';
    for (const button of panel.querySelectorAll('[data-quality-tool]')) {
      button.classList.toggle('active', button.dataset.qualityTool === tool);
    }
    renderCursor();
  }

  function setEnabled(next, refresh = true) {
    enabled = Boolean(next);
    activePointer = null;
    lastPoint = null;
    cursorPoint = null;
    toggle.classList.toggle('active', enabled);
    toggle.textContent = enabled ? 'Painting' : 'Paint';
    panel.hidden = !enabled;
    compare.classList.toggle('image-optimize-quality-painting', enabled);
    clearCursor();
    if (enabled) {
      initializeMask();
      queueGeometry();
      document.querySelector('[data-format="avif"]')?.click();
    }
    if (refresh) requestPreview(0);
  }

  function pointForEvent(event, allowOutside = false) {
    if (!initialized && !initializeMask()) return null;
    const rect = original.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    let x = (event.clientX - rect.left) / rect.width;
    let y = (event.clientY - rect.top) / rect.height;
    if (!allowOutside && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    return { x:x * maskCanvas.width, y:y * maskCanvas.height };
  }

  function drawSegment(from, to, levelName = tool) {
    if (!from || !to) return;
    const value = LEVELS[levelName] ?? LEVELS.high;
    const color = `rgb(${value},${value},${value})`;
    maskContext.save();
    maskContext.globalCompositeOperation = 'source-over';
    maskContext.strokeStyle = color;
    maskContext.fillStyle = color;
    maskContext.lineWidth = brush;
    maskContext.lineCap = 'round';
    maskContext.lineJoin = 'round';
    maskContext.beginPath();
    maskContext.moveTo(from.x, from.y);
    maskContext.lineTo(to.x, to.y);
    maskContext.stroke();
    if (Math.abs(from.x - to.x) < .01 && Math.abs(from.y - to.y) < .01) {
      maskContext.beginPath();
      maskContext.arc(to.x, to.y, brush / 2, 0, Math.PI * 2);
      maskContext.fill();
    }
    maskContext.restore();
    renderOverlay();
    renderCursor();
  }

  function blockedTarget(event) {
    return Boolean(event.target?.closest?.('.image-optimize-controls,.viewer-optimize-trigger,.viewer-bar,.viewer-info'));
  }

  window.addEventListener('pointerdown', event => {
    if (!enabled || !optimizerActive() || blockedTarget(event) || (event.button !== 0 && event.button !== 2)) return;
    const point = pointForEvent(event);
    if (!point) return;
    activePointer = { id:event.pointerId, button:event.button };
    lastPoint = point;
    cursorPoint = point;
    drawSegment(point, point, event.button === 2 ? 'low' : tool);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener('pointermove', event => {
    if (!enabled || !optimizerActive()) return;
    const point = pointForEvent(event, activePointer?.id === event.pointerId);
    cursorPoint = point;
    renderCursor();
    if (activePointer?.id !== event.pointerId) return;
    if (point) {
      drawSegment(lastPoint || point, point, activePointer.button === 2 ? 'low' : tool);
      lastPoint = point;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function finishPaint(event) {
    if (activePointer?.id !== event.pointerId) return;
    const point = pointForEvent(event, true);
    if (point) {
      cursorPoint = point;
      drawSegment(lastPoint || point, point, activePointer.button === 2 ? 'low' : tool);
    }
    activePointer = null;
    lastPoint = null;
    renderCursor();
    requestPreview();
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  window.addEventListener('pointerup', finishPaint, true);
  window.addEventListener('pointercancel', finishPaint, true);

  compare.addEventListener('contextmenu', event => {
    if (enabled) event.preventDefault();
  });
  compare.addEventListener('pointerleave', () => {
    if (activePointer) return;
    cursorPoint = null;
    clearCursor();
  });
  compare.addEventListener('pointerenter', event => {
    if (!enabled) return;
    cursorPoint = pointForEvent(event, true);
    renderCursor();
  });

  toggle.addEventListener('click', () => setEnabled(!enabled));
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-quality-tool]');
    if (button) setTool(button.dataset.qualityTool);
  });
  resetButton.addEventListener('click', () => lowAll());
  lowInput.addEventListener('input', () => {
    lowQuality = Math.max(1, Math.min(40, Number(lowInput.value) || DEFAULT_LOW_QUALITY));
    lowLabel.textContent = String(lowQuality);
    requestPreview(320);
  });
  brushInput.addEventListener('input', () => {
    brush = Math.max(6, Math.min(96, Number(brushInput.value) || 32));
    brushLabel.textContent = String(brush);
    renderCursor();
  });

  formats?.addEventListener('click', event => {
    const button = event.target.closest('[data-format]');
    if (enabled && button && button.dataset.format !== 'avif') setEnabled(false, false);
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (enabled && url.includes('/api/image-optimize/start') && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        body.options = { ...(body.options || {}), qualityPaint:payload() };
        return nativeFetch(input, { ...init, body:JSON.stringify(body) });
      } catch {}
    }
    return nativeFetch(input, init);
  };

  original.addEventListener('load', () => {
    if (!optimizerActive()) return;
    initialized = false;
    initializeMask(true);
    queueGeometry();
  });
  new MutationObserver(queueGeometry).observe(original, { attributes:true, attributeFilter:['style'] });
  window.addEventListener('resize', queueGeometry);
  window.addEventListener('mochimono:optimize-zoom', queueGeometry);
  window.addEventListener('mochimono:optimize-open', () => {
    enabled = false;
    initialized = false;
    activePointer = null;
    lastPoint = null;
    cursorPoint = null;
    lowQuality = DEFAULT_LOW_QUALITY;
    lowInput.value = String(lowQuality);
    lowLabel.textContent = String(lowQuality);
    brush = 32;
    brushInput.value = String(brush);
    brushLabel.textContent = String(brush);
    setTool('high');
    toggle.classList.remove('active');
    toggle.textContent = 'Paint';
    panel.hidden = true;
    compare.classList.remove('image-optimize-quality-painting');
    clearCursor();
    setTimeout(() => { initializeMask(true); queueGeometry(); }, 0);
  });
  window.addEventListener('mochimono:optimize-close', () => {
    clearTimeout(previewTimer);
    previewTimer = 0;
    enabled = false;
    activePointer = null;
    lastPoint = null;
    cursorPoint = null;
    compare.classList.remove('image-optimize-quality-painting');
    panel.hidden = true;
    toggle.classList.remove('active');
    toggle.textContent = 'Paint';
    paintContext.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    clearCursor();
  });
}
