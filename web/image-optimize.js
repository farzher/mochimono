const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');
const viewerMeta = document.querySelector('#viewer-meta');
const CLIENT = document.documentElement.classList.contains('client-library');

const SUPPORTED = new Set(['jpg','jpeg','png','webp','avif','bmp','gif','tif','tiff']);
const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const currentHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentImage = () => CLIENT && Boolean(viewerMedia?.querySelector(':scope > img')) && SUPPORTED.has(extension(viewerName?.textContent));

const style = document.createElement('style');
style.textContent = `
.viewer-optimize-trigger{display:inline-flex;align-items:center;margin-left:7px;padding:0;border:0;border-radius:0;background:transparent;color:#e1d9d5;font-size:10px;font-weight:700;line-height:1;text-shadow:0 1px 4px rgba(0,0,0,.9)}
.viewer-optimize-trigger:hover{background:transparent;color:#fff}.viewer-optimize-trigger[hidden]{display:none!important}
.image-optimize-layer[hidden]{display:none!important}.image-optimize-layer{position:absolute;z-index:102;inset:0;background:#050505;overflow:hidden;color:#eee}
.viewer.image-optimize-active .viewer-nav{display:none!important}
.image-optimize-compare{--split:50%;position:absolute;inset:0;overflow:hidden;touch-action:none;background:#050505}
.image-optimize-compare img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;pointer-events:none}
.image-optimize-after{clip-path:inset(0 0 0 var(--split))}
.image-optimize-divider{position:absolute;z-index:3;left:var(--split);top:0;bottom:0;width:1px;background:rgba(255,255,255,.92);pointer-events:none;box-shadow:0 0 8px rgba(0,0,0,.45)}
.image-optimize-divider:after{content:'↔';position:absolute;left:0;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:rgba(18,18,18,.82);border:1px solid rgba(255,255,255,.44);color:#fff;font-size:12px;box-shadow:0 3px 12px rgba(0,0,0,.35)}
.image-optimize-label{position:absolute;z-index:4;top:70px;padding:4px 7px;border-radius:999px;background:rgba(12,12,12,.55);color:rgba(255,255,255,.76);font-size:10px;font-weight:650;pointer-events:none;backdrop-filter:blur(7px)}
.image-optimize-label.original{left:14px}.image-optimize-label.optimized{right:14px}
.image-optimize-loading{position:absolute;z-index:5;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(80vw,420px);padding:7px 10px;border-radius:8px;background:rgba(20,19,20,.78);color:#b6adaa;font-size:11px;box-shadow:0 4px 20px rgba(0,0,0,.28);backdrop-filter:blur(8px);pointer-events:none}.image-optimize-loading[hidden]{display:none}
.image-optimize-controls{position:absolute;z-index:6;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(760px,calc(100% - 24px));display:grid;gap:9px;padding:10px 11px;border:1px solid rgba(255,255,255,.08);border-radius:13px;background:rgba(20,18,20,.88);box-shadow:0 12px 38px rgba(0,0,0,.42);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.image-optimize-result-row{display:flex;align-items:center;gap:10px;min-width:0}.image-optimize-result{min-width:0;flex:1;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.image-optimize-result strong{font-size:16px;letter-spacing:-.025em}.image-optimize-result span{font-size:10px;color:#978f8c}.image-optimize-result .good{color:#a6c9af}.image-optimize-result .quiet{color:#817977}
.image-optimize-actions{display:flex;gap:6px;flex:0 0 auto}.image-optimize-actions button{padding:7px 9px;border-radius:7px;font-size:10px}.image-optimize-keep{background:#292629;color:#ddd}.image-optimize-replace{background:#eee8e4;color:#171316}
.image-optimize-settings{display:flex;align-items:center;gap:7px;min-width:0}.image-optimize-presets{display:flex;gap:3px}.image-optimize-presets button{padding:5px 8px;border-radius:6px;background:transparent;color:#918a87;font-size:10px}.image-optimize-presets button:hover{background:#292629;color:#ddd}.image-optimize-presets button.active{background:#302c2f;color:#f5efec}
.image-optimize-status{min-width:0;flex:1;color:#817977;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
.image-optimize-advanced{position:relative;color:#928a88;font-size:10px}.image-optimize-advanced>summary{list-style:none;cursor:pointer;padding:5px 6px;border-radius:6px;white-space:nowrap}.image-optimize-advanced>summary::-webkit-details-marker{display:none}.image-optimize-advanced>summary:hover,.image-optimize-advanced[open]>summary{background:#292629;color:#ddd}
.image-optimize-advanced-panel{display:grid;grid-template-columns:minmax(170px,1fr) 120px auto auto;gap:9px;align-items:end;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)}.image-optimize-advanced label{display:grid;gap:4px}.image-optimize-advanced input[type=range]{width:100%;accent-color:#dba19b}.image-optimize-advanced select{width:100%;padding:6px 7px;border:0;border-radius:6px;background:#262326;color:#ddd;font-size:10px}.image-optimize-lossless{display:flex!important;align-items:center;gap:5px!important;padding-bottom:6px;white-space:nowrap}.image-optimize-lossless input{width:auto}.image-optimize-update{padding:6px 8px;border-radius:6px;background:#2d292c;color:#ddd;font-size:10px}
.image-optimize-actions button:disabled,.image-optimize-controls button:disabled,.image-optimize-controls input:disabled,.image-optimize-controls select:disabled{opacity:.35;cursor:default}
@media(max-width:700px){.viewer-optimize-trigger{margin-left:6px}.image-optimize-label{top:60px}.image-optimize-label.original{left:9px}.image-optimize-label.optimized{right:9px}.image-optimize-controls{width:calc(100% - 16px);bottom:max(8px,env(safe-area-inset-bottom));gap:8px;padding:9px;border-radius:11px}.image-optimize-result-row{align-items:flex-end}.image-optimize-result strong{font-size:14px}.image-optimize-result span{font-size:9px}.image-optimize-actions button{padding:7px 8px}.image-optimize-settings{flex-wrap:wrap}.image-optimize-status{order:3;flex-basis:100%;text-align:left}.image-optimize-advanced-panel{grid-template-columns:minmax(0,1fr) 92px}.image-optimize-lossless,.image-optimize-update{grid-column:1/-1}.image-optimize-divider:after{width:28px;height:28px}}
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
    <div class="image-optimize-result-row">
      <div class="image-optimize-result" data-opt-result><strong>—</strong></div>
      <div class="image-optimize-actions"><button class="image-optimize-keep" data-opt-keep type="button" disabled>Keep both</button><button class="image-optimize-replace" data-opt-replace type="button" disabled>Replace original</button></div>
    </div>
    <div class="image-optimize-settings">
      <div class="image-optimize-presets" data-opt-presets><button type="button" data-opt-format="auto" class="active">Auto</button><button type="button" data-opt-format="webp">WebP</button><button type="button" data-opt-format="avif">AVIF</button></div>
      <details class="image-optimize-advanced" data-opt-advanced><summary>Advanced</summary></details>
      <span class="image-optimize-status" data-opt-status>No resize · metadata copied where supported</span>
    </div>
    <div class="image-optimize-advanced-panel" data-opt-advanced-panel hidden>
      <label>Quality <span><input data-opt-quality type="range" min="50" max="100" value="94"> <output data-opt-quality-label>94</output></span></label>
      <label>Effort <select data-opt-effort><option value="max">Max</option><option value="normal">Normal</option></select></label>
      <label class="image-optimize-lossless" data-opt-lossless-row hidden><input data-opt-lossless type="checkbox"> Lossless</label>
      <button class="image-optimize-update" data-opt-update type="button">Update preview</button>
    </div>
  </div>`;
