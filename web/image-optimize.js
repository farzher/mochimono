const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');
const viewerMeta = document.querySelector('#viewer-meta');
const CLIENT = document.documentElement.classList.contains('client-library');

const SUPPORTED = new Set(['jpg','jpeg','png','webp','avif','bmp','gif','tif','tiff']);
const AUTO_MAX_EDGE = 3072;
const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const currentHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentImage = () => CLIENT && Boolean(viewerMedia?.querySelector(':scope > img')) && SUPPORTED.has(extension(viewerName?.textContent));

const style = document.createElement('style');
style.textContent = `
.viewer-optimize-trigger{display:inline-flex;align-items:center;margin-left:7px;padding:0;border:0;background:transparent;color:#ddd5d1;font-size:10px;font-weight:700;line-height:1;text-shadow:0 1px 4px rgba(0,0,0,.9)}
.viewer-optimize-trigger:hover{background:transparent;color:#fff}.viewer-optimize-trigger[hidden]{display:none!important}
.image-optimize-layer[hidden]{display:none!important}.image-optimize-layer{position:absolute;z-index:102;inset:0;background:#050505;overflow:hidden;color:#eee}
.viewer.image-optimize-active .viewer-nav{display:none!important}
.image-optimize-compare{--split:50%;position:absolute;inset:0;overflow:hidden;touch-action:none;background:#050505}
.image-optimize-compare img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;pointer-events:none;transform-origin:50% 50%}
.image-optimize-after{clip-path:inset(0 0 0 var(--split))}
.image-optimize-divider{position:absolute;z-index:3;left:var(--split);top:0;bottom:0;width:1px;background:rgba(255,255,255,.88);pointer-events:none;box-shadow:0 0 8px rgba(0,0,0,.4)}
.image-optimize-divider:after{content:'↔';position:absolute;left:0;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:rgba(14,14,14,.86);border:1px solid rgba(255,255,255,.35);color:#fff;font-size:12px;box-shadow:0 3px 14px rgba(0,0,0,.42)}
.image-optimize-label{position:absolute;z-index:4;top:70px;color:rgba(255,255,255,.72);font-size:11px;font-weight:700;pointer-events:none;text-shadow:0 1px 5px #000}.image-optimize-label.original{left:16px}.image-optimize-label.optimized{right:16px}
.image-optimize-controls{position:absolute;z-index:6;right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));width:min(350px,calc(100% - 28px));padding:14px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(20,19,20,.92);box-shadow:0 16px 48px rgba(0,0,0,.46);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.image-optimize-drawer{position:absolute;right:0;bottom:calc(100% + 9px);width:100%;padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:13px;background:rgba(20,19,20,.95);box-shadow:0 12px 34px rgba(0,0,0,.42);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.image-optimize-drawer[hidden],.image-optimize-pane[hidden]{display:none!important}
.image-optimize-result{display:grid;gap:5px}.image-optimize-result-line{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.image-optimize-result strong{font-size:23px;line-height:1;letter-spacing:-.04em;white-space:nowrap}.image-optimize-result b{font-size:17px;line-height:1;font-weight:720;white-space:nowrap}.image-optimize-result b.good{color:#a9ceb1}.image-optimize-result b.quiet{color:#aaa19e}.image-optimize-status{min-height:15px;color:#968e8a;font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.image-optimize-quick{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:12px}.image-optimize-quick button,.image-optimize-choice{min-height:36px;border:0;border-radius:9px;background:#2a2829;color:#ddd7d3;font-size:12px;font-weight:650}.image-optimize-quick button:hover,.image-optimize-choice:hover{background:#343132;color:#fff}.image-optimize-quick button.open{background:#3a3638;color:#fff}
.image-optimize-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px}.image-optimize-actions button{min-height:38px;border-radius:9px;font-size:12px;font-weight:700}.image-optimize-keep{background:#2a2829;color:#d2cbc7}.image-optimize-keep:hover{background:#343132;color:#fff}.image-optimize-replace{background:#eee9e5;color:#171416}.image-optimize-replace:hover{background:#fff}.image-optimize-actions button:disabled{opacity:.36;cursor:default}
.image-optimize-pane-title{margin:0 0 9px;color:#8d8581;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.image-optimize-choice-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.image-optimize-choice-grid.size{grid-template-columns:repeat(3,1fr)}.image-optimize-choice.active{background:#eee9e5;color:#171416}.image-optimize-choice.wide{grid-column:span 3}
.image-optimize-quality{display:grid;gap:8px}.image-optimize-quality-head{display:flex;justify-content:space-between;align-items:center;color:#d6cfcb;font-size:12px;font-weight:650}.image-optimize-quality output{font-variant-numeric:tabular-nums}.image-optimize-quality input[type=range]{width:100%;accent-color:#eee9e5}.image-optimize-lossless{display:flex;align-items:center;gap:8px;margin-top:11px;color:#cfc7c3;font-size:12px}.image-optimize-lossless[hidden]{display:none!important}.image-optimize-more-empty{color:#8f8784;font-size:11px;line-height:1.4}
@media(max-width:700px){.viewer-optimize-trigger{margin-left:6px}.image-optimize-label{top:60px;font-size:10px}.image-optimize-label.original{left:10px}.image-optimize-label.optimized{right:10px}.image-optimize-controls{right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom));width:min(340px,calc(100% - 16px));padding:12px}.image-optimize-result-line{align-items:flex-end}.image-optimize-result strong{font-size:21px}.image-optimize-result b{font-size:16px}.image-optimize-status{font-size:10.5px}.image-optimize-quick button,.image-optimize-actions button,.image-optimize-choice{font-size:11px}.image-optimize-divider:after{width:30px;height:30px}}
`;
document.head.append(style);

