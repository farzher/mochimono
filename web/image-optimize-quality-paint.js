const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.image-optimize-compare');
const original = compare?.querySelector('[data-opt-original]');
const tuning = document.querySelector('.image-optimize-tuning');
const qualitySlider = document.querySelector('[data-opt-quality]');
const formats = document.querySelector('[data-opt-formats]');

if (viewer && compare && original && tuning && qualitySlider) {
  const MASK_MAX_EDGE = 256;
  const DEFAULT_NORMAL_QUALITY = 50;
  const DEFAULT_LOW_QUALITY = 5;
  const LEVELS = { high:255, normal:128, low:0 };

  const style = document.createElement('style');
  style.textContent = `
.image-optimize-quality-map-row{grid-template-columns:auto 1fr}.image-optimize-quality-map-row>.image-optimize-choice{justify-self:end;width:110px}
.image-optimize-quality-map-panel{display:grid;gap:9px;padding-top:1px}.image-optimize-quality-map-panel[hidden]{display:none!important}
.image-optimize-quality-tools{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.image-optimize-quality-tools .image-optimize-choice{min-height:32px}.image-optimize-quality-reset{min-height:30px!important;font-size:10.5px!important}
.image-optimize-quality-map-panel .image-optimize-slider{gap:5px}.image-optimize-quality-map-panel .image-optimize-tune-head{font-size:10.5px}
.image-optimize-quality-mask,.image-optimize-quality-cursor{position:absolute;z-index:2;display:none;pointer-events:none;user-select:none;-webkit-user-select:none;image-rendering:auto}
.image-optimize-quality-cursor{z-index:3}.image-optimize-compare.image-optimize-quality-painting{cursor:none}
.image-optimize-compare.image-optimize-quality-painting .image-optimize-quality-mask,.image-optimize-compare.image-optimize-quality-painting .image-optimize-quality-cursor{display:block}
.image-optimize-compare.image-optimize-quality-previewing .image-optimize-quality-mask,.image-optimize-compare.image-optimize-quality-previewing .image-optimize-quality-cursor{display:none}
`;
  document.head.append(style);

  const row = document.createElement('div');
  row.className = 'image-optimize-segmented image-optimize-quality-map-row';
  row.innerHTML = `
    <span class="image-optimize-tune-head">Regions</span>
    <button class="image-optimize-choice" type="button" data-quality-map-toggle>Paint</button>`;

  const initialHigh = Math.max(1, Math.min(100, Math.round(Number(qualitySlider.value) || 69)));
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
      <div class="image-optimize-tune-head"><span>High AVIF quality</span><output data-quality-high-label>${initialHigh}</output></div>
      <input data-quality-high type="range" min="1" max="100" value="${initialHigh}" aria-label="Final AVIF quality for high-priority regions">
    </div>
    <div class="image-optimize-slider">
      <div class="image-optimize-tune-head"><span>Normal quality</span><output data-quality-normal-label>${DEFAULT_NORMAL_QUALITY}</output></div>
      <input data-quality-normal type="range" min="1" max="100" value="${DEFAULT_NORMAL_QUALITY}" aria-label="Simplification quality for normal-priority regions">
    </div>
    <div class="image-optimize-slider">
      <div class="image-optimize-tune-head"><span>Who cares quality</span><output data-quality-low-label>${DEFAULT_LOW_QUALITY}</output></div>
      <input data-quality-low type="range" min="1" max="100" value="${DEFAULT_LOW_QUALITY}" aria-label="Simplification quality for who-cares regions">
    </div>
    <div class="image-optimize-slider">
      <div class="image-optimize-tune-head"><span>Brush</span><output data-quality-brush-label>32</output></div>
      <input data-quality-brush type="range" min="6" max="96" value="32" aria-label="Quality paint brush size">
    </div>`;
  tuning.append(row, panel);

  const toggle = row.querySelector('[data-quality-map-toggle]');
  const highInput = panel.querySelector('[data-quality-high]');
  const highLabel = panel.querySelector('[data-quality-high-label]');
  const normalInput = panel.querySelector('[data-quality-normal]');
  const normalLabel = panel.querySelector('[data-quality-normal-label]');
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
  let highQuality = initialHigh;
  let normalQuality = Math.min(highQuality, DEFAULT_NORMAL_QUALITY);
  let lowQuality = Math.min(normalQuality, DEFAULT_LOW_QUALITY);
  let activePointer = null;
  let lastPoint = null;
  let cursorPoint = null;
  let previewTimer = 0;
  let geometryFrame = 0;
  let sliderPreviewActive = false;

  const optimizerActive = () => viewer.classList.contains('image-optimize-active');

  function toolColor(name) {
    if (name === 'high') return [92, 178, 255, 96];
    if (name === 'normal') return [255, 190, 92, 82];
    return [255, 92, 92, 72];
  }

  function syncTierControls() {
    highQuality = Math.max(1, Math.min(100, Math.round(Number(highQuality) || 69)));
    normalQuality = Math.max(1, Math.min(highQuality, Math.round(Number(normalQuality) || DEFAULT_NORMAL_QUALITY)));
    lowQuality = Math.max(1, Math.min(normalQuality, Math.round(Number(lowQuality) || DEFAULT_LOW_QUALITY)));
    normalInput.max = String(highQuality);
    lowInput.max = String(normalQuality);
    highInput.value = highLabel.textContent = String(highQuality);
    normalInput.value = normalLabel.textContent = String(normalQuality);
    lowInput.value = lowLabel.textContent = String(lowQuality);
  }

  function renderOverlay() {
    if (!initialized) return;
    const width = maskCanvas.width;
    const height = maskCanvas.height;
    const mask = maskContext.getImageData(0, 0, width, height).data;
    const image = paintContext.createImageData(width, height);
    const out = image.data;
    for (let i = 0; i < width * height; i++) {
      const level = mask[i * 4];
      const o = i * 4;
      if (level >= 192) {
        out[o] = 92; out[o + 1] = 178; out[o + 2] = 255; out[o + 3] = 96;
      } else if (level >= 64) {
        out[o] = 255; out[o + 1] = 190; out[o + 2] = 92; out[o + 3] = 82;
      }
    }
    paintContext.putImageData(image, 0, 0);
  }

  function clearCursor() {
    cursorContext.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  }

  function renderCursor() {
    clearCursor();
    if (!enabled || !initialized || !cursorPoint || sliderPreviewActive) return;
    const [r, g, b, a] = toolColor(activePointer?.button === 2 ? 'low' : tool);
    cursorContext.save();
    cursorContext.fillStyle = `rgba(${r},${g},${b},${Math.max(0.16, a / 255 * 0.6)})`;
    cursorContext.beginPath();
    cursorContext.arc(cursorPoint.x, cursorPoint.y, Math.max(1, brush / 2), 0, Math.PI * 2);
    cursorContext.fill();
    cursorContext.restore();
  }

  function beginSliderPreview() {
    if (!enabled) return;
    sliderPreviewActive = true;
    compare.classList.add('image-optimize-quality-previewing');
    clearCursor();
  }

  function endSliderPreview() {
    if (!sliderPreviewActive) return;
    sliderPreviewActive = false;
    compare.classList.remove('image-optimize-quality-previewing');
    renderCursor();
  }

  function initializeMask(force = false) {
    if ((!force && initialized) || !original.naturalWidth || !original.naturalHeight) return initialized;
    const scale = Math.min(1, MASK_MAX_EDGE / Math.max(original.naturalWidth, original.naturalHeight));
    const width = Math.max(1, Math.round(original.naturalWidth * scale));
    const height = Math.max(1, Math.round(original.naturalHeight * scale));
    paintCanvas.width = maskCanvas.width = cursorCanvas.width = width;
    paintCanvas.height = maskCanvas.height = cursorCanvas.height = height;
    initialized = true;
    maskContext.fillStyle = '#000';
    maskContext.fillRect(0, 0, width, height);
    renderOverlay();
    queueGeometry();
    return true;
  }

  function resetLow(refresh = true) {
    if (!initializeMask()) return;
    maskContext.fillStyle = '#000';
    maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    renderOverlay();
    renderCursor();
    if (refresh) requestPreview();
  }

  function displayedImageRect() {
    const box = original.getBoundingClientRect();
    if (!box.width || !box.height || !original.naturalWidth || !original.naturalHeight) return box;
    const scale = Math.min(box.width / original.naturalWidth, box.height / original.naturalHeight);
    const width = original.naturalWidth * scale;
    const height = original.naturalHeight * scale;
    return {
      left:box.left + (box.width - width) / 2,
      top:box.top + (box.height - height) / 2,
      width,
      height,
      right:box.left + (box.width + width) / 2,
      bottom:box.top + (box.height + height) / 2
    };
  }

  function syncGeometry() {
    geometryFrame = 0;
    if (!initialized || !optimizerActive()) return;
    const imageRect = displayedImageRect();
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
    if (!geometryFrame) geometryFrame = requestAnimationFrame(syncGeometry);
  }

  function maskDataUrl() {
    const pixel = maskContext.getImageData(0, 0, 1, 1);
    const originalAlpha = pixel.data[3];
    pixel.data[3] = normalQuality;
    maskContext.putImageData(pixel, 0, 0);
    const url = maskCanvas.toDataURL('image/png');
    pixel.data[3] = originalAlpha;
    maskContext.putImageData(pixel, 0, 0);
    return url;
  }

  function payload() {
    if (!enabled || !initializeMask()) return null;
    return { enabled:true, mode:'avif-base-v1', lowQuality, mask:maskDataUrl() };
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
    endSliderPreview();
    toggle.classList.toggle('active', enabled);
    toggle.textContent = enabled ? 'Painting' : 'Paint';
    panel.hidden = !enabled;
    compare.classList.toggle('image-optimize-quality-painting', enabled);
    clearCursor();
    if (enabled) {
      highQuality = Math.max(1, Math.min(100, Number(qualitySlider.value) || 69));
      syncTierControls();
      initializeMask();
      queueGeometry();
      document.querySelector('[data-format="avif"]')?.click();
    }
    if (refresh) requestPreview(0);
  }

  function pointForEvent(event, allowOutside = false) {
    if (!initializeMask()) return null;
    const rect = displayedImageRect();
    if (!rect.width || !rect.height) return null;
    let x = (event.clientX - rect.left) / rect.width;
    let y = (event.clientY - rect.top) / rect.height;
    if (!allowOutside && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    return { x:x * maskCanvas.width, y:y * maskCanvas.height };
  }

  function drawSegment(from, to, levelName) {
    if (!from || !to) return;
    const value = LEVELS[levelName] ?? LEVELS.high;
    const color = `rgb(${value},${value},${value})`;
    maskContext.save();
    maskContext.strokeStyle = maskContext.fillStyle = color;
    maskContext.lineWidth = brush;
    maskContext.lineCap = maskContext.lineJoin = 'round';
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
    return event.composedPath().some(node =>
      node instanceof Element && node.matches?.('input,button,select,textarea,label,a,.image-optimize-controls,.image-optimize-divider,.viewer-optimize-trigger,.viewer-bar,.viewer-info')
    );
  }

  function overPaintSurface(event) {
    return event.composedPath().includes(compare) && !blockedTarget(event) && Boolean(pointForEvent(event));
  }

  window.addEventListener('pointerdown', event => {
    if (!enabled || event.button !== 0) return;
    if (event.composedPath().some(node => node instanceof HTMLInputElement && node.type === 'range')) beginSliderPreview();
  }, true);

  window.addEventListener('pointerdown', event => {
    if (!enabled || !optimizerActive() || sliderPreviewActive || (event.button !== 0 && event.button !== 2)) return;
    if (!overPaintSurface(event)) return;
    const point = pointForEvent(event);
    if (!point) return;
    activePointer = { id:event.pointerId, button:event.button };
    lastPoint = cursorPoint = point;
    drawSegment(point, point, event.button === 2 ? 'low' : tool);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener('pointermove', event => {
    if (!enabled || !optimizerActive()) return;
    if (activePointer?.id !== event.pointerId && (!event.composedPath().includes(compare) || blockedTarget(event))) {
      cursorPoint = null;
      clearCursor();
      return;
    }
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
    if (point) drawSegment(lastPoint || point, point, activePointer.button === 2 ? 'low' : tool);
    activePointer = null;
    lastPoint = null;
    requestPreview();
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  window.addEventListener('pointerup', finishPaint, true);
  window.addEventListener('pointercancel', finishPaint, true);
  window.addEventListener('pointerup', endSliderPreview, true);
  window.addEventListener('pointercancel', endSliderPreview, true);

  compare.addEventListener('contextmenu', event => {
    if (enabled && pointForEvent(event)) event.preventDefault();
  });
  compare.addEventListener('pointerleave', () => {
    if (activePointer) return;
    cursorPoint = null;
    clearCursor();
  });
  compare.addEventListener('pointerenter', event => {
    if (!enabled || blockedTarget(event)) return;
    cursorPoint = pointForEvent(event);
    renderCursor();
  });

  toggle.addEventListener('click', () => setEnabled(!enabled));
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-quality-tool]');
    if (button) setTool(button.dataset.qualityTool);
  });
  resetButton.addEventListener('click', () => resetLow());

  highInput.addEventListener('input', () => {
    highQuality = Number(highInput.value) || 69;
    syncTierControls();
    qualitySlider.value = String(highQuality);
    qualitySlider.dispatchEvent(new Event('input', { bubbles:true }));
  });
  normalInput.addEventListener('input', () => {
    normalQuality = Number(normalInput.value) || DEFAULT_NORMAL_QUALITY;
    syncTierControls();
    requestPreview(260);
  });
  lowInput.addEventListener('input', () => {
    lowQuality = Number(lowInput.value) || DEFAULT_LOW_QUALITY;
    syncTierControls();
    requestPreview(260);
  });
  qualitySlider.addEventListener('input', () => {
    if (!enabled) return;
    highQuality = Number(qualitySlider.value) || 69;
    syncTierControls();
  }, true);
  brushInput.addEventListener('input', () => {
    brush = Math.max(6, Math.min(96, Number(brushInput.value) || 32));
    brushLabel.textContent = String(brush);
    renderCursor();
  });

  for (const input of new Set([qualitySlider, ...tuning.querySelectorAll('input[type="range"]')])) {
    input?.addEventListener('pointerdown', beginSliderPreview, true);
    input?.addEventListener('change', endSliderPreview, true);
    input?.addEventListener('blur', endSliderPreview, true);
  }

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
    highQuality = Math.max(1, Math.min(100, Number(qualitySlider.value) || 69));
    normalQuality = Math.min(highQuality, DEFAULT_NORMAL_QUALITY);
    lowQuality = Math.min(normalQuality, DEFAULT_LOW_QUALITY);
    syncTierControls();
    brush = 32;
    brushInput.value = brushLabel.textContent = String(brush);
    setTool('high');
    toggle.classList.remove('active');
    toggle.textContent = 'Paint';
    panel.hidden = true;
    compare.classList.remove('image-optimize-quality-painting', 'image-optimize-quality-previewing');
    sliderPreviewActive = false;
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
    sliderPreviewActive = false;
    compare.classList.remove('image-optimize-quality-painting', 'image-optimize-quality-previewing');
    panel.hidden = true;
    toggle.classList.remove('active');
    toggle.textContent = 'Paint';
    paintContext.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    clearCursor();
  });
}
