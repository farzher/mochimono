const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');
const viewerMenu = document.querySelector('#viewer-menu');
const CLIENT = document.documentElement.classList.contains('client-library');

const SUPPORTED = new Set(['jpg','jpeg','png','webp','avif','bmp','gif','tif','tiff']);
const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const currentHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentImage = () => CLIENT && Boolean(viewerMedia?.querySelector(':scope > img')) && SUPPORTED.has(extension(viewerName?.textContent));

const style = document.createElement('style');
style.textContent = `
.image-optimize-dialog{width:min(980px,calc(100vw - 24px));height:min(880px,calc(100dvh - 24px));max-width:none;padding:0;border:0;border-radius:14px;background:#111;color:#eee;overflow:hidden;box-shadow:0 30px 100px rgba(0,0,0,.72)}
.image-optimize-dialog::backdrop{background:rgba(0,0,0,.82)}
.image-optimize-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto}
.image-optimize-head{height:52px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.08)}
.image-optimize-head strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.image-optimize-close{width:30px;height:30px;padding:0;border:0;border-radius:50%;background:transparent;color:#aaa;font-size:22px;font-weight:400}.image-optimize-close:hover{color:#fff;background:rgba(255,255,255,.06)}
.image-optimize-main{min-height:0;display:grid;grid-template-rows:minmax(260px,1fr) auto;overflow:auto}
.image-optimize-compare{--split:50%;position:relative;min-height:0;background:#080808;overflow:hidden;touch-action:none}
.image-optimize-compare img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none}
.image-optimize-after{clip-path:inset(0 0 0 var(--split))}
.image-optimize-divider{position:absolute;z-index:4;left:var(--split);top:0;bottom:0;width:1px;background:rgba(255,255,255,.9);pointer-events:none}
.image-optimize-divider:after{content:'↔';position:absolute;left:0;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:rgba(20,20,20,.82);border:1px solid rgba(255,255,255,.42);color:#fff;font-size:12px}
.image-optimize-label{position:absolute;z-index:5;top:12px;padding:4px 7px;border-radius:999px;background:rgba(12,12,12,.62);color:rgba(255,255,255,.75);font-size:10px;font-weight:650;pointer-events:none}.image-optimize-label.original{left:12px}.image-optimize-label.optimized{right:12px}
.image-optimize-loading{position:absolute;z-index:6;inset:0;display:grid;place-items:center;background:#080808;color:#938d8a;font-size:12px}.image-optimize-loading[hidden]{display:none}
.image-optimize-controls{display:grid;gap:12px;padding:14px 16px 16px;border-top:1px solid rgba(255,255,255,.07);background:#141314}
.image-optimize-result{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}.image-optimize-result strong{font-size:18px;letter-spacing:-.025em}.image-optimize-result span{font-size:11px;color:#928a88}.image-optimize-result .good{color:#a6c9af}.image-optimize-result .quiet{color:#817977}
.image-optimize-presets{display:flex;gap:5px}.image-optimize-presets button{padding:6px 10px;border-radius:7px;background:transparent;color:#918a87;font-size:11px}.image-optimize-presets button:hover{background:#242124;color:#ddd}.image-optimize-presets button.active{background:#2a2729;color:#f3edeb}
.image-optimize-advanced{font-size:11px;color:#8f8785}.image-optimize-advanced summary{width:max-content;cursor:pointer;list-style:none;color:#8f8785}.image-optimize-advanced summary::-webkit-details-marker{display:none}.image-optimize-advanced summary:after{content:' ▾'}.image-optimize-advanced[open] summary:after{content:' ▴'}
.image-optimize-advanced-grid{display:grid;grid-template-columns:minmax(180px,1fr) 150px auto;gap:10px;align-items:end;margin-top:10px}.image-optimize-advanced label{display:grid;gap:5px}.image-optimize-advanced input[type=range]{width:100%;accent-color:#dba19b}.image-optimize-advanced select{width:100%;background:#201e20;color:#ddd;border:0;border-radius:7px;padding:7px 8px}.image-optimize-lossless{display:flex!important;align-items:center;gap:6px!important;padding-bottom:7px;white-space:nowrap}.image-optimize-lossless input{width:auto}.image-optimize-update{justify-self:start;padding:7px 9px;border-radius:7px;background:#262326;color:#d9d1ce;font-size:11px}
.image-optimize-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);background:#111}.image-optimize-foot-status{min-width:0;flex:1;color:#817977;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.image-optimize-foot button{padding:8px 11px;border-radius:7px;font-size:11px}.image-optimize-keep{background:#242124;color:#ddd}.image-optimize-replace{background:#eee8e4;color:#171316}.image-optimize-foot button:disabled,.image-optimize-controls button:disabled,.image-optimize-controls input:disabled,.image-optimize-controls select:disabled{opacity:.35;cursor:default}
@media(max-width:700px){.image-optimize-dialog{width:100vw;height:100dvh;border-radius:0}.image-optimize-head{height:48px}.image-optimize-main{grid-template-rows:minmax(260px,58dvh) auto}.image-optimize-controls{padding:12px}.image-optimize-result strong{font-size:16px}.image-optimize-advanced-grid{grid-template-columns:1fr 110px}.image-optimize-lossless,.image-optimize-update{grid-column:1/-1}.image-optimize-foot{padding:10px 12px}.image-optimize-foot-status{display:none}.image-optimize-foot button{flex:1}.image-optimize-label{top:9px}.image-optimize-label.original{left:9px}.image-optimize-label.optimized{right:9px}}
`;
document.head.append(style);