const trigger = document.createElement('button');
trigger.type = 'button';
trigger.className = 'viewer-optimize-trigger';
trigger.textContent = 'Optimize';
trigger.hidden = true;
viewerMeta?.after(trigger);

const layer = document.createElement('div');
layer.className = 'image-optimize-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="image-optimize-compare" data-opt-compare>
    <img data-opt-original alt="Original" draggable="false">
    <img class="image-optimize-after" data-opt-after alt="Optimized" draggable="false">
    <span class="image-optimize-label original">Original</span>
    <span class="image-optimize-label optimized">Optimized</span>
    <i class="image-optimize-divider"></i>
  </div>
  <div class="image-optimize-controls" data-opt-controls>
    <div class="image-optimize-drawer" data-opt-drawer hidden>
      <div class="image-optimize-pane" data-opt-pane="format" hidden>
        <div class="image-optimize-pane-title">Format</div>
        <div class="image-optimize-choice-grid" data-opt-formats>
          <button class="image-optimize-choice" type="button" data-format="auto">Auto</button>
          <button class="image-optimize-choice" type="button" data-format="webp">WebP</button>
          <button class="image-optimize-choice" type="button" data-format="avif">AVIF</button>
        </div>
      </div>
      <div class="image-optimize-pane" data-opt-pane="size" hidden>
        <div class="image-optimize-pane-title">Size</div>
        <div class="image-optimize-choice-grid size" data-opt-sizes>
          <button class="image-optimize-choice" type="button" data-size-kind="auto" data-size-value="3072">Auto</button>
          <button class="image-optimize-choice" type="button" data-size-kind="percent" data-size-value="100">100%</button>
          <button class="image-optimize-choice" type="button" data-size-kind="percent" data-size-value="75">75%</button>
          <button class="image-optimize-choice" type="button" data-size-kind="percent" data-size-value="50">50%</button>
          <button class="image-optimize-choice" type="button" data-size-kind="percent" data-size-value="25">25%</button>
          <button class="image-optimize-choice" type="button" data-size-kind="max" data-size-value="3840">3840 px</button>
          <button class="image-optimize-choice" type="button" data-size-kind="max" data-size-value="3072">3072 px</button>
          <button class="image-optimize-choice" type="button" data-size-kind="max" data-size-value="2560">2560 px</button>
          <button class="image-optimize-choice" type="button" data-size-kind="max" data-size-value="1920">1920 px</button>
        </div>
      </div>
      <div class="image-optimize-pane" data-opt-pane="more" hidden>
        <div class="image-optimize-more-empty" data-opt-auto-more>Choose WebP or AVIF to set quality manually.</div>
        <div class="image-optimize-quality" data-opt-quality-wrap hidden>
          <div class="image-optimize-quality-head"><span>Quality</span><output data-opt-quality-label>94</output></div>
          <input data-opt-quality type="range" min="50" max="100" value="94">
        </div>
        <label class="image-optimize-lossless" data-opt-lossless-row hidden><input data-opt-lossless type="checkbox"> Lossless WebP</label>
      </div>
    </div>
    <div class="image-optimize-result" data-opt-result>
      <div class="image-optimize-result-line"><strong>Preparing…</strong><b></b></div>
      <div class="image-optimize-status" data-opt-status>Starting preview…</div>
    </div>
    <div class="image-optimize-quick">
      <button type="button" data-opt-format-button>Auto</button>
      <button type="button" data-opt-size-button>Size · Auto</button>
      <button type="button" data-opt-more-button>More</button>
    </div>
    <div class="image-optimize-actions">
      <button class="image-optimize-keep" data-opt-keep type="button" disabled>Keep both</button>
      <button class="image-optimize-replace" data-opt-replace type="button" disabled>Replace</button>
    </div>
  </div>`;
viewer?.append(layer);

const compare = layer.querySelector('[data-opt-compare]');
const original = layer.querySelector('[data-opt-original]');
const optimized = layer.querySelector('[data-opt-after]');
const controls = layer.querySelector('[data-opt-controls]');
const drawer = layer.querySelector('[data-opt-drawer]');
const panes = [...layer.querySelectorAll('[data-opt-pane]')];
const formats = layer.querySelector('[data-opt-formats]');
const sizes = layer.querySelector('[data-opt-sizes]');
const formatButton = layer.querySelector('[data-opt-format-button]');
const sizeButton = layer.querySelector('[data-opt-size-button]');
const moreButton = layer.querySelector('[data-opt-more-button]');
const result = layer.querySelector('[data-opt-result]');
const status = layer.querySelector('[data-opt-status]');
const quality = layer.querySelector('[data-opt-quality]');
const qualityLabel = layer.querySelector('[data-opt-quality-label]');
const qualityWrap = layer.querySelector('[data-opt-quality-wrap]');
const autoMore = layer.querySelector('[data-opt-auto-more]');
const lossless = layer.querySelector('[data-opt-lossless]');
const losslessRow = layer.querySelector('[data-opt-lossless-row]');
const keep = layer.querySelector('[data-opt-keep]');
const replace = layer.querySelector('[data-opt-replace]');

let activeId = '';
let activeHash = '';
let session = null;
let pollTimer = 0;
let requestSerial = 0;
let renderSerial = 0;
let format = 'auto';
let sizeMode = { kind:'auto', value:AUTO_MAX_EDGE };
let split = 50;
let splitPointer = null;
let openPane = '';
let displayedCandidate = '';
let committing = false;

const active = () => Boolean(viewer?.classList.contains('image-optimize-active'));
const bytes = number => {
  const units = ['B','KB','MB','GB','TB'];
  let value = Math.max(0, Number(number) || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

function captureViewerView(image) {
  if (!image) return { scale:1, x:0, y:0 };
  const transform = getComputedStyle(image).transform;
  if (!transform || transform === 'none') return { scale:1, x:0, y:0 };
  try {
    const matrix = new DOMMatrixReadOnly(transform);
    return {
      scale: Math.max(.1, Math.hypot(matrix.a, matrix.b) || 1),
      x: Number(matrix.e) || 0,
      y: Number(matrix.f) || 0
    };
  } catch {
    return { scale:1, x:0, y:0 };
  }
}

function setSplit(value) {
  split = Math.max(0, Math.min(100, Number(value) || 0));
  compare.style.setProperty('--split', `${split}%`);
}

function pointerSplit(event) {
  const rect = compare.getBoundingClientRect();
  if (!rect.width) return;
  setSplit((event.clientX - rect.left) / rect.width * 100);
}

function dividerX() {
  const rect = compare.getBoundingClientRect();
  return rect.left + rect.width * split / 100;
}

compare.addEventListener('pointerdown', event => {
  if (!active()) return;
  const grab = event.pointerType === 'touch' ? 44 : 30;
  if (Math.abs(event.clientX - dividerX()) > grab) return;
  splitPointer = event.pointerId;
  try { compare.setPointerCapture(event.pointerId); } catch {}
  pointerSplit(event);
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
compare.addEventListener('pointermove', event => {
  if (splitPointer !== event.pointerId) return;
  pointerSplit(event);
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
function finishSplit(event) {
  if (splitPointer !== event.pointerId) return;
  try { compare.releasePointerCapture(event.pointerId); } catch {}
  splitPointer = null;
  event.preventDefault();
  event.stopImmediatePropagation();
}
compare.addEventListener('pointerup', finishSplit, true);
compare.addEventListener('pointercancel', finishSplit, true);

function syncTrigger() {
  trigger.hidden = !active() && (!currentImage() || !currentHash());
  trigger.textContent = active() ? 'Done' : 'Optimize';
}

function sizeLabel() {
  if (sizeMode.kind === 'percent') return `${sizeMode.value}%`;
  if (sizeMode.kind === 'max') return `${sizeMode.value} px`;
  return 'Auto';
}

function syncControls() {
  formatButton.textContent = format === 'avif' ? 'AVIF' : format === 'webp' ? 'WebP' : 'Auto';
  sizeButton.textContent = `Size · ${sizeLabel()}`;
  for (const button of formats.querySelectorAll('[data-format]')) button.classList.toggle('active', button.dataset.format === format);
  for (const button of sizes.querySelectorAll('[data-size-kind]')) {
    const kind = button.dataset.sizeKind;
    const value = Number(button.dataset.sizeValue);
    button.classList.toggle('active', kind === sizeMode.kind && value === sizeMode.value);
  }
  const manual = format !== 'auto';
  autoMore.hidden = manual;
  qualityWrap.hidden = !manual;
  losslessRow.hidden = format !== 'webp';
  qualityLabel.textContent = quality.value;
}

function closeDrawer() {
  openPane = '';
  drawer.hidden = true;
  for (const pane of panes) pane.hidden = true;
  for (const button of [formatButton, sizeButton, moreButton]) button.classList.remove('open');
}

function togglePane(name, button) {
  if (openPane === name) return closeDrawer();
  openPane = name;
  drawer.hidden = false;
  for (const pane of panes) pane.hidden = pane.dataset.optPane !== name;
  for (const item of [formatButton, sizeButton, moreButton]) item.classList.toggle('open', item === button);
}

function options() {
  return {
    format,
    quality: Number(quality.value) || (format === 'avif' ? 92 : 94),
    effort: 'normal',
    lossless: format === 'webp' && lossless.checked,
    resizeMax: sizeMode.kind === 'auto' || sizeMode.kind === 'max' ? sizeMode.value : 0,
    resizePercent: sizeMode.kind === 'percent' ? sizeMode.value : 0
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type':'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function progressLabel(data) {
  if (data.status === 'queued') return 'Waiting for encoder…';
  const label = String(data.progress?.label || '').trim();
  if (!label) return data.status === 'encoding' ? 'Encoding…' : '';
  return label === 'Reading image' ? 'Reading image…' : `${label.replace(/^Encoding\s+/,'')}…`;
}

function dimensionsText(data, selected) {
  if (!data.width || !data.height) return '';
  const sourceDims = `${Number(data.width).toLocaleString()}×${Number(data.height).toLocaleString()}`;
  const outWidth = Number(selected?.width || data.targetWidth || data.width);
  const outHeight = Number(selected?.height || data.targetHeight || data.height);
  const outputDims = `${outWidth.toLocaleString()}×${outHeight.toLocaleString()}`;
  return sourceDims === outputDims ? sourceDims : `${sourceDims} → ${outputDims}`;
}

function updateResult(data) {
  const selected = data.selected;
  if (!selected) {
    const source = data.sourceSize ? bytes(data.sourceSize) : 'Preparing…';
    result.querySelector('strong').textContent = source;
    result.querySelector('b').textContent = '';
    status.textContent = progressLabel(data) || 'Preparing preview…';
    return;
  }

  const percent = Math.max(0, Number(selected.percent) || 0);
  result.querySelector('strong').textContent = `${bytes(data.sourceSize)} → ${bytes(selected.size)}`;
  const verdict = result.querySelector('b');
  verdict.textContent = data.worthwhile ? `${percent.toFixed(0)}% smaller` : 'Already efficient';
  verdict.className = data.worthwhile ? 'good' : 'quiet';

  const dims = dimensionsText(data, selected);
  if (data.status === 'encoding' || data.status === 'queued') {
    const work = progressLabel(data);
    status.textContent = `Showing ${selected.label}${work ? ` · ${work}` : ''}`;
  } else {
    status.textContent = `${selected.label}${dims ? ` · ${dims}` : ''}`;
  }
}

async function preload(src) {
  const image = new Image();
  image.src = `${src}${src.includes('?') ? '&' : '?'}v=${Date.now()}`;
  if (image.decode) {
    try { await image.decode(); return image.src; } catch {}
  }
  if (image.complete && image.naturalWidth) return image.src;
  await new Promise((resolve, reject) => {
    image.addEventListener('load', resolve, { once:true });
    image.addEventListener('error', reject, { once:true });
  });
  return image.src;
}

async function renderCandidate(data) {
  const selected = data.selected;
  if (!selected) return;
  const key = `${data.id}:${selected.id}`;
  if (displayedCandidate === key) return;
  const serial = ++renderSerial;
  try {
    const optimizedSrc = await preload(selected.url);
    if (!active() || data.id !== activeId || serial !== renderSerial) return;
    optimized.src = optimizedSrc;
    displayedCandidate = key;

    if (data.originalUrl && original.dataset.sourceUrl !== data.originalUrl) {
      original.dataset.sourceUrl = data.originalUrl;
      preload(data.originalUrl).then(src => {
        if (active() && data.id === activeId && original.dataset.sourceUrl === data.originalUrl) original.src = src;
      }).catch(() => {});
    }
  } catch {
    // Keep the previous visible preview. Polling can still recover if a later
    // candidate completes successfully.
  }
}

function setSaveState(data) {
  const ready = !committing && data?.status === 'ready' && Boolean(data.selected);
  keep.disabled = !ready;
  replace.disabled = !ready;
}

function showError(message) {
  status.textContent = message || 'Could not optimize this image';
  keep.disabled = true;
  replace.disabled = true;
}

function consume(data, serial) {
  if (!active() || serial !== requestSerial || data.id !== activeId) return;
  session = data;
  updateResult(data);
  if (data.selected) renderCandidate(data);
  setSaveState(data);
  if (data.status === 'error') return showError(data.error);
  if (data.status === 'ready') return;
  poll(data.id, serial);
}

function poll(id, serial) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!active() || serial !== requestSerial || id !== activeId) return;
    try {
      const data = await api(`/api/image-optimize/status?id=${encodeURIComponent(id)}`);
      consume(data, serial);
    } catch (error) {
      if (serial === requestSerial) showError(error.message);
    }
  }, 240);
}

async function startPreview() {
  const hash = activeHash || currentHash();
  if (!hash || !active() || committing) return;
  const serial = ++requestSerial;
  clearTimeout(pollTimer);
  session = null;
  keep.disabled = true;
  replace.disabled = true;
  status.textContent = 'Starting preview…';
  try {
    const data = await api('/api/image-optimize/start', {
      method:'POST',
      body:JSON.stringify({ hash, options:options() })
    });
    if (!active() || serial !== requestSerial) return;
    activeId = data.id;
    consume(data, serial);
  } catch (error) {
    if (serial === requestSerial) showError(error.message);
  }
}

function setFormat(next) {
  if (!['auto','webp','avif'].includes(next) || next === format) return closeDrawer();
  format = next;
  if (format === 'webp' && quality.dataset.userChanged !== '1') quality.value = '94';
  if (format === 'avif' && quality.dataset.userChanged !== '1') quality.value = '92';
  if (format !== 'webp') lossless.checked = false;
  syncControls();
  closeDrawer();
  startPreview();
}

function setSize(kind, value) {
  if (!['auto','percent','max'].includes(kind)) return;
  value = Number(value) || 0;
  if (!value || (kind === sizeMode.kind && value === sizeMode.value)) return closeDrawer();
  sizeMode = { kind, value };
  syncControls();
  closeDrawer();
  startPreview();
}

function resetState() {
  clearTimeout(pollTimer);
  requestSerial++;
  renderSerial++;
  activeId = '';
  activeHash = '';
  session = null;
  splitPointer = null;
  displayedCandidate = '';
  committing = false;
  original.removeAttribute('src');
  original.removeAttribute('data-source-url');
  optimized.removeAttribute('src');
  closeDrawer();
}

function closeOptimizer() {
  if (!active()) return;
  viewer.classList.remove('image-optimize-active');
  layer.hidden = true;
  window.dispatchEvent(new CustomEvent('mochimono:optimize-close'));
  resetState();
  syncTrigger();
}

async function commit(mode) {
  if (committing || !session?.selected || session.status !== 'ready') return;
  if (mode === 'replace' && !confirm(`Replace ${session.filename} with the optimized ${session.selected.format.toUpperCase()}?\n\nMochimono will make a max-effort final encode, verify it, then replace the original.`)) return;
  committing = true;
  keep.disabled = true;
  replace.disabled = true;
  status.textContent = 'Finalizing at max effort…';
  try {
    const data = await api('/api/image-optimize/commit', {
      method:'POST',
      body:JSON.stringify({ id:session.id, candidate:session.selected.id, mode })
    });
    const saved = Number(data.result?.saved) || 0;
    status.textContent = `${data.result?.filename || 'Saved'}${saved > 0 ? ` · saved ${bytes(saved)}` : ''}`;
    setTimeout(() => {
      closeOptimizer();
      if (mode === 'replace') document.querySelector('#viewer-close')?.click();
      setTimeout(() => {
        window.mochimonoLibrary?.refresh?.();
        window.mochimonoLocations?.refresh?.();
        window.dispatchEvent(new CustomEvent('mochimono:catalog-updated'));
      }, 500);
      setTimeout(() => window.mochimonoLibrary?.refresh?.(), 1600);
    }, 650);
  } catch (error) {
    committing = false;
    showError(error.message);
    setSaveState(session);
  }
}

function openOptimizer(hash = currentHash()) {
  if (!CLIENT || !hash || !currentImage()) return;
  const shown = viewerMedia.querySelector(':scope > img');
  const initialView = captureViewerView(shown);
  activeHash = hash;
  activeId = '';
  session = null;
  format = 'auto';
  sizeMode = { kind:'auto', value:AUTO_MAX_EDGE };
  quality.dataset.userChanged = '';
  quality.value = '94';
  lossless.checked = false;
  displayedCandidate = '';
  committing = false;
  setSplit(50);
  syncControls();
  closeDrawer();
  const placeholder = shown?.currentSrc || shown?.src || viewerOpen?.href || '';
  if (placeholder) {
    original.src = placeholder;
    optimized.src = placeholder;
  }
  viewer.classList.add('image-optimize-active');
  layer.hidden = false;
  syncTrigger();
  window.dispatchEvent(new CustomEvent('mochimono:optimize-open', { detail:{ view:initialView } }));
  startPreview();
}

trigger.addEventListener('click', () => active() ? closeOptimizer() : openOptimizer());
formatButton.addEventListener('click', () => togglePane('format', formatButton));
sizeButton.addEventListener('click', () => togglePane('size', sizeButton));
moreButton.addEventListener('click', () => togglePane('more', moreButton));
formats.addEventListener('click', event => {
  const button = event.target.closest('[data-format]');
  if (button) setFormat(button.dataset.format);
});
sizes.addEventListener('click', event => {
  const button = event.target.closest('[data-size-kind]');
  if (button) setSize(button.dataset.sizeKind, button.dataset.sizeValue);
});
quality.addEventListener('input', () => {
  quality.dataset.userChanged = '1';
  qualityLabel.textContent = quality.value;
});
quality.addEventListener('change', startPreview);
lossless.addEventListener('change', startPreview);
keep.addEventListener('click', () => commit('keep'));
replace.addEventListener('click', () => commit('replace'));

controls.addEventListener('pointerdown', event => event.stopPropagation());

document.addEventListener('keydown', event => {
  if (!active()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (openPane) closeDrawer();
    else closeOptimizer();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

if (viewerMedia) new MutationObserver(() => {
  if (active() && currentHash() !== activeHash) closeOptimizer();
  syncTrigger();
}).observe(viewerMedia, { childList:true, subtree:true });
if (viewerName) new MutationObserver(syncTrigger).observe(viewerName, { childList:true, characterData:true, subtree:true });
if (viewer) new MutationObserver(() => {
  if (viewer.hidden && active()) closeOptimizer();
  syncTrigger();
}).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
syncTrigger();

window.mochimonoImageOptimize = { open:openOptimizer, close:closeOptimizer };
