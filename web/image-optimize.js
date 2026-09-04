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
.viewer-optimize-trigger{display:inline-flex;align-items:center;margin-left:7px;padding:0;border:0;background:transparent;color:#ddd5d1;font-size:10px;font-weight:720;line-height:1;text-shadow:0 1px 4px rgba(0,0,0,.9)}
.viewer-optimize-trigger:hover{background:transparent;color:#fff}.viewer-optimize-trigger[hidden]{display:none!important}
.image-optimize-layer[hidden]{display:none!important}.image-optimize-layer{position:absolute;z-index:102;inset:0;background:#050505;overflow:hidden;color:#eee}
.viewer.image-optimize-active .viewer-nav{display:none!important}
.image-optimize-compare{--split:50%;position:absolute;inset:0;overflow:hidden;touch-action:none;background:#050505}
.image-optimize-compare img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;pointer-events:none;transform-origin:50% 50%}
.image-optimize-after{clip-path:inset(0 0 0 var(--split))}
.image-optimize-divider{position:absolute;z-index:3;left:var(--split);top:0;bottom:0;width:1px;background:rgba(255,255,255,.86);pointer-events:none;box-shadow:0 0 8px rgba(0,0,0,.4)}
.image-optimize-divider:after{content:'↔';position:absolute;left:0;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:rgba(16,16,16,.82);border:1px solid rgba(255,255,255,.38);color:#fff;font-size:11px;box-shadow:0 3px 12px rgba(0,0,0,.35)}
.image-optimize-label{position:absolute;z-index:4;top:70px;color:rgba(255,255,255,.68);font-size:10px;font-weight:700;pointer-events:none;text-shadow:0 1px 4px #000}.image-optimize-label.original{left:14px}.image-optimize-label.optimized{right:14px}
.image-optimize-loading{position:absolute;z-index:7;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(80vw,420px);padding:8px 11px;border-radius:8px;background:rgba(18,18,18,.8);color:#c2b9b5;font-size:11px;box-shadow:0 4px 20px rgba(0,0,0,.28);backdrop-filter:blur(8px);pointer-events:none}.image-optimize-loading[hidden]{display:none}
.image-optimize-controls{position:absolute;z-index:6;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(760px,calc(100% - 24px));padding:10px;border:1px solid rgba(255,255,255,.07);border-radius:13px;background:rgba(18,17,19,.91);box-shadow:0 12px 38px rgba(0,0,0,.4);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.image-optimize-main{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:11px;min-width:0}.image-optimize-mode{flex:0 0 auto;padding:8px 9px;border-radius:7px;background:transparent;color:#c8bfbc;font-size:10px}.image-optimize-mode:hover,.image-optimize-mode.open{background:rgba(255,255,255,.07);color:#fff}
.image-optimize-result{min-width:0;display:grid;gap:2px;overflow:hidden}.image-optimize-result-head{display:flex;align-items:baseline;gap:10px;min-width:0}.image-optimize-result strong{font-size:19px;line-height:1.05;letter-spacing:-.035em;white-space:nowrap}.image-optimize-result b{font-size:14px;font-weight:720;white-space:nowrap}.image-optimize-result b.good{color:#a6c9af}.image-optimize-result b.quiet{color:#918987}.image-optimize-result small{min-width:0;color:#8d8582;font-size:10px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.image-optimize-actions{display:flex;gap:5px;flex:0 0 auto}.image-optimize-actions button{padding:8px 10px;border-radius:7px;font-size:10px}.image-optimize-keep{background:transparent;color:#bdb5b2}.image-optimize-keep:hover{background:rgba(255,255,255,.07);color:#fff}.image-optimize-replace{background:#eee8e4;color:#171316}.image-optimize-replace:hover{background:#fff}
.image-optimize-panel{margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.06)}.image-optimize-panel[hidden]{display:none!important}.image-optimize-setting{display:grid;grid-template-columns:54px minmax(0,1fr);align-items:center;gap:8px;min-height:30px}.image-optimize-setting+.image-optimize-setting{margin-top:5px}.image-optimize-setting>span{color:#746d6b;font-size:9px;font-weight:700}
.image-optimize-modes{display:flex;gap:3px}.image-optimize-modes button{padding:5px 8px;border-radius:6px;background:transparent;color:#827a78;font-size:10px}.image-optimize-modes button:hover{background:rgba(255,255,255,.05);color:#d8d0cc}.image-optimize-modes button.active{background:rgba(255,255,255,.08);color:#fff}
.image-optimize-resize{width:max-content;max-width:100%;padding:6px 26px 6px 8px;border:0;border-radius:6px;background:#242124;color:#d8d0cc;font-size:10px}
.image-optimize-manual{display:grid;grid-template-columns:minmax(190px,1fr) auto auto;gap:9px;align-items:end;margin-top:8px;padding-left:62px}.image-optimize-manual[hidden]{display:none!important}.image-optimize-manual label{display:grid;gap:4px;color:#827a78;font-size:9px}.image-optimize-manual input[type=range]{width:100%;accent-color:#dba19b}.image-optimize-lossless{display:flex!important;align-items:center;gap:5px!important;padding-bottom:6px;white-space:nowrap}.image-optimize-lossless input{width:auto}.image-optimize-preview{padding:6px 8px;border-radius:6px;background:#2a2729;color:#ddd;font-size:10px}.image-optimize-final-note{margin:8px 0 0 62px;color:#68615f;font-size:9px}
.image-optimize-actions button:disabled,.image-optimize-controls button:disabled,.image-optimize-controls input:disabled,.image-optimize-controls select:disabled{opacity:.35;cursor:default}
@media(max-width:700px){.viewer-optimize-trigger{margin-left:6px}.image-optimize-label{top:60px}.image-optimize-label.original{left:9px}.image-optimize-label.optimized{right:9px}.image-optimize-controls{width:calc(100% - 16px);bottom:max(8px,env(safe-area-inset-bottom));padding:9px}.image-optimize-main{grid-template-columns:auto minmax(0,1fr);gap:7px}.image-optimize-result{grid-column:1/-1;grid-row:1}.image-optimize-mode{grid-column:1;grid-row:2;justify-self:start}.image-optimize-actions{grid-column:2;grid-row:2;justify-self:end}.image-optimize-result strong{font-size:18px}.image-optimize-result b{font-size:13px}.image-optimize-result small{font-size:9.5px}.image-optimize-setting{grid-template-columns:48px minmax(0,1fr)}.image-optimize-manual{grid-template-columns:minmax(0,1fr) auto;padding-left:56px}.image-optimize-lossless,.image-optimize-preview{grid-column:1/-1}.image-optimize-final-note{margin-left:56px}.image-optimize-divider:after{width:28px;height:28px}}
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
    <div class="image-optimize-loading" data-opt-loading>Preparing…</div>
  </div>
  <div class="image-optimize-controls">
    <div class="image-optimize-main">
      <button class="image-optimize-mode" data-opt-mode type="button" title="Auto chooses a high-quality format and caps very large images at 3072 px. Previews are fast; saving does the final max-effort encode.">Auto · ≤3072 ▾</button>
      <div class="image-optimize-result" data-opt-result><div class="image-optimize-result-head"><strong>—</strong></div></div>
      <div class="image-optimize-actions"><button class="image-optimize-keep" data-opt-keep type="button" disabled>Keep both</button><button class="image-optimize-replace" data-opt-replace type="button" disabled title="Replace the original after max-effort encoding and verification">Replace</button></div>
    </div>
    <div class="image-optimize-panel" data-opt-panel hidden>
      <div class="image-optimize-setting"><span>Format</span><div class="image-optimize-modes" data-opt-modes><button type="button" data-opt-format="auto" class="active">Auto</button><button type="button" data-opt-format="webp">WebP</button><button type="button" data-opt-format="avif">AVIF</button></div></div>
      <div class="image-optimize-setting"><span>Size</span><select class="image-optimize-resize" data-opt-resize aria-label="Maximum image edge"><option value="3072">Auto · 3072 px max</option><option value="0">Original dimensions</option><option value="3840">3840 px max</option><option value="2560">2560 px max</option><option value="1920">1920 px max</option></select></div>
      <div class="image-optimize-manual" data-opt-manual hidden>
        <label>Quality <span><input data-opt-quality type="range" min="50" max="100" value="94"> <output data-opt-quality-label>94</output></span></label>
        <label class="image-optimize-lossless" data-opt-lossless-row hidden><input data-opt-lossless type="checkbox"> Lossless</label>
        <button class="image-optimize-preview" data-opt-update type="button">Preview</button>
      </div>
      <div class="image-optimize-final-note">Preview uses normal effort · saving re-encodes once at max effort</div>
    </div>
  </div>`;
viewer?.append(layer);

const compare = layer.querySelector('[data-opt-compare]');
const original = layer.querySelector('[data-opt-original]');
const optimized = layer.querySelector('[data-opt-after]');
const loading = layer.querySelector('[data-opt-loading]');
const result = layer.querySelector('[data-opt-result]');
const modeButton = layer.querySelector('[data-opt-mode]');
const panel = layer.querySelector('[data-opt-panel]');
const modes = layer.querySelector('[data-opt-modes]');
const manual = layer.querySelector('[data-opt-manual]');
const resize = layer.querySelector('[data-opt-resize]');
const quality = layer.querySelector('[data-opt-quality]');
const qualityLabel = layer.querySelector('[data-opt-quality-label]');
const lossless = layer.querySelector('[data-opt-lossless]');
const losslessRow = layer.querySelector('[data-opt-lossless-row]');
const keep = layer.querySelector('[data-opt-keep]');
const replace = layer.querySelector('[data-opt-replace]');
const updateButton = layer.querySelector('[data-opt-update]');
let activeId = '';
let activeHash = '';
let session = null;
let pollTimer = 0;
let format = 'auto';
let split = 50;
let splitPointer = null;

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
  if (!active() || !loading.hidden) return;
  const grab = event.pointerType === 'touch' ? 42 : 30;
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

function resizeLabel() {
  const value = Number(resize.value) || 0;
  return value ? `≤${value}` : 'Original';
}

function setControlsDisabled(disabled) {
  for (const control of [...modes.querySelectorAll('button'), resize, quality, lossless, updateButton]) control.disabled = disabled;
}

function setBusy(text) {
  setControlsDisabled(true);
  loading.hidden = false;
  loading.textContent = text || 'Preparing…';
  keep.disabled = true;
  replace.disabled = true;
  result.innerHTML = '<div class="image-optimize-result-head"><strong>—</strong></div>';
}

function showError(message) {
  setControlsDisabled(false);
  loading.hidden = false;
  loading.textContent = message || 'Could not optimize this image';
  keep.disabled = true;
  replace.disabled = true;
}

function syncModeUi() {
  const label = format === 'avif' ? 'AVIF' : format === 'webp' ? 'WebP' : 'Auto';
  modeButton.textContent = `${label} · ${resizeLabel()} ▾`;
  for (const item of modes.querySelectorAll('[data-opt-format]')) item.classList.toggle('active', item.dataset.optFormat === format);
  manual.hidden = format === 'auto';
  losslessRow.hidden = format !== 'webp';
}

function setFormat(next, regenerate = true) {
  format = next;
  if (format === 'webp' && quality.dataset.userChanged !== '1') quality.value = '94';
  if (format === 'avif' && quality.dataset.userChanged !== '1') quality.value = '92';
  qualityLabel.textContent = quality.value;
  syncModeUi();
  if (regenerate && active()) startPreview();
}

function options() {
  return {
    format,
    quality: Number(quality.value) || (format === 'avif' ? 92 : 94),
    effort: 'normal',
    lossless: format === 'webp' && lossless.checked,
    resizeMax: Number(resize.value) || 0
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type':'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function progressText(data) {
  const progress = data?.progress;
  if (!progress) return 'Encoding preview…';
  const suffix = progress.total > 1 ? ` · ${Math.min(progress.total, Number(progress.done) + 1)}/${progress.total}` : '';
  return `${progress.label || 'Encoding preview…'}${suffix}`;
}

function poll(id) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!active() || id !== activeId) return;
    try {
      const data = await api(`/api/image-optimize/status?id=${encodeURIComponent(id)}`);
      if (id !== activeId) return;
      session = data;
      if (data.status === 'ready') return renderReady(data);
      if (data.status === 'error') return showError(data.error);
      loading.textContent = progressText(data);
      poll(id);
    } catch (error) { showError(error.message); }
  }, 300);
}

async function startPreview() {
  const hash = activeHash || currentHash();
  if (!hash || !active()) return;
  clearTimeout(pollTimer);
  session = null;
  setBusy('Preparing preview…');
  try {
    const data = await api('/api/image-optimize/start', { method:'POST', body:JSON.stringify({ hash, options:options() }) });
    activeId = data.id;
    loading.textContent = progressText(data);
    poll(activeId);
  } catch (error) { showError(error.message); }
}

async function decodeImage(image, src) {
  image.src = `${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`;
  if (image.decode) {
    try { await image.decode(); return; } catch {}
  }
  if (image.complete && image.naturalWidth) return;
  await new Promise((resolve, reject) => {
    image.addEventListener('load', resolve, { once:true });
    image.addEventListener('error', reject, { once:true });
  });
}

async function renderReady(data) {
  const selected = data.selected;
  if (!selected) return showError('No optimized preview was produced');
  loading.hidden = false;
  loading.textContent = 'Loading comparison…';
  try {
    await Promise.all([decodeImage(original, data.originalUrl), decodeImage(optimized, selected.url)]);
  } catch {
    return showError('Could not display the comparison');
  }
  if (!active() || data.id !== activeId) return;
  loading.hidden = true;
  setControlsDisabled(false);
  const percent = Math.max(0, Number(selected.percent) || 0);
  const verdict = data.worthwhile
    ? `<b class="good">${percent.toFixed(0)}% smaller</b>`
    : '<b class="quiet">Already efficient</b>';
  const sourceDims = `${Number(data.width).toLocaleString()}×${Number(data.height).toLocaleString()}`;
  const outputDims = `${Number(selected.width || data.targetWidth).toLocaleString()}×${Number(selected.height || data.targetHeight).toLocaleString()}`;
  const dimensions = sourceDims === outputDims ? sourceDims : `${sourceDims} → ${outputDims}`;
  result.innerHTML = `<div class="image-optimize-result-head"><strong>${bytes(data.sourceSize)} → ${bytes(selected.size)}</strong>${verdict}</div><small>${selected.label} · ${dimensions}</small>`;
  keep.disabled = false;
  replace.disabled = false;
}

function resetState() {
  clearTimeout(pollTimer);
  activeId = '';
  activeHash = '';
  session = null;
  splitPointer = null;
  setControlsDisabled(false);
  original.removeAttribute('src');
  optimized.removeAttribute('src');
  panel.hidden = true;
  modeButton.classList.remove('open');
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
  if (!session?.selected || session.status !== 'ready') return;
  if (mode === 'replace' && !confirm(`Replace ${session.filename} with the optimized ${session.selected.format.toUpperCase()}?\n\nMochimono will do one max-effort final encode, verify it, then replace the original.`)) return;
  setControlsDisabled(true);
  keep.disabled = true;
  replace.disabled = true;
  loading.hidden = false;
  loading.textContent = 'Finalizing at max effort…';
  try {
    const data = await api('/api/image-optimize/commit', {
      method:'POST',
      body:JSON.stringify({ id:session.id, candidate:session.selected.id, mode })
    });
    const saved = Number(data.result?.saved) || 0;
    loading.textContent = `${data.result?.filename || 'Saved'}${saved > 0 ? ` · saved ${bytes(saved)}` : ''}`;
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
    showError(error.message);
    if (session?.status === 'ready') { keep.disabled = false; replace.disabled = false; }
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
  resize.value = String(AUTO_MAX_EDGE);
  quality.dataset.userChanged = '';
  quality.value = '94';
  qualityLabel.textContent = '94';
  lossless.checked = false;
  syncModeUi();
  panel.hidden = true;
  modeButton.classList.remove('open');
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
modeButton.addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  modeButton.classList.toggle('open', !panel.hidden);
});
modes.addEventListener('click', event => {
  const item = event.target.closest('[data-opt-format]');
  if (item) setFormat(item.dataset.optFormat);
});
resize.addEventListener('change', () => {
  syncModeUi();
  if (active()) startPreview();
});
quality.addEventListener('input', () => {
  quality.dataset.userChanged = '1';
  qualityLabel.textContent = quality.value;
});
updateButton.addEventListener('click', startPreview);
keep.addEventListener('click', () => commit('keep'));
replace.addEventListener('click', () => commit('replace'));

document.addEventListener('keydown', event => {
  if (!active()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!panel.hidden) {
      panel.hidden = true;
      modeButton.classList.remove('open');
    } else closeOptimizer();
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