viewer?.append(layer);

const compare = layer.querySelector('[data-opt-compare]');
const original = layer.querySelector('[data-opt-original]');
const optimized = layer.querySelector('[data-opt-after]');
const loading = layer.querySelector('[data-opt-loading]');
const result = layer.querySelector('[data-opt-result]');
const status = layer.querySelector('[data-opt-status]');
const quality = layer.querySelector('[data-opt-quality]');
const qualityLabel = layer.querySelector('[data-opt-quality-label]');
const effort = layer.querySelector('[data-opt-effort]');
const lossless = layer.querySelector('[data-opt-lossless]');
const losslessRow = layer.querySelector('[data-opt-lossless-row]');
const keep = layer.querySelector('[data-opt-keep]');
const replace = layer.querySelector('[data-opt-replace]');
const presets = layer.querySelector('[data-opt-presets]');
const advanced = layer.querySelector('[data-opt-advanced]');
const advancedPanel = layer.querySelector('[data-opt-advanced-panel]');
const updateButton = layer.querySelector('[data-opt-update]');
let activeId = '';
let activeHash = '';
let session = null;
let pollTimer = 0;
let format = 'auto';
let split = 50;

const active = () => Boolean(viewer?.classList.contains('image-optimize-active'));
const bytes = number => {
  const units = ['B','KB','MB','GB','TB'];
  let value = Math.max(0, Number(number) || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

function setSplit(value) {
  split = Math.max(0, Math.min(100, Number(value) || 0));
  compare.style.setProperty('--split', `${split}%`);
}

function pointerSplit(event) {
  const rect = compare.getBoundingClientRect();
  if (!rect.width) return;
  setSplit((event.clientX - rect.left) / rect.width * 100);
}
compare.addEventListener('pointerdown', event => {
  if (!active() || !loading.hidden) return;
  compare.setPointerCapture?.(event.pointerId);
  pointerSplit(event);
  event.preventDefault();
});
compare.addEventListener('pointermove', event => {
  if (!compare.hasPointerCapture?.(event.pointerId)) return;
  pointerSplit(event);
  event.preventDefault();
});

function syncTrigger() {
  trigger.hidden = !active() && (!currentImage() || !currentHash());
  trigger.textContent = active() ? 'Done' : 'Optimize';
}

function setControlsDisabled(disabled) {
  for (const control of [...presets.querySelectorAll('button'), quality, effort, lossless, updateButton]) control.disabled = disabled;
}

function setBusy(text) {
  setControlsDisabled(true);
  loading.hidden = false;
  loading.textContent = text || 'Preparing…';
  keep.disabled = true;
  replace.disabled = true;
  result.innerHTML = '<strong>—</strong>';
}

function showError(message) {
  setControlsDisabled(false);
  loading.hidden = false;
  loading.textContent = message || 'Could not optimize this image';
  status.textContent = '';
  keep.disabled = true;
  replace.disabled = true;
}

function setFormat(next, regenerate = true) {
  format = next;
  for (const item of presets.querySelectorAll('[data-opt-format]')) item.classList.toggle('active', item.dataset.optFormat === format);
  losslessRow.hidden = format !== 'webp';
  if (format === 'webp' && quality.dataset.userChanged !== '1') quality.value = '94';
  if (format === 'avif' && quality.dataset.userChanged !== '1') quality.value = '92';
  qualityLabel.textContent = quality.value;
  if (regenerate && active()) startPreview();
}

function options() {
  return {
    format,
    quality: Number(quality.value) || (format === 'avif' ? 92 : 94),
    effort: effort.value === 'normal' ? 'normal' : 'max',
    lossless: format === 'webp' && lossless.checked
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
  if (!progress) return 'Encoding…';
  const suffix = progress.total > 1 ? ` · ${Math.min(progress.total, Number(progress.done) + 1)}/${progress.total}` : '';
  return `${progress.label || 'Encoding…'}${suffix}`;
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
  }, 350);
}

async function startPreview() {
  const hash = activeHash || currentHash();
  if (!hash || !active()) return;
  clearTimeout(pollTimer);
  session = null;
  setBusy('Preparing…');
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
  setSplit(50);
  loading.hidden = true;
  setControlsDisabled(false);
  const percent = Math.max(0, Number(selected.percent) || 0);
  const verdict = data.worthwhile ? `<span class="good">${percent.toFixed(0)}% smaller</span>` : '<span class="quiet">Already fairly efficient</span>';
  result.innerHTML = `<strong>${bytes(data.sourceSize)} → ${bytes(selected.size)}</strong>${verdict}<span>${selected.label}${data.options?.effort === 'max' ? ' · max effort' : ''}</span>`;
  status.textContent = `No resize · metadata copied where supported · ${Number(data.width).toLocaleString()}×${Number(data.height).toLocaleString()}`;
  keep.disabled = false;
  replace.disabled = false;
}

function resetState() {
  clearTimeout(pollTimer);
  activeId = '';
  activeHash = '';
  session = null;
  setControlsDisabled(false);
  original.removeAttribute('src');
  optimized.removeAttribute('src');
  advanced.open = false;
  advancedPanel.hidden = true;
}

function closeOptimizer() {
  if (!active()) return;
  viewer.classList.remove('image-optimize-active');
  layer.hidden = true;
  resetState();
  syncTrigger();
}

async function commit(mode) {
  if (!session?.selected || session.status !== 'ready') return;
  if (mode === 'replace' && !confirm(`Replace ${session.filename} with the optimized ${session.selected.format.toUpperCase()}?\n\nThe optimized file is verified before the original is removed.`)) return;
  setControlsDisabled(true);
  keep.disabled = true;
  replace.disabled = true;
  loading.hidden = false;
  loading.textContent = mode === 'replace' ? 'Replacing original…' : 'Saving optimized copy…';
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
  activeHash = hash;
  activeId = '';
  session = null;
  format = 'auto';
  quality.dataset.userChanged = '';
  quality.value = '94';
  qualityLabel.textContent = '94';
  effort.value = 'max';
  lossless.checked = false;
  setFormat('auto', false);
  const shown = viewerMedia.querySelector(':scope > img');
  const placeholder = shown?.currentSrc || shown?.src || viewerOpen?.href || '';
  if (placeholder) {
    original.src = placeholder;
    optimized.src = placeholder;
  }
  viewer.classList.add('image-optimize-active');
  layer.hidden = false;
  syncTrigger();
  startPreview();
}

trigger.addEventListener('click', () => active() ? closeOptimizer() : openOptimizer());
presets.addEventListener('click', event => {
  const item = event.target.closest('[data-opt-format]');
  if (item) setFormat(item.dataset.optFormat);
});
advanced.addEventListener('toggle', () => { advancedPanel.hidden = !advanced.open; });
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
    closeOptimizer();
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