const button = document.createElement('button');
button.type = 'button';
button.className = 'viewer-menu-action';
button.textContent = 'Optimize…';
button.hidden = true;
viewerMenu?.querySelector('#delete')?.before(button);

const dialog = document.createElement('dialog');
dialog.className = 'image-optimize-dialog';
dialog.innerHTML = `<div class="image-optimize-shell">
  <div class="image-optimize-head"><strong data-opt-name>Optimize image</strong><button class="image-optimize-close" type="button" aria-label="Close">×</button></div>
  <div class="image-optimize-main">
    <div class="image-optimize-compare" data-opt-compare>
      <img data-opt-original alt="Original" draggable="false">
      <img class="image-optimize-after" data-opt-after alt="Optimized" draggable="false">
      <span class="image-optimize-label original">Original</span><span class="image-optimize-label optimized">Optimized</span>
      <i class="image-optimize-divider"></i>
      <div class="image-optimize-loading" data-opt-loading>Preparing…</div>
    </div>
    <div class="image-optimize-controls">
      <div class="image-optimize-result" data-opt-result><strong>—</strong></div>
      <div class="image-optimize-presets" data-opt-presets><button type="button" data-opt-format="auto" class="active">Auto</button><button type="button" data-opt-format="webp">WebP</button><button type="button" data-opt-format="avif">AVIF</button></div>
      <details class="image-optimize-advanced">
        <summary>Advanced</summary>
        <div class="image-optimize-advanced-grid">
          <label>Quality <span><input data-opt-quality type="range" min="50" max="100" value="94"> <output data-opt-quality-label>94</output></span></label>
          <label>Effort <select data-opt-effort><option value="max">Max</option><option value="normal">Normal</option></select></label>
          <label class="image-optimize-lossless" data-opt-lossless-row hidden><input data-opt-lossless type="checkbox"> Lossless</label>
          <button class="image-optimize-update" data-opt-update type="button">Update preview</button>
        </div>
      </details>
    </div>
  </div>
  <div class="image-optimize-foot"><span class="image-optimize-foot-status" data-opt-status>No resize · metadata copied where supported</span><button class="image-optimize-keep" data-opt-keep type="button" disabled>Keep both</button><button class="image-optimize-replace" data-opt-replace type="button" disabled>Replace original</button></div>
</div>`;
document.body.append(dialog);

const compare = dialog.querySelector('[data-opt-compare]');
const original = dialog.querySelector('[data-opt-original]');
const optimized = dialog.querySelector('[data-opt-after]');
const loading = dialog.querySelector('[data-opt-loading]');
const result = dialog.querySelector('[data-opt-result]');
const status = dialog.querySelector('[data-opt-status]');
const quality = dialog.querySelector('[data-opt-quality]');
const qualityLabel = dialog.querySelector('[data-opt-quality-label]');
const effort = dialog.querySelector('[data-opt-effort]');
const lossless = dialog.querySelector('[data-opt-lossless]');
const losslessRow = dialog.querySelector('[data-opt-lossless-row]');
const keep = dialog.querySelector('[data-opt-keep]');
const replace = dialog.querySelector('[data-opt-replace]');
const presets = dialog.querySelector('[data-opt-presets]');
const updateButton = dialog.querySelector('[data-opt-update]');
let activeId = '';
let activeHash = '';
let session = null;
let pollTimer = 0;
let format = 'auto';
let split = 50;

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
  if (loading && !loading.hidden) return;
  compare.setPointerCapture?.(event.pointerId);
  pointerSplit(event);
});
compare.addEventListener('pointermove', event => {
  if (!compare.hasPointerCapture?.(event.pointerId)) return;
  pointerSplit(event);
});

function syncButton() {
  button.hidden = !currentImage() || !currentHash();
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
  if (regenerate && dialog.open) startPreview();
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
    if (!dialog.open || id !== activeId) return;
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
  if (!hash) return;
  clearTimeout(pollTimer);
  session = null;
  setBusy('Preparing…');
  original.removeAttribute('src');
  optimized.removeAttribute('src');
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
  if (!dialog.open || data.id !== activeId) return;
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
      dialog.close();
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
  if (!CLIENT || !hash) return;
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
  dialog.querySelector('[data-opt-name]').textContent = viewerName?.textContent || 'Optimize image';
  viewerMenu?.removeAttribute('open');
  if (!dialog.open) dialog.showModal();
  startPreview();
}

button.addEventListener('click', () => openOptimizer());
dialog.querySelector('.image-optimize-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', () => dialog.close());
dialog.addEventListener('close', () => {
  clearTimeout(pollTimer);
  activeId = '';
  activeHash = '';
  session = null;
  setControlsDisabled(false);
  original.removeAttribute('src');
  optimized.removeAttribute('src');
});
presets.addEventListener('click', event => {
  const item = event.target.closest('[data-opt-format]');
  if (item) setFormat(item.dataset.optFormat);
});
quality.addEventListener('input', () => {
  quality.dataset.userChanged = '1';
  qualityLabel.textContent = quality.value;
});
updateButton.addEventListener('click', startPreview);
keep.addEventListener('click', () => commit('keep'));
replace.addEventListener('click', () => commit('replace'));

if (viewerMedia) new MutationObserver(syncButton).observe(viewerMedia, { childList:true, subtree:true });
if (viewerName) new MutationObserver(syncButton).observe(viewerName, { childList:true, characterData:true, subtree:true });
if (viewer) new MutationObserver(syncButton).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
syncButton();

window.mochimonoImageOptimize = { open:openOptimizer };
