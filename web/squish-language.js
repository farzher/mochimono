const viewer = document.querySelector('#viewer');
const files = document.querySelector('#files');

const nativeAlert = window.alert.bind(window);
const nativeConfirm = window.confirm.bind(window);

function squishText(value) {
  return String(value ?? '')
    .replace(/\bUncompressed source\b/g, 'Original source')
    .replace(/\bUncompressed\b/g, 'Original')
    .replace(/\buncompressed\b/g, 'original')
    .replace(/\bCompressing\b/g, 'Squishing')
    .replace(/\bcompressing\b/g, 'squishing')
    .replace(/\bOptimizing\b/g, 'Squishing')
    .replace(/\boptimizing\b/g, 'squishing')
    .replace(/\bCompressed\b/g, 'Squished')
    .replace(/\bcompressed\b/g, 'squished')
    .replace(/\bCompression\b/g, 'Squish')
    .replace(/\bcompression\b/g, 'squish')
    .replace(/\bOptimized\b/g, 'Squished')
    .replace(/\boptimized\b/g, 'squished')
    .replace(/\bOptimize\b/g, 'Squish')
    .replace(/\boptimize\b/g, 'squish')
    .replace(/\bCompact\b/g, 'Squished')
    .replace(/\bcompact\b/g, 'squished')
    .replace(/\bCompress\b/g, 'Squish')
    .replace(/\bcompress\b/g, 'squish');
}

// Some server/worker errors still use the stable internal vocabulary. Translate
// only when those messages are surfaced to a person; API values remain unchanged.
window.alert = value => nativeAlert(squishText(value));
window.confirm = value => nativeConfirm(squishText(value));

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function translateElement(element, text = true) {
  if (!element) return;
  if (text && element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE) {
    const next = squishText(element.textContent);
    if (next !== element.textContent) element.textContent = next;
  }
  for (const name of ['title', 'aria-label', 'alt']) {
    if (!element.hasAttribute?.(name)) continue;
    const current = element.getAttribute(name);
    const next = squishText(current);
    if (next !== current) element.setAttribute(name, next);
  }
}

function syncViewer() {
  for (const trigger of document.querySelectorAll('.viewer-optimize-trigger')) {
    if (/^(Compress|Optimize)$/i.test(trigger.textContent.trim())) setText(trigger, 'Squish');
    translateElement(trigger, false);
  }

  const imageAfter = document.querySelector('[data-opt-after]');
  if (imageAfter?.alt !== 'Squished') imageAfter?.setAttribute('alt', 'Squished');
  const imageLabel = document.querySelector('.image-optimize-label.optimized');
  if (imageLabel && /^(Compressed|Optimized)$/i.test(imageLabel.textContent.trim())) setText(imageLabel, 'Squished');

  const videoLabel = document.querySelector('.video-optimize-label.optimized');
  if (videoLabel && /^(Compressed|Optimized)$/i.test(videoLabel.textContent.trim())) setText(videoLabel, 'Squished');

  for (const close of document.querySelectorAll('.video-optimize-close')) translateElement(close, false);
  for (const status of document.querySelectorAll('[data-opt-status],[data-status],[data-source-status]')) {
    const next = squishText(status.textContent);
    if (next !== status.textContent) status.textContent = next;
  }

  const renditionButton = document.querySelector('.viewer-renditions [data-rendition="compact"]');
  setText(renditionButton, 'Squished');
  for (const action of document.querySelectorAll('#viewer-menu .viewer-menu-action')) {
    if (/^Remove (compact|squished)$/i.test(action.textContent.trim())) setText(action, 'Remove squished');
  }

  const viewerMeta = document.querySelector('#viewer-meta');
  if (viewerMeta?.textContent.includes(' · Compact')) {
    const next = viewerMeta.textContent.replace(/ · Compact(?= ·|$)/g, ' · Squished');
    if (next !== viewerMeta.textContent) viewerMeta.textContent = next;
  }

  for (const bar of document.querySelectorAll('.compression-savebar')) {
    const preset = bar.querySelector('[data-compression-preset]');
    if (preset?.getAttribute('aria-label') !== 'Squish preset') preset?.setAttribute('aria-label', 'Squish preset');
    const save = bar.querySelector('[data-compression-save]');
    if (save) {
      const next = save.textContent.replace(/^Save compact$/i, 'Save squished').replace(/^Update compact$/i, 'Update squished');
      if (next !== save.textContent) save.textContent = next;
    }
    for (const button of bar.querySelectorAll('button')) translateElement(button, true);
  }
}

function syncWork() {
  const selection = document.querySelector('.selection-compress');
  if (selection) {
    setText(selection, 'Squish');
    if (selection.title !== 'Squish selected files') selection.title = 'Squish selected files';
  }

  const overlay = document.querySelector('.compression-overlay');
  if (!overlay) return;
  const heading = overlay.querySelector('.compression-dialog-head strong');
  if (heading?.textContent.startsWith('Compress ')) setText(heading, heading.textContent.replace(/^Compress /, 'Squish '));
  const summary = overlay.querySelector('.compression-work-summary');
  if (summary) {
    const next = squishText(summary.textContent);
    if (next !== summary.textContent) summary.textContent = next;
  }
  for (const button of overlay.querySelectorAll('button')) translateElement(button, true);
  for (const meta of overlay.querySelectorAll('.compression-work-meta')) {
    const next = squishText(meta.textContent);
    if (next !== meta.textContent) meta.textContent = next;
  }
}

function syncStorage() {
  const button = document.querySelector('.compression-storage-button');
  if (button?.title !== 'Choose Original or Squished by location') button?.setAttribute('title', 'Choose Original or Squished by location');

  const overlay = document.querySelector('.compression-storage-overlay');
  if (!overlay) return;
  for (const option of overlay.querySelectorAll('option')) {
    if (option.value === 'compact') setText(option, 'Squished');
    if (option.value === 'compact-only') setText(option, 'Squished only');
  }
  const state = overlay.querySelector('.compression-storage-state');
  if (state) {
    const html = '<strong>Originals are retained by default.</strong> Squished adds a managed Squished version without deleting the Original. Managed backups can explicitly use Squished only; even then an Original is removed only after the Squished version is verified and another Original is verified elsewhere.';
    if (state.innerHTML !== html) state.innerHTML = html;
  }
}

function syncBadges() {
  for (const badge of files?.querySelectorAll('.compact-rendition-badge') || []) {
    setText(badge, 'S');
    if (badge.title !== 'Squished version available') badge.title = 'Squished version available';
  }
}

const observed = new WeakSet();
function attachObservers() {
  for (const root of [viewer, document.querySelector('.compression-overlay'), document.querySelector('.compression-storage-overlay')].filter(Boolean)) {
    if (observed.has(root)) continue;
    observed.add(root);
    new MutationObserver(soon).observe(root, { childList:true, subtree:true,characterData:true });
  }
}

function sync() {
  syncViewer();
  syncWork();
  syncStorage();
  syncBadges();
  attachObservers();
}

let scheduled = false;
function soon() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    sync();
  });
}

for (const name of ['mochimono:optimize-open','mochimono:work-changed','mochimono:catalog-updated','mochimono:grid-model','mochimono:compression-policy-changed']) {
  window.addEventListener(name, soon);
}
document.addEventListener('click', soon, true);
document.addEventListener('change', soon, true);
document.addEventListener('input', soon, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });

sync();
