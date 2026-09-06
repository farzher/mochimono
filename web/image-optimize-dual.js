const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');
const compare = document.querySelector('.image-optimize-compare');
const leftImage = compare?.querySelector('[data-opt-original]');
const rightControls = document.querySelector('.image-optimize-controls');

if (viewer && compare && leftImage && rightControls && !document.querySelector('[data-opt-left-controls]')) {
  const DIRECT_BROWSER = new Set(['jpg','jpeg','png','webp','avif','bmp','gif']);
  const AUTO_MAX_EDGE = 2560;
  const WEBP_DEFAULT_QUALITY = 90;
  const AVIF_DEFAULT_QUALITY = 69;
  const MAX_SIZE_STEPS = [720,1080,1440,1920,2560,3072,3840,5120,8192];
  const extension = value => String(value || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  const currentHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const active = () => viewer.classList.contains('image-optimize-active');

  const style = document.createElement('style');
  style.textContent = `
.image-optimize-controls{width:min(350px,calc(50% - 24px))!important}
.image-optimize-controls-left{left:max(14px,env(safe-area-inset-left));right:auto!important}
.image-optimize-controls-left .image-optimize-drawer{left:0;right:auto}
.image-optimize-controls-left .image-optimize-saving{color:#ff74b7}
.image-optimize-controls-left.is-original{padding-bottom:12px}
.image-optimize-controls-left.is-original .image-optimize-saving{font-size:25px;letter-spacing:-.025em}
.image-optimize-controls-left.is-original .image-optimize-result-size,.image-optimize-controls-left.is-original [data-opt-size-button],.image-optimize-controls-left.is-original .image-optimize-tuning,.image-optimize-controls-left.is-original .image-optimize-actions{display:none!important}
.image-optimize-controls-left.is-original .image-optimize-quick{grid-template-columns:1fr}
.image-optimize-choice-grid.four{grid-template-columns:repeat(4,1fr)}
.image-optimize-label.original{color:#ff74b7}.image-optimize-label.optimized{color:#72b6ff}
.image-optimize-divider{width:48px}
.image-optimize-divider:before{width:3px;background:rgba(8,8,10,.82);box-shadow:-1px 0 0 rgba(255,79,163,.34),1px 0 0 rgba(78,161,255,.34)}
.image-optimize-divider:after{display:none!important}
.image-optimize-divider-handle{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;gap:4px;width:50px;height:36px;border-radius:18px;background:rgba(8,8,10,.78);border:1px solid rgba(255,255,255,.18);box-shadow:0 4px 18px rgba(0,0,0,.4);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:background .12s ease,border-color .12s ease}
.image-optimize-divider:hover .image-optimize-divider-handle{background:rgba(8,8,10,.9);border-color:rgba(255,255,255,.3)}
.image-optimize-divider-left,.image-optimize-divider-right{width:0;height:0;border-top:8px solid transparent;border-bottom:8px solid transparent;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.image-optimize-divider-left{border-right:12px solid #ff4fa3}.image-optimize-divider-right{border-left:12px solid #4ea1ff}
@media(max-width:760px){.image-optimize-controls{width:calc(50% - 12px)!important;padding:10px}.image-optimize-controls-left{left:max(8px,env(safe-area-inset-left))}.image-optimize-controls-left .image-optimize-saving{font-size:28px}.image-optimize-choice-grid.four{grid-template-columns:repeat(2,1fr)}.image-optimize-divider-handle{width:44px;height:32px}.image-optimize-divider-left,.image-optimize-divider-right{border-top-width:7px;border-bottom-width:7px}.image-optimize-divider-left{border-right-width:10px}.image-optimize-divider-right{border-left-width:10px}}
`;
  document.head.append(style);

  const divider = compare.querySelector('.image-optimize-divider');
  if (divider && !divider.querySelector('.image-optimize-divider-handle')) {
    divider.insertAdjacentHTML('beforeend', '<span class="image-optimize-divider-handle" aria-hidden="true"><span class="image-optimize-divider-left"></span><span class="image-optimize-divider-right"></span></span>');
  }

  const leftControls = rightControls.cloneNode(true);
  leftControls.classList.add('image-optimize-controls-left', 'is-original');
  leftControls.dataset.optLeftControls = '';
  leftControls.removeAttribute('data-opt-controls');
  rightControls.after(leftControls);

  const formats = leftControls.querySelector('[data-opt-formats]');
  const originalChoice = document.createElement('button');
  originalChoice.className = 'image-optimize-choice active';
  originalChoice.type = 'button';
  originalChoice.dataset.format = 'original';
  originalChoice.textContent = 'Original';
  formats.prepend(originalChoice);
  formats.classList.add('four');

  const drawer = leftControls.querySelector('[data-opt-drawer]');
  const panes = [...leftControls.querySelectorAll('[data-opt-pane]')];
  const sizes = leftControls.querySelector('[data-opt-sizes]');
  const contentChoices = leftControls.querySelector('[data-opt-content]');
  const efforts = leftControls.querySelector('[data-opt-efforts]');
  const formatButton = leftControls.querySelector('[data-opt-format-button]');
  const sizeButton = leftControls.querySelector('[data-opt-size-button]');
  const saving = leftControls.querySelector('[data-opt-saving]');
  const resultSize = leftControls.querySelector('[data-opt-result-size]');
  const originalInfo = leftControls.querySelector('[data-opt-original-info]');
  const rightOriginalInfo = rightControls.querySelector('[data-opt-original-info]');
  const status = leftControls.querySelector('[data-opt-status]');
  const zoomLabel = leftControls.querySelector('[data-opt-zoom]');
  const maxSize = leftControls.querySelector('[data-opt-max-size]');
  const maxSizeLabel = leftControls.querySelector('[data-opt-max-size-label]');
  const quality = leftControls.querySelector('[data-opt-quality]');
  const qualityLabel = leftControls.querySelector('[data-opt-quality-label]');
  const lossless = leftControls.querySelector('[data-opt-lossless]');
  const losslessRow = leftControls.querySelector('[data-opt-lossless-row]');
  const keep = leftControls.querySelector('[data-opt-keep]');
  const replace = leftControls.querySelector('[data-opt-replace]');
  const leftLabel = compare.querySelector('.image-optimize-label.original');

  let format = 'original';
  let contentMode = 'auto';
  let effort = 'normal';
  let sizeMode = { kind:'auto', value:AUTO_MAX_EDGE };
  let sourceUrl = '';
  let activeId = '';
  let session = null;
  let pollTimer = 0;
  let previewDebounce = 0;
  let requestSerial = 0;
  let renderSerial = 0;
  let displayedCandidate = '';
  let renderingCandidate = '';
  let desiredCandidateSrc = '';
  let openPane = '';
  let committing = false;

  const bytes = number => {
    const units = ['B','KB','MB','GB','TB'];
    let value = Math.max(0, Number(number) || 0);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  };
  const defaultQuality = () => format === 'avif' ? AVIF_DEFAULT_QUALITY : WEBP_DEFAULT_QUALITY;

  function formatLabel() {
    if (format === 'original') return 'Original';
    if (format === 'avif') return 'AVIF';
    if (format === 'webp') return 'WebP';
    return 'Auto';
  }

  function sizeLabel() {
    if (sizeMode.kind === 'percent') return `${sizeMode.value}%`;
    if (sizeMode.kind === 'max') return `${sizeMode.value} px`;
    return 'Auto';
  }

  function resolution(width, height) {
    width = Number(width) || 0;
    height = Number(height) || 0;
    return width && height ? `${width.toLocaleString()}×${height.toLocaleString()}` : '';
  }

  function progressLabel(data) {
    if (data.status === 'queued') return 'Waiting for encoder…';
    const label = String(data.progress?.label || '').trim();
    if (!label) return data.status === 'encoding' ? 'Encoding…' : '';
    return label === 'Reading image' ? 'Reading image…' : `${label.replace(/^Encoding\s+/,'')}…`;
  }

  function compressedDetails(data, selected) {
    if (!selected) return '';
    const codec = selected.format === 'avif' ? 'AVIF' : 'WebP';
    const mode = selected.lossless ? 'Lossless' : `Quality ${selected.quality}`;
    const dimensions = resolution(selected.width || data.targetWidth, selected.height || data.targetHeight);
    return [codec, mode, dimensions].filter(Boolean).join(' · ');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { headers:{ 'content-type':'application/json' }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
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

  function setWorking(value) {
    leftControls.classList.toggle('working', Boolean(value));
  }

  function syncOriginalSummary() {
    if (format !== 'original') return;
    saving.textContent = 'Original';
    resultSize.textContent = '';
    originalInfo.textContent = rightOriginalInfo?.textContent || 'Original';
    status.textContent = 'Original source';
    keep.disabled = true;
    replace.disabled = true;
    leftLabel.textContent = 'Original';
    setWorking(false);
  }

  function syncControls() {
    const isOriginal = format === 'original';
    leftControls.classList.toggle('is-original', isOriginal);
    formatButton.textContent = `Format · ${formatLabel()}`;
    sizeButton.textContent = `Size · ${sizeLabel()}`;
    if (sizeMode.kind !== 'percent') {
      const index = MAX_SIZE_STEPS.indexOf(sizeMode.value);
      if (index >= 0) maxSize.value = String(index);
    }
    maxSizeLabel.textContent = `${MAX_SIZE_STEPS[Number(maxSize.value)]} px`;
    for (const button of formats.querySelectorAll('[data-format]')) button.classList.toggle('active', button.dataset.format === format);
    for (const button of sizes.querySelectorAll('[data-size-kind]')) {
      const kind = button.dataset.sizeKind;
      const value = Number(button.dataset.sizeValue);
      button.classList.toggle('active', kind === sizeMode.kind && value === sizeMode.value);
    }
    for (const button of contentChoices.querySelectorAll('[data-content]')) button.classList.toggle('active', button.dataset.content === contentMode);
    for (const button of efforts.querySelectorAll('[data-effort]')) button.classList.toggle('active', button.dataset.effort === effort);
    losslessRow.hidden = format !== 'webp';
    qualityLabel.textContent = quality.value;
    if (isOriginal) syncOriginalSummary();
  }

  function closeDrawer() {
    openPane = '';
    drawer.hidden = true;
    for (const pane of panes) pane.hidden = true;
    for (const button of [formatButton, sizeButton]) button.classList.remove('open');
  }

  function togglePane(name, button) {
    if (openPane === name) return closeDrawer();
    openPane = name;
    drawer.hidden = false;
    for (const pane of panes) pane.hidden = pane.dataset.optPane !== name;
    for (const item of [formatButton, sizeButton]) item.classList.toggle('open', item === button);
  }

  function options() {
    return {
      format,
      quality:Number(quality.value) || defaultQuality(),
      content:contentMode,
      effort,
      lossless:format === 'webp' && lossless.checked,
      resizeMax:sizeMode.kind === 'auto' || sizeMode.kind === 'max' ? sizeMode.value : 0,
      resizePercent:sizeMode.kind === 'percent' ? sizeMode.value : 0
    };
  }

  function setOriginalImage() {
    requestSerial++;
    renderSerial++;
    desiredCandidateSrc = '';
    displayedCandidate = 'original';
    renderingCandidate = '';
    leftImage.dataset.compareVariant = 'original';
    if (sourceUrl) leftImage.src = sourceUrl;
  }

  function updateResult(data) {
    const selected = data.selected;
    const working = data.status === 'encoding' || data.status === 'queued' || data.status === 'starting';
    setWorking(working);
    originalInfo.textContent = ['Source', resolution(data.width, data.height), bytes(data.sourceSize)].filter(Boolean).join(' · ');
    if (!selected) {
      if (!displayedCandidate || displayedCandidate === 'original') {
        saving.textContent = '—';
        resultSize.textContent = 'Preparing…';
      }
      status.textContent = progressLabel(data) || 'Preparing preview…';
      return;
    }
    saving.textContent = `${Math.max(0, Number(selected.percent) || 0).toFixed(0)}%`;
    resultSize.textContent = bytes(selected.size);
    leftLabel.textContent = selected.format === 'avif' ? 'AVIF' : 'WebP';
    const details = compressedDetails(data, selected);
    const work = working ? progressLabel(data) : '';
    status.textContent = `${details}${work ? ` · ${work}` : ''}`;
  }

  async function renderCandidate(data) {
    const selected = data.selected;
    if (!selected) return;
    const key = `${data.id}:${selected.id}`;
    if (displayedCandidate === key || renderingCandidate === key) return;
    const serial = ++renderSerial;
    renderingCandidate = key;
    try {
      const src = await preload(selected.url);
      if (!active() || format === 'original' || data.id !== activeId || serial !== renderSerial) return;
      desiredCandidateSrc = src;
      leftImage.dataset.compareVariant = 'compressed';
      leftImage.src = src;
      displayedCandidate = key;
    } catch {
      // Keep the previous comparison visible; polling can still recover.
    } finally {
      if (renderingCandidate === key) renderingCandidate = '';
    }
  }

  function setSaveState(data) {
    const ready = format !== 'original' && !committing && data?.status === 'ready' && Boolean(data.selected);
    keep.disabled = !ready;
    replace.disabled = !ready;
  }

  function showError(message) {
    setWorking(false);
    status.textContent = message || 'Could not squish this image';
    keep.disabled = true;
    replace.disabled = true;
  }

  function consume(data, serial) {
    if (!active() || format === 'original' || serial !== requestSerial || data.id !== activeId) return;
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
      if (!active() || format === 'original' || serial !== requestSerial || id !== activeId) return;
      try {
        const data = await api(`/api/image-optimize/status?id=${encodeURIComponent(id)}`);
        consume(data, serial);
      } catch (error) {
        if (serial === requestSerial && format !== 'original') showError(error.message);
      }
    }, 240);
  }

  async function startPreview() {
    const hash = currentHash();
    if (!hash || !active() || committing || format === 'original') return;
    clearTimeout(previewDebounce);
    previewDebounce = 0;
    const serial = ++requestSerial;
    clearTimeout(pollTimer);
    session = null;
    keep.disabled = true;
    replace.disabled = true;
    setWorking(true);
    status.textContent = 'Starting preview…';
    try {
      const data = await api('/api/image-optimize/start', {
        method:'POST',
        body:JSON.stringify({ hash, options:options() })
      });
      if (!active() || format === 'original' || serial !== requestSerial) return;
      activeId = data.id;
      consume(data, serial);
    } catch (error) {
      if (serial === requestSerial && format !== 'original') showError(error.message);
    }
  }

  function schedulePreview(delay = 180) {
    clearTimeout(previewDebounce);
    if (!active() || committing || format === 'original') return;
    setWorking(true);
    status.textContent = 'Updating preview…';
    previewDebounce = setTimeout(() => {
      previewDebounce = 0;
      startPreview();
    }, delay);
  }

  function setFormat(next) {
    if (!['original','auto','webp','avif'].includes(next) || next === format) return closeDrawer();
    format = next;
    clearTimeout(pollTimer);
    clearTimeout(previewDebounce);
    requestSerial++;
    session = null;
    activeId = '';
    keep.disabled = true;
    replace.disabled = true;
    if (quality.dataset.userChanged !== '1') quality.value = String(defaultQuality());
    if (format !== 'webp') lossless.checked = false;
    syncControls();
    closeDrawer();
    if (format === 'original') setOriginalImage();
    else startPreview();
  }

  function setSize(kind, value) {
    if (!['auto','percent','max'].includes(kind) || format === 'original') return;
    value = Number(value) || 0;
    if (!value || (kind === sizeMode.kind && value === sizeMode.value)) return closeDrawer();
    sizeMode = { kind, value };
    syncControls();
    closeDrawer();
    startPreview();
  }

  function setContent(next) {
    if (!['auto','photo','graphics'].includes(next) || next === contentMode || format === 'original') return;
    contentMode = next;
    syncControls();
    startPreview();
  }

  function setEffort(next) {
    if (!['normal','max'].includes(next) || next === effort || format === 'original') return closeDrawer();
    effort = next;
    syncControls();
    closeDrawer();
    startPreview();
  }

  async function commit(mode) {
    if (committing || format === 'original' || !session?.selected || session.status !== 'ready') return;
    if (mode === 'replace' && !confirm(`Replace ${session.filename} with the squished ${session.selected.format.toUpperCase()}?\n\nMochimono will verify the preview you approved, then replace the original.`)) return;
    committing = true;
    keep.disabled = true;
    replace.disabled = true;
    setWorking(true);
    status.textContent = 'Verifying and saving…';
    try {
      const data = await api('/api/image-optimize/commit', {
        method:'POST',
        body:JSON.stringify({ id:session.id, candidate:session.selected.id, mode })
      });
      const saved = Number(data.result?.saved) || 0;
      setWorking(false);
      status.textContent = `${data.result?.filename || 'Saved'}${saved > 0 ? ` · saved ${bytes(saved)}` : ''}`;
      setTimeout(() => {
        window.mochimonoImageOptimize?.close?.();
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

  function reset() {
    clearTimeout(pollTimer);
    clearTimeout(previewDebounce);
    requestSerial++;
    renderSerial++;
    format = 'original';
    contentMode = 'auto';
    effort = 'normal';
    sizeMode = { kind:'auto', value:AUTO_MAX_EDGE };
    activeId = '';
    session = null;
    displayedCandidate = 'original';
    renderingCandidate = '';
    desiredCandidateSrc = '';
    committing = false;
    quality.dataset.userChanged = '';
    quality.value = String(WEBP_DEFAULT_QUALITY);
    lossless.checked = false;
    closeDrawer();
    syncControls();
  }

  formatButton.addEventListener('click', () => togglePane('format', formatButton));
  sizeButton.addEventListener('click', () => togglePane('size', sizeButton));
  formats.addEventListener('click', event => {
    const button = event.target.closest('[data-format]');
    if (button) setFormat(button.dataset.format);
  });
  sizes.addEventListener('click', event => {
    const button = event.target.closest('[data-size-kind]');
    if (button) setSize(button.dataset.sizeKind, button.dataset.sizeValue);
  });
  contentChoices.addEventListener('click', event => {
    const button = event.target.closest('[data-content]');
    if (button) setContent(button.dataset.content);
  });
  efforts.addEventListener('click', event => {
    const button = event.target.closest('[data-effort]');
    if (button) setEffort(button.dataset.effort);
  });
  maxSize.addEventListener('input', () => {
    sizeMode = { kind:'max', value:MAX_SIZE_STEPS[Number(maxSize.value)] };
    syncControls();
    schedulePreview();
  });
  quality.addEventListener('input', () => {
    quality.dataset.userChanged = '1';
    qualityLabel.textContent = quality.value;
    schedulePreview();
  });
  lossless.addEventListener('change', () => schedulePreview(0));
  keep.addEventListener('click', () => commit('keep'));
  replace.addEventListener('click', () => commit('replace'));
  leftControls.addEventListener('pointerdown', event => event.stopPropagation());

  if (rightOriginalInfo) new MutationObserver(syncOriginalSummary).observe(rightOriginalInfo, { childList:true, characterData:true, subtree:true });

  new MutationObserver(() => {
    if (!active()) return;
    if (format === 'original') {
      if (leftImage.src) sourceUrl = leftImage.src;
      return;
    }
    if (!desiredCandidateSrc || leftImage.dataset.compareVariant !== 'compressed') return;
    if (leftImage.src !== desiredCandidateSrc) leftImage.src = desiredCandidateSrc;
  }).observe(leftImage, { attributes:true, attributeFilter:['src'] });

  window.addEventListener('mochimono:optimize-zoom', event => {
    const scale = Math.max(.1, Number(event.detail?.scale) || 1);
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  });

  window.addEventListener('mochimono:optimize-open', () => {
    const sourceExt = extension(viewerName?.textContent);
    sourceUrl = DIRECT_BROWSER.has(sourceExt) && viewerOpen?.href
      ? viewerOpen.href
      : leftImage.currentSrc || leftImage.src || '';
    reset();
    leftImage.dataset.compareVariant = 'original';
    if (sourceUrl) leftImage.src = sourceUrl;
    setTimeout(() => {
      if (format === 'original' && DIRECT_BROWSER.has(sourceExt) && viewerOpen?.href) {
        sourceUrl = viewerOpen.href;
        leftImage.src = sourceUrl;
      }
      syncOriginalSummary();
    }, 0);
  });

  window.addEventListener('mochimono:optimize-close', () => {
    clearTimeout(pollTimer);
    clearTimeout(previewDebounce);
    requestSerial++;
    renderSerial++;
    activeId = '';
    session = null;
    desiredCandidateSrc = '';
    delete leftImage.dataset.compareVariant;
    closeDrawer();
    setWorking(false);
  });

  document.addEventListener('keydown', event => {
    if (!active() || event.key !== 'Escape' || !openPane) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeDrawer();
  }, true);

  reset();
}
