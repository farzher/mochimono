const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const imageControls = document.querySelector('[data-opt-controls]');
const videoControls = document.querySelector('[data-controls]');

if (viewer && viewerOpen) {
  const hash = () => viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const type = () => viewer.classList.contains('image-optimize-active') ? 'image' : viewer.classList.contains('video-optimize-active') ? 'video' : '';

  async function readJson(path) {
    const response = await fetch(path, { cache:'no-store' });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  async function rendition(originalHash) {
    const local = await readJson(`/api/renditions/${encodeURIComponent(originalHash)}`);
    if (local?.rendition) return local.rendition;
    return (await readJson(`/api/representations/${encodeURIComponent(originalHash)}/rendition`))?.rendition || null;
  }

  function click(root, selector) {
    const button = root?.querySelector(selector);
    if (button && !button.classList.contains('active')) button.click();
  }

  function range(element, value, change = false) {
    if (!element || value == null) return;
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles:true }));
    if (change) element.dispatchEvent(new Event('change', { bubbles:true }));
  }

  function applyImage(options = {}) {
    if (!imageControls) return;
    click(imageControls, `[data-opt-formats] [data-format="${CSS.escape(String(options.format || 'auto'))}"]`);
    if (options.resizePercent) click(imageControls, `[data-opt-sizes] [data-size-kind="percent"][data-size-value="${Number(options.resizePercent)}"]`);
    else if (options.resizeMax) {
      const direct = imageControls.querySelector(`[data-opt-sizes] [data-size-kind="max"][data-size-value="${Number(options.resizeMax)}"]`);
      if (direct) direct.click();
      else {
        const values = [720,1080,1440,1920,2560,3072,3840,5120,8192];
        const index = values.indexOf(Number(options.resizeMax));
        if (index >= 0) range(imageControls.querySelector('[data-opt-max-size]'), index);
      }
    }
    click(imageControls, `[data-opt-content] [data-content="${CSS.escape(String(options.content || 'auto'))}"]`);
    range(imageControls.querySelector('[data-opt-quality]'), Number(options.quality) || 90);
    range(imageControls.querySelector('.image-optimize-effort-control input'), Number(options.effort) || 4, true);
    const lossless = imageControls.querySelector('[data-opt-lossless]');
    if (lossless && lossless.checked !== Boolean(options.lossless)) {
      lossless.checked = Boolean(options.lossless);
      lossless.dispatchEvent(new Event('change', { bubbles:true }));
    }
  }

  function applyVideo(options = {}) {
    if (!videoControls) return;
    click(videoControls, `[data-enc] [data-value="${CSS.escape(String(options.encoder || 'auto'))}"]`);
    click(videoControls, `[data-res] [data-value="${Number(options.maxEdge) || 0}"]`);
    click(videoControls, `[data-fps] [data-value="${Number(options.fps) || 0}"]`);
    click(videoControls, `.video-optimize-audio-choices [data-value="${CSS.escape(String(options.audio || 'normal'))}"]`);
    window.mochimonoVideoBitrate?.set?.(Number(options.videoBitrateKbps) || 0, false);
    range(videoControls.querySelector('[data-e]'), Number(options.effort) || 7);
    range(videoControls.querySelector('[data-q]'), Number(options.quality) || 72, true);
  }

  async function restore() {
    const mediaType = type();
    const originalHash = hash();
    if (!mediaType || !originalHash) return;
    const existing = await rendition(originalHash).catch(() => null);
    if (!existing || existing.mediaType !== mediaType || type() !== mediaType || hash() !== originalHash) return;
    mediaType === 'image' ? applyImage(existing.options || {}) : applyVideo(existing.options || {});
    const controls = mediaType === 'image' ? imageControls : videoControls;
    const select = controls?.querySelector('.compression-savebar [data-compression-preset]');
    const save = controls?.querySelector('.compression-savebar [data-compression-save]');
    if (select && existing.presetName) {
      const match = [...select.options].find(option => option.textContent.replace(/^★\s*/, '') === existing.presetName);
      if (match) select.value = match.value;
    }
    if (save) save.textContent = 'Update compact';
  }

  window.addEventListener('mochimono:optimize-open', () => setTimeout(() => restore().catch(() => {}), 80));
  window.addEventListener('mochimono:work-changed', () => {
    const mediaType = type();
    const controls = mediaType === 'image' ? imageControls : videoControls;
    const save = controls?.querySelector('.compression-savebar [data-compression-save]');
    if (!mediaType || !save) return;
    rendition(hash()).then(existing => { save.textContent = existing ? 'Update compact' : 'Save compact'; }).catch(() => {});
  });
}
