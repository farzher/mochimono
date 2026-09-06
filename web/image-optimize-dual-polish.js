const compare = document.querySelector('.image-optimize-compare');
const leftImage = compare?.querySelector('[data-opt-original]');
const rightImage = compare?.querySelector('[data-opt-after]');
const leftControls = document.querySelector('[data-opt-left-controls]');
const rightControls = document.querySelector('[data-opt-controls]');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');

if (compare && leftImage && rightImage && leftControls && rightControls) {
  const DIRECT_BROWSER = new Set(['jpg','jpeg','png','webp','avif','bmp','gif']);
  const extension = value => String(value || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  const active = () => document.querySelector('#viewer')?.classList.contains('image-optimize-active');

  const style = document.createElement('style');
  style.textContent = `
.image-optimize-divider:before{width:4px!important;background:rgba(0,0,0,.62)!important;box-shadow:0 0 0 1px rgba(255,255,255,.04)!important}
.image-optimize-divider-handle{width:42px!important;height:42px!important;border-radius:50%!important;gap:3px!important}
.image-optimize-controls.is-original{padding-bottom:12px}
.image-optimize-controls.is-original [data-opt-size-button],.image-optimize-controls.is-original .image-optimize-tuning,.image-optimize-controls.is-original .image-optimize-actions{display:none!important}
.image-optimize-controls.is-original .image-optimize-quick{grid-template-columns:1fr!important}
.image-optimize-controls-left.is-original .image-optimize-saving{font-size:36px!important;letter-spacing:-.045em!important}
.image-optimize-controls-left.is-original .image-optimize-result-size{display:inline!important}
@media(max-width:760px){.image-optimize-divider-handle{width:38px!important;height:38px!important}.image-optimize-controls-left.is-original .image-optimize-saving{font-size:32px!important}}
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

  function setText(node, text) {
    text = String(text ?? '');
    if (node && node.textContent !== text) node.textContent = text;
  }

  function syncLeftOriginal() {
    if (!leftControls.classList.contains('is-original')) return;
    setText(leftSaving, '0%');
    setText(leftResultSize, sourceSizeText());
    setText(leftStatus, 'Uncompressed source');
  }

  function closeRightDrawer() {
    if (rightDrawer) rightDrawer.hidden = true;
    for (const pane of rightPanes) pane.hidden = true;
    rightFormatButton?.classList.remove('open');
    rightSizeButton?.classList.remove('open');
  }

  function captureRight() {
    return {
      imageSrc:rightImage.currentSrc || rightImage.src || '',
      saving:rightSaving?.textContent || '',
      resultSize:rightResultSize?.textContent || '',
      status:rightStatus?.textContent || '',
      label:rightLabel?.textContent || 'Compressed',
      working:rightControls.classList.contains('working'),
      keepDisabled:Boolean(rightKeep?.disabled),
      replaceDisabled:Boolean(rightReplace?.disabled),
      activeFormat:rightFormats?.querySelector('[data-format].active')?.dataset.format || 'auto'
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
    setText(rightStatus, 'Uncompressed source');
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
    if (rightStatus?.textContent !== 'Uncompressed source' || rightFormatButton?.textContent !== 'Format · Original') return true;
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
      setText(rightLabel, rightShadow.label);
      rightControls.classList.toggle('working', rightShadow.working);
      if (rightKeep) rightKeep.disabled = rightShadow.keepDisabled;
      if (rightReplace) rightReplace.disabled = rightShadow.replaceDisabled;
    }
    const next = button?.dataset.format || rightShadow?.activeFormat || 'auto';
    const label = next === 'avif' ? 'AVIF' : next === 'webp' ? 'WebP' : 'Auto';
    setText(rightFormatButton, `Format · ${label}`);
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
  }, true);

  new MutationObserver(() => {
    if (leftControls.classList.contains('is-original')) syncLeftOriginal();
  }).observe(leftControls, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:['class'] });

  new MutationObserver(() => {
    syncLeftOriginal();
    if (rightOriginalMode) syncRightOriginal();
  }).observe(rightOriginalInfo, { childList:true, characterData:true, subtree:true });

  new MutationObserver(() => {
    if (!rightOriginalMode || syncing || !rightNeedsSync()) return;
    rightShadow = captureRight();
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
}
