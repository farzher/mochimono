const compare = document.querySelector('.image-optimize-compare');
const leftImage = compare?.querySelector('[data-opt-original]');
const rightImage = compare?.querySelector('[data-opt-after]');
const leftControls = document.querySelector('[data-opt-left-controls]');
const rightControls = document.querySelector('[data-opt-controls]');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');

if (compare && leftImage && rightImage && leftControls && rightControls) {
  const DIRECT_BROWSER = new Set(['jpg','jpeg','png','webp','avif','bmp','gif']);
  const DEFAULT_EFFORT = 4;
  const extension = value => String(value || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  const active = () => document.querySelector('#viewer')?.classList.contains('image-optimize-active');

  const style = document.createElement('style');
  style.textContent = `
.viewer.image-optimize-active .viewer-optimize-trigger{display:none!important}
.image-optimize-divider:before{width:4px!important;background:rgba(0,0,0,.62)!important;box-shadow:0 0 0 1px rgba(255,255,255,.04)!important}
.image-optimize-divider-handle{width:42px!important;height:42px!important;border-radius:50%!important;gap:3px!important}
.image-optimize-original{display:none!important}
.image-optimize-controls .image-optimize-result{padding-right:30px}
.image-optimize-card-close{position:absolute;z-index:2;top:8px;right:8px;width:28px;height:28px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:transparent;color:#8f8885;font:400 22px/1 Arial,sans-serif;cursor:pointer;transition:background .12s ease,color .12s ease}
.image-optimize-card-close:hover{background:rgba(255,255,255,.08);color:#fff}
.image-optimize-card-close:focus-visible{outline:2px solid rgba(255,255,255,.55);outline-offset:1px}
.image-optimize-controls.is-original{padding-bottom:12px}
.image-optimize-controls.is-original [data-opt-size-button],.image-optimize-controls.is-original .image-optimize-tuning,.image-optimize-controls.is-original .image-optimize-actions{display:none!important}
.image-optimize-controls.is-original .image-optimize-quick{grid-template-columns:1fr!important}
.image-optimize-controls-left.is-original .image-optimize-saving{font-size:36px!important;letter-spacing:-.045em!important}
.image-optimize-controls-left.is-original .image-optimize-result-size{display:inline!important}
.image-optimize-effort-native{display:none!important}
.image-optimize-effort-control{justify-self:end;width:170px;display:grid;grid-template-columns:1fr auto;align-items:center;gap:9px}
.image-optimize-effort-control input{width:100%;margin:0;accent-color:#eee9e5}
.image-optimize-effort-control output{min-width:34px;color:#aaa29e;font-size:11px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
@media(max-width:760px){.image-optimize-divider-handle{width:38px!important;height:38px!important}.image-optimize-controls-left.is-original .image-optimize-saving{font-size:32px!important}.image-optimize-effort-control{width:140px}.image-optimize-card-close{top:6px;right:6px;width:26px;height:26px;font-size:20px}}
`;
  document.head.append(style);

  const leftSaving = leftControls.querySelector('[data-opt-saving]');
  const leftResultSize = leftControls.querySelector('[data-opt-result-size]');
  const leftStatus = leftControls.querySelector('[data-opt-status]');
  const rightOriginalInfo = rightControls.querySelector('[data-opt-original-info]');
  const rightFormats = rightControls.querySelector('[data-opt-formats]');
  const rightFormatButton = rightControls.querySelector('[data-opt-format-button]');
  const rightSizeButton = rightControls.querySelector('[data-opt-size-button]');
  const rightSaving = rightControls.querySelector('[data-opt-saving]');
  const rightResultSize = rightControls.querySelector('[data-opt-result-size]');
  const rightStatus = rightControls.querySelector('[data-opt-status]');
  const rightKeep = rightControls.querySelector('[data-opt-keep]');
  const rightReplace = rightControls.querySelector('[data-opt-replace]');
  const rightDrawer = rightControls.querySelector('[data-opt-drawer]');
  const rightPanes = [...rightControls.querySelectorAll('[data-opt-pane]')];
  const rightLabel = compare.querySelector('.image-optimize-label.optimized');

  if (rightFormats && !rightFormats.querySelector('[data-format="original"]')) {
    const choice = document.createElement('button');
    choice.className = 'image-optimize-choice';
    choice.type = 'button';
    choice.dataset.format = 'original';
    choice.textContent = 'Original';
    rightFormats.prepend(choice);
    rightFormats.classList.add('four');
  }

  function addCloseButton(control) {
    if (!control || control.querySelector('[data-opt-card-close]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-optimize-card-close';
    button.dataset.optCardClose = '';
    button.setAttribute('aria-label', 'Close compression');
    button.title = 'Close compression';
    button.textContent = '×';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      window.mochimonoImageOptimize?.close?.();
    });
    control.append(button);
  }

  addCloseButton(leftControls);
  addCloseButton(rightControls);

  const effortControls = new Map();
  let lastControl = rightControls;

  function effortMax(format) {
    return format === 'avif' ? 9 : 6;
  }

  function effortValue(control) {
    const value = Number(control?.dataset.optEffortValue);
    return Number.isFinite(value) ? value : DEFAULT_EFFORT;
  }

  function refreshEffort(control, format) {
    const setup = effortControls.get(control);
    if (!setup) return;
    if (format && format !== 'original') control.dataset.optEffortFormat = format;
    const codec = format && format !== 'original'
      ? format
      : control.dataset.optEffortFormat || 'avif';
    const max = effortMax(codec);
    const value = Math.max(0, Math.min(max, Math.round(effortValue(control))));
    control.dataset.optEffortValue = String(value);
    setup.input.max = String(max);
    setup.input.value = String(value);
    setup.output.textContent = `${value} / ${max}`;
    setup.input.title = `${codec === 'avif' ? 'AVIF' : codec === 'webp' ? 'WebP' : 'Auto'} effort ${value} of ${max}`;
  }

  function forceEffortPreview(control) {
    const setup = effortControls.get(control);
    if (!setup || control.classList.contains('is-original')) return;
    lastControl = control;
    const activeMode = setup.native.querySelector('[data-effort].active')?.dataset.effort === 'max' ? 'max' : 'normal';
    const triggerMode = activeMode === 'max' ? 'normal' : 'max';
    setup.native.querySelector(`[data-effort="${triggerMode}"]`)?.click();
  }

  function setupEffortSlider(control) {
    const row = control.querySelector('.image-optimize-segmented.effort');
    const native = row?.querySelector('[data-opt-efforts]');
    if (!row || !native || row.querySelector('.image-optimize-effort-control')) return;
    native.classList.add('image-optimize-effort-native');
    control.dataset.optEffortValue = String(DEFAULT_EFFORT);
    const slider = document.createElement('label');
    slider.className = 'image-optimize-effort-control';
    slider.innerHTML = '<input type="range" min="0" max="9" step="1" value="4" aria-label="Compression effort"><output>4 / 9</output>';
    row.append(slider);
    const input = slider.querySelector('input');
    const output = slider.querySelector('output');
    effortControls.set(control, { native, input, output });

    input.addEventListener('input', () => {
      lastControl = control;
      control.dataset.optEffortValue = input.value;
      refreshEffort(control);
    });
    input.addEventListener('change', () => forceEffortPreview(control));

    control.addEventListener('click', event => {
      lastControl = control;
      const format = event.target.closest('[data-format]')?.dataset.format;
      if (format && format !== 'original') refreshEffort(control, format);
    }, true);
    control.addEventListener('input', () => { lastControl = control; }, true);
    control.addEventListener('focusin', () => { lastControl = control; }, true);
    control.addEventListener('pointerdown', () => { lastControl = control; }, true);

    refreshEffort(control, control === rightControls ? 'avif' : 'avif');
  }

  setupEffortSlider(leftControls);
  setupEffortSlider(rightControls);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || input || '');
    if (!url.includes('/api/image-optimize/start') || !init?.body) return nativeFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      if (body?.options) {
        const stack = String(new Error().stack || '');
        const control = stack.includes('image-optimize-dual.js')
          ? leftControls
          : stack.includes('image-optimize.js')
            ? rightControls
            : lastControl;
        body.options.effort = effortValue(control);
        return nativeFetch(input, { ...init, body:JSON.stringify(body) });
      }
    } catch {}
    return nativeFetch(input, init);
  };

  let sourceUrl = '';
  let rightOriginalMode = false;
  let rightShadow = null;
  let syncing = false;

  function sourceSizeText() {
    const parts = String(rightOriginalInfo?.textContent || '').split('·').map(part => part.trim()).filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index--) {
      if (/^[\d.,]+\s*(?:B|KB|MB|GB|TB)$/i.test(parts[index])) return parts[index];
    }
    return '—';
  }

  function sourceResolutionText() {
    const parts = String(rightOriginalInfo?.textContent || '').split('·').map(part => part.trim()).filter(Boolean);
    for (const part of parts) {
      if (/^\d[\d,]*\s*[×x]\s*\d[\d,]*$/i.test(part)) return part.replace(/\s*[×x]\s*/i, '×');
    }
    return '';
  }

  function sourceStatusText() {
    const resolution = sourceResolutionText();
    return resolution ? `Uncompressed source · ${resolution}` : 'Uncompressed source';
  }

  function setText(node, text) {
    text = String(text ?? '');
    if (node && node.textContent !== text) node.textContent = text;
  }

  function rightFormatName(format) {
    if (format === 'original') return 'Original';
    if (format === 'avif') return 'AVIF';
    if (format === 'webp') return 'WebP';
    return 'Auto';
  }

  function syncRightFormatLabel(format = '') {
    if (rightOriginalMode) return setText(rightLabel, 'Original');
    const activeFormat = format || rightFormats?.querySelector('[data-format].active')?.dataset.format || 'avif';
    if (activeFormat === 'avif' || activeFormat === 'webp') return setText(rightLabel, rightFormatName(activeFormat));
    const actualCodec = String(rightStatus?.textContent || '').match(/^(AVIF|WebP)\b/)?.[1];
    setText(rightLabel, actualCodec || rightFormatName(activeFormat));
  }

  function syncLeftOriginal() {
    if (!leftControls.classList.contains('is-original')) return;
    setText(leftSaving, '0%');
    setText(leftResultSize, sourceSizeText());
    setText(leftStatus, sourceStatusText());
  }

  function closeRightDrawer() {
    if (rightDrawer) rightDrawer.hidden = true;
    for (const pane of rightPanes) pane.hidden = true;
    rightFormatButton?.classList.remove('open');
    rightSizeButton?.classList.remove('open');
  }

  function captureRight() {
    const activeFormat = rightFormats?.querySelector('[data-format].active')?.dataset.format || 'avif';
    return {
      imageSrc:rightImage.currentSrc || rightImage.src || '',
      saving:rightSaving?.textContent || '',
      resultSize:rightResultSize?.textContent || '',
      status:rightStatus?.textContent || '',
      label:rightFormatName(activeFormat),
      working:rightControls.classList.contains('working'),
      keepDisabled:Boolean(rightKeep?.disabled),
      replaceDisabled:Boolean(rightReplace?.disabled),
      activeFormat
    };
  }

  function syncRightOriginal() {
    if (!rightOriginalMode) return;
    syncing = true;
    rightControls.classList.add('is-original');
    rightControls.classList.remove('working');
    setText(rightFormatButton, 'Format · Original');
    setText(rightSaving, '0%');
    setText(rightResultSize, sourceSizeText());
    setText(rightStatus, sourceStatusText());
    setText(rightLabel, 'Original');
    if (rightKeep) rightKeep.disabled = true;
    if (rightReplace) rightReplace.disabled = true;
    for (const button of rightFormats?.querySelectorAll('[data-format]') || []) button.classList.toggle('active', button.dataset.format === 'original');
    closeRightDrawer();
    syncing = false;
  }

  function rightNeedsSync() {
    if (!rightOriginalMode) return false;
    if (!rightControls.classList.contains('is-original') || rightControls.classList.contains('working')) return true;
    if (rightSaving?.textContent !== '0%' || rightResultSize?.textContent !== sourceSizeText()) return true;
    if (rightStatus?.textContent !== sourceStatusText() || rightFormatButton?.textContent !== 'Format · Original') return true;
    if (rightKeep && !rightKeep.disabled) return true;
    if (rightReplace && !rightReplace.disabled) return true;
    return rightFormats?.querySelector('[data-format].active')?.dataset.format !== 'original';
  }

  function enterRightOriginal() {
    if (rightOriginalMode) return closeRightDrawer();
    rightShadow = captureRight();
    rightOriginalMode = true;
    if (sourceUrl) rightImage.src = sourceUrl;
    syncRightOriginal();
  }

  function leaveRightOriginal(button) {
    if (!rightOriginalMode) return;
    rightOriginalMode = false;
    rightControls.classList.remove('is-original');
    if (rightShadow) {
      if (rightShadow.imageSrc) rightImage.src = rightShadow.imageSrc;
      setText(rightSaving, rightShadow.saving);
      setText(rightResultSize, rightShadow.resultSize);
      setText(rightStatus, rightShadow.status);
      rightControls.classList.toggle('working', rightShadow.working);
      if (rightKeep) rightKeep.disabled = rightShadow.keepDisabled;
      if (rightReplace) rightReplace.disabled = rightShadow.replaceDisabled;
    }
    const next = button?.dataset.format || rightShadow?.activeFormat || 'avif';
    const label = rightFormatName(next);
    setText(rightFormatButton, `Format · ${label}`);
    setText(rightLabel, label);
    for (const choice of rightFormats?.querySelectorAll('[data-format]') || []) choice.classList.toggle('active', choice.dataset.format === next);
    rightShadow = null;
  }

  rightFormats?.addEventListener('click', event => {
    const button = event.target.closest('[data-format]');
    if (!button) return;
    if (button.dataset.format === 'original') {
      event.preventDefault();
      event.stopImmediatePropagation();
      enterRightOriginal();
      return;
    }
    if (rightOriginalMode) leaveRightOriginal(button);
    else syncRightFormatLabel(button.dataset.format);
  }, true);

  new MutationObserver(() => {
    if (leftControls.classList.contains('is-original')) syncLeftOriginal();
  }).observe(leftControls, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:['class'] });

  new MutationObserver(() => {
    syncLeftOriginal();
    if (rightOriginalMode) syncRightOriginal();
  }).observe(rightOriginalInfo, { childList:true, characterData:true, subtree:true });

  new MutationObserver(() => syncRightFormatLabel()).observe(rightStatus, { childList:true, characterData:true, subtree:true });
  new MutationObserver(() => syncRightFormatLabel()).observe(rightFormats, { attributes:true, subtree:true, attributeFilter:['class'] });

  new MutationObserver(() => {
    if (!rightOriginalMode || syncing || !rightNeedsSync()) return;
    const next = captureRight();
    if (rightShadow) {
      next.imageSrc = rightShadow.imageSrc;
      next.label = rightShadow.label;
      next.activeFormat = rightShadow.activeFormat;
    }
    rightShadow = next;
    syncRightOriginal();
  }).observe(rightControls, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:['class','disabled'] });

  new MutationObserver(() => {
    if (!rightOriginalMode || syncing || !sourceUrl) return;
    const current = rightImage.currentSrc || rightImage.src || '';
    if (current && current !== sourceUrl) {
      if (rightShadow) rightShadow.imageSrc = current;
      rightImage.src = sourceUrl;
    }
  }).observe(rightImage, { attributes:true, attributeFilter:['src'] });

  window.addEventListener('mochimono:optimize-open', () => {
    const sourceExt = extension(viewerName?.textContent);
    sourceUrl = DIRECT_BROWSER.has(sourceExt) && viewerOpen?.href
      ? viewerOpen.href
      : leftImage.currentSrc || leftImage.src || '';
    rightOriginalMode = false;
    rightShadow = null;
    rightControls.classList.remove('is-original');
    leftControls.dataset.optEffortValue = String(DEFAULT_EFFORT);
    rightControls.dataset.optEffortValue = String(DEFAULT_EFFORT);
    refreshEffort(leftControls, 'avif');
    refreshEffort(rightControls, 'avif');
    const avif = rightFormats?.querySelector('[data-format="avif"]');
    if (avif && !avif.classList.contains('active')) avif.click();
    syncRightFormatLabel('avif');
    setTimeout(syncLeftOriginal, 0);
  });

  window.addEventListener('mochimono:optimize-close', () => {
    rightOriginalMode = false;
    rightShadow = null;
    rightControls.classList.remove('is-original');
  });

  new MutationObserver(() => {
    if (!active() || !leftControls.classList.contains('is-original')) return;
    const current = leftImage.currentSrc || leftImage.src || '';
    if (current) sourceUrl = current;
  }).observe(leftImage, { attributes:true, attributeFilter:['src'] });

  syncLeftOriginal();
  syncRightFormatLabel();
}
