const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.image-optimize-compare');
const original = compare?.querySelector('[data-opt-original]');
const tuning = document.querySelector('.image-optimize-tuning');
const qualitySlider = document.querySelector('[data-opt-quality]');
const formats = document.querySelector('[data-opt-formats]');

if (viewer && compare && original && tuning && qualitySlider) {
  const MASK_MAX_EDGE = 256;
  const DEFAULT_LOW_QUALITY = 12;

  const style = document.createElement('style');
  style.textContent = `
.image-optimize-quality-map-row{grid-template-columns:auto 1fr}.image-optimize-quality-map-row>.image-optimize-choice{justify-self:end;width:110px}
.image-optimize-quality-map-panel{display:grid;gap:9px;padding-top:1px}.image-optimize-quality-map-panel[hidden]{display:none!important}
.image-optimize-quality-tools{display:grid;grid-template-columns:1fr 1fr auto;gap:6px}.image-optimize-quality-tools .image-optimize-choice{min-height:32px}
.image-optimize-quality-map-panel .image-optimize-slider{gap:5px}.image-optimize-quality-map-panel .image-optimize-tune-head{font-size:10.5px}
.image-optimize-quality-mask{position:absolute;z-index:2;display:none;pointer-events:none;user-select:none;-webkit-user-select:none;image-rendering:auto}
.image-optimize-compare.image-optimize-quality-painting{cursor:crosshair}.image-optimize-compare.image-optimize-quality-painting .image-optimize-quality-mask{display:block}
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
      <button class="image-optimize-choice active" type="button" data-quality-tool="protect">Protect</button>
      <button class="image-optimize-choice" type="button" data-quality-tool="compress">Compress</button>
      <button class="image-optimize-choice" type="button" data-quality-reset>Compress all</button>
    </div>
    <div class="image-optimize-slider">
      <div class="image-optimize-tune-head"><span>Background AVIF quality</span><output data-quality-low-label>${DEFAULT_LOW_QUALITY}</output></div>
      <input data-quality-low type="range" min="1" max="40" value="${DEFAULT_LOW_QUALITY}" aria-label="AVIF quality outside protected regions">
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

  const maskCanvas = document.createElement('canvas');
  const maskContext = maskCanvas.getContext('2d');

  let enabled = false;
  let initialized = false;
  let tool = 'protect';
  let brush = 32;
  let lowQuality = DEFAULT_LOW_QUALITY;
  let activePointer = null;
  let lastPoint = null;
  let previewTimer = 0;
  let geometryFrame = 0;

  const optimizerActive = () => viewer.classList.contains('image-optimize-active');

  function initializeMask(force = false) {
    if ((!force && initialized) || !original.naturalWidth || !original.naturalHeight) return initialized;
    const scale = Math.min(1, MASK_MAX_EDGE / Math.max(original.naturalWidth, original.naturalHeight));
    const width = Math.max(1, Math.round(original.naturalWidth * scale));
    const height = Math.max(1, Math.round(original.naturalHeight * scale));
    paintCanvas.width = maskCanvas.width = width;
    paintCanvas.height = maskCanvas.height = height;
    initialized = true;
    compressAll(false);
    queueGeometry();
    return true;
  }

  function compressAll(refresh = true) {
    if (!initialized) return;
    maskContext.save();
    maskContext.globalCompositeOperation = 'source-over';
    maskContext.fillStyle = '#000';
    maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskContext.restore();
    paintContext.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    if (refresh) requestPreview();
  }

  function syncGeometry() {
    geometryFrame = 0;
    if (!initialized || !optimizerActive()) return;
    const imageRect = original.getBoundingClientRect();
    const compareRect = compare.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height || !compareRect.width || !compareRect.height) return;
    paintCanvas.style.left = `${imageRect.left - compareRect.left}px`;
    paintCanvas.style.top = `${imageRect.top - compareRect.top}px`;
    paintCanvas.style.width = `${imageRect.width}px`;
    paintCanvas.style.height = `${imageRect.height}px`;
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
    tool = next === 'compress' ? 'compress' : 'protect';
    for (const button of panel.querySelectorAll('[data-quality-tool]')) {
      button.classList.toggle('active', button.dataset.qualityTool === tool);
    }
  }

  function setEnabled(next, refresh = true) {
    enabled = Boolean(next);
    activePointer = null;
    lastPoint = null;
    toggle.classList.toggle('active', enabled);
    toggle.textContent = enabled ? 'Painting' : 'Paint';
    panel.hidden = !enabled;
    compare.classList.toggle('image-optimize-quality-painting', enabled);
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

  function drawSegment(from, to) {
    if (!from || !to) return;
    const contexts = [
      { context:maskContext, color:tool === 'protect' ? '#fff' : '#000', composite:'source-over' },
      { context:paintContext, color:'rgba(92,178,255,.40)', composite:tool === 'protect' ? 'source-over' : 'destination-out' }
    ];
    for (const item of contexts) {
      const context = item.context;
      context.save();
      context.globalCompositeOperation = item.composite;
      context.strokeStyle = item.color;
      context.fillStyle = item.color;
      context.lineWidth = brush;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      if (Math.abs(from.x - to.x) < .01 && Math.abs(from.y - to.y) < .01) {
        context.beginPath();
        context.arc(to.x, to.y, brush / 2, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    }
  }

  function blockedTarget(event) {
    return Boolean(event.target?.closest?.('.image-optimize-controls,.viewer-optimize-trigger,.viewer-bar,.viewer-info'));
  }

  window.addEventListener('pointerdown', event => {
    if (!enabled || !optimizerActive() || blockedTarget(event) || event.button !== 0) return;
    const point = pointForEvent(event);
    if (!point) return;
    activePointer = event.pointerId;
    lastPoint = point;
    drawSegment(point, point);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener('pointermove', event => {
    if (activePointer !== event.pointerId) return;
    const point = pointForEvent(event, true);
    if (point) {
      drawSegment(lastPoint || point, point);
      lastPoint = point;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function finishPaint(event) {
    if (activePointer !== event.pointerId) return;
    const point = pointForEvent(event, true);
    if (point) drawSegment(lastPoint || point, point);
    activePointer = null;
    lastPoint = null;
    requestPreview();
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  window.addEventListener('pointerup', finishPaint, true);
  window.addEventListener('pointercancel', finishPaint, true);

  toggle.addEventListener('click', () => setEnabled(!enabled));
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-quality-tool]');
    if (button) setTool(button.dataset.qualityTool);
  });
  resetButton.addEventListener('click', () => compressAll());
  lowInput.addEventListener('input', () => {
    lowQuality = Math.max(1, Math.min(40, Number(lowInput.value) || DEFAULT_LOW_QUALITY));
    lowLabel.textContent = String(lowQuality);
    requestPreview(320);
  });
  brushInput.addEventListener('input', () => {
    brush = Math.max(6, Math.min(96, Number(brushInput.value) || 32));
    brushLabel.textContent = String(brush);
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
    lowQuality = DEFAULT_LOW_QUALITY;
    lowInput.value = String(lowQuality);
    lowLabel.textContent = String(lowQuality);
    brush = 32;
    brushInput.value = String(brush);
    brushLabel.textContent = String(brush);
    setTool('protect');
    toggle.classList.remove('active');
    toggle.textContent = 'Paint';
    panel.hidden = true;
    compare.classList.remove('image-optimize-quality-painting');
    setTimeout(() => { initializeMask(true); queueGeometry(); }, 0);
  });
  window.addEventListener('mochimono:optimize-close', () => {
    clearTimeout(previewTimer);
    previewTimer = 0;
    enabled = false;
    activePointer = null;
    lastPoint = null;
    compare.classList.remove('image-optimize-quality-painting');
    panel.hidden = true;
    toggle.classList.remove('active');
    toggle.textContent = 'Paint';
    paintContext.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  });
}