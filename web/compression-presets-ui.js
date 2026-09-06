const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const imageControls = document.querySelector('[data-opt-controls]');
const videoControls = document.querySelector('[data-controls]');

if (viewer && viewerOpen && (imageControls || videoControls)) {
  const style = document.createElement('style');
  style.textContent = `
.image-optimize-actions,.video-optimize-actions{display:none!important}
.compression-savebar{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:5px;margin-top:7px}
.compression-savebar select{min-width:0;height:34px;border:0;border-radius:8px;background:#2a2829;color:#d7d0cc;padding:0 8px;font:700 10.5px/1 inherit}
.compression-savebar button{height:34px;padding:0 9px;border:0;border-radius:8px;background:#2a2829;color:#c9c2be;font-size:10.5px;font-weight:750;white-space:nowrap}
.compression-savebar button:hover{background:#343132;color:#fff}.compression-savebar .compression-save-compact{background:#eee9e5;color:#171416}.compression-savebar .compression-save-compact:hover{background:#fff}.compression-savebar button:disabled{opacity:.4}
@media(max-width:760px){.compression-savebar{grid-template-columns:minmax(0,1fr) auto auto}.compression-savebar .compression-preset-default{display:none}.compression-savebar button{padding:0 7px;font-size:10px}}
`;
  document.head.append(style);

  let presets = [];
  let applying = false;

  const hash = () => viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const activeType = () => viewer.classList.contains('image-optimize-active') ? 'image' : viewer.classList.contains('video-optimize-active') ? 'video' : '';

  async function api(path, options = {}) {
    const response = await fetch(path, { headers:{ 'content-type':'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  async function loadPresets() {
    presets = (await api('/api/compression/presets')).presets || [];
    syncBars();
    return presets;
  }

  function barFor(controls, type) {
    if (!controls || controls.querySelector(':scope > .compression-savebar')) return controls?.querySelector(':scope > .compression-savebar') || null;
    const bar = document.createElement('div');
    bar.className = 'compression-savebar';
    bar.dataset.mediaType = type;
    bar.innerHTML = `
      <select data-compression-preset aria-label="Squish preset"></select>
      <button type="button" data-compression-save-preset title="Save current Squish settings as a preset">Save preset</button>
      <button type="button" class="compression-preset-default" data-compression-default title="Make selected preset the default">★</button>
      <button type="button" class="compression-save-compact" data-compression-save>Save squished</button>`;
    controls.append(bar);
    bar.querySelector('[data-compression-preset]').addEventListener('change', () => {
      const preset = presets.find(item => item.id === bar.querySelector('[data-compression-preset]').value);
      if (preset) applyPreset(type, preset.options);
    });
    bar.querySelector('[data-compression-save-preset]').addEventListener('click', () => savePreset(type, bar).catch(error => alert(error.message)));
    bar.querySelector('[data-compression-default]').addEventListener('click', () => makeDefault(type, bar).catch(error => alert(error.message)));
    bar.querySelector('[data-compression-save]').addEventListener('click', event => queueCurrent(type, bar, event.currentTarget).catch(error => alert(error.message)));
    controls.addEventListener('input', () => { if (!applying) markCustom(bar); }, true);
    controls.addEventListener('click', event => {
      if (applying || event.target.closest('.compression-savebar')) return;
      if (event.target.closest('[data-value],[data-format],[data-size-kind],[data-content],[data-effort]')) markCustom(bar);
    }, true);
    return bar;
  }

  const imageBar = barFor(imageControls, 'image');
  const videoBar = barFor(videoControls, 'video');

  function markCustom(bar) {
    const select = bar?.querySelector('[data-compression-preset]');
    if (select && select.value) select.value = '';
  }

  function syncBar(bar, type) {
    if (!bar) return;
    const select = bar.querySelector('[data-compression-preset]');
    const current = select.value;
    const items = presets.filter(item => item.mediaType === type);
    select.innerHTML = `<option value="">Custom</option>${items.map(item => `<option value="${item.id}">${item.isDefault ? '★ ' : ''}${item.name.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}</option>`).join('')}`;
    select.value = items.some(item => item.id === current) ? current : '';
  }

  function syncBars() {
    syncBar(imageBar, 'image');
    syncBar(videoBar, 'video');
  }

  function captureImage() {
    const format = imageControls?.querySelector('[data-opt-formats] [data-format].active')?.dataset.format || 'auto';
    if (format === 'original') throw new Error('Choose a Squish image format first');
    const sizeText = String(imageControls?.querySelector('[data-opt-size-button]')?.textContent || '').replace(/^Size\s*·\s*/i, '').trim();
    let resizeMax = 2560;
    let resizePercent = 0;
    if (/^\d+%$/.test(sizeText)) { resizePercent = Number(sizeText.replace('%','')) || 0; resizeMax = 0; }
    else if (/^\d+\s*px$/i.test(sizeText)) resizeMax = Number(sizeText.match(/\d+/)?.[0]) || 2560;
    else if (/^Auto$/i.test(sizeText)) resizeMax = 2560;
    return {
      format,
      quality:Number(imageControls.querySelector('[data-opt-quality]')?.value) || (format === 'avif' ? 69 : 90),
      content:imageControls.querySelector('[data-opt-content] [data-content].active')?.dataset.content || 'auto',
      effort:Number(imageControls.querySelector('.image-optimize-effort-control input')?.value) || 4,
      lossless:Boolean(imageControls.querySelector('[data-opt-lossless]')?.checked),
      resizeMax,
      resizePercent
    };
  }

  function captureVideo() {
    return {
      encoder:videoControls.querySelector('[data-enc] [data-value].active')?.dataset.value || 'auto',
      quality:Number(videoControls.querySelector('[data-q]')?.value) || 72,
      effort:Number(videoControls.querySelector('[data-e]')?.value) || 7,
      maxEdge:Number(videoControls.querySelector('[data-res] [data-value].active')?.dataset.value) || 0,
      fps:Number(videoControls.querySelector('[data-fps] [data-value].active')?.dataset.value) || 0,
      audio:videoControls.querySelector('.video-optimize-audio-choices [data-value].active')?.dataset.value || 'normal',
      videoBitrateKbps:Number(window.mochimonoVideoBitrate?.get?.().kbps) || 0
    };
  }

  const capture = type => type === 'image' ? captureImage() : captureVideo();

  function setRange(element, value) {
    if (!element || value == null) return;
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles:true }));
  }

  function clickChoice(root, selector) {
    const button = root?.querySelector(selector);
    if (button && !button.classList.contains('active')) button.click();
  }

  function applyImage(options = {}) {
    clickChoice(imageControls, `[data-opt-formats] [data-format="${CSS.escape(String(options.format || 'auto'))}"]`);
    if (options.resizePercent) clickChoice(imageControls, `[data-opt-sizes] [data-size-kind="percent"][data-size-value="${Number(options.resizePercent)}"]`);
    else if (options.resizeMax) {
      const direct = imageControls.querySelector(`[data-opt-sizes] [data-size-kind="max"][data-size-value="${Number(options.resizeMax)}"]`);
      if (direct) direct.click();
      else {
        const slider = imageControls.querySelector('[data-opt-max-size]');
        const values = [720,1080,1440,1920,2560,3072,3840,5120,8192];
        const index = values.indexOf(Number(options.resizeMax));
        if (index >= 0) setRange(slider, index);
      }
    }
    clickChoice(imageControls, `[data-opt-content] [data-content="${CSS.escape(String(options.content || 'auto'))}"]`);
    setRange(imageControls.querySelector('[data-opt-quality]'), Number(options.quality) || 90);
    setRange(imageControls.querySelector('.image-optimize-effort-control input'), Number(options.effort) || 4);
    const lossless = imageControls.querySelector('[data-opt-lossless]');
    if (lossless && lossless.checked !== Boolean(options.lossless)) {
      lossless.checked = Boolean(options.lossless);
      lossless.dispatchEvent(new Event('change', { bubbles:true }));
    }
  }

  function applyVideo(options = {}) {
    clickChoice(videoControls, `[data-enc] [data-value="${CSS.escape(String(options.encoder || 'auto'))}"]`);
    clickChoice(videoControls, `[data-res] [data-value="${Number(options.maxEdge) || 0}"]`);
    clickChoice(videoControls, `[data-fps] [data-value="${Number(options.fps) || 0}"]`);
    clickChoice(videoControls, `.video-optimize-audio-choices [data-value="${CSS.escape(String(options.audio || 'normal'))}"]`);
    window.mochimonoVideoBitrate?.set?.(Number(options.videoBitrateKbps) || 0, false);
    setRange(videoControls.querySelector('[data-e]'), Number(options.effort) || 7);
    setRange(videoControls.querySelector('[data-q]'), Number(options.quality) || 72);
    videoControls.querySelector('[data-q]')?.dispatchEvent(new Event('change', { bubbles:true }));
  }

  function applyPreset(type, options) {
    applying = true;
    try { type === 'image' ? applyImage(options) : applyVideo(options); }
    finally { setTimeout(() => { applying = false; }, 0); }
  }

  async function savePreset(type, bar) {
    const name = prompt('Preset name');
    if (!name?.trim()) return;
    const makeDefault = confirm('Use this as the default preset?');
    const data = await api('/api/compression/presets', {
      method:'POST',
      body:JSON.stringify({ name:name.trim(), mediaType:type, options:capture(type), makeDefault })
    });
    await loadPresets();
    bar.querySelector('[data-compression-preset]').value = data.preset.id;
  }

  async function makeDefault(type, bar) {
    const id = bar.querySelector('[data-compression-preset]').value;
    if (!id) throw new Error('Choose a saved preset first');
    await api(`/api/compression/presets/${encodeURIComponent(id)}/default`, { method:'POST', body:'{}' });
    await loadPresets();
    bar.querySelector('[data-compression-preset]').value = id;
  }

  async function queueCurrent(type, bar, button) {
    const originalHash = hash();
    if (!originalHash) throw new Error('No file is open');
    const selected = presets.find(item => item.id === bar.querySelector('[data-compression-preset]').value);
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = 'Adding…';
    try {
      await api('/api/work/enqueue', {
        method:'POST',
        body:JSON.stringify({ hashes:[originalHash], mediaType:type, options:capture(type), presetId:selected?.id || '', presetName:selected?.name || 'Custom' })
      });
      button.textContent = 'Queued';
      window.dispatchEvent(new CustomEvent('mochimono:work-changed', { detail:{ originalHash } }));
      setTimeout(() => { button.disabled = false; refreshSaveLabel(type, bar).catch(() => { button.textContent = previous; }); }, 1200);
    } catch (error) {
      button.disabled = false;
      button.textContent = previous;
      throw error;
    }
  }

  async function refreshSaveLabel(type, bar) {
    if (!bar || activeType() !== type) return;
    const originalHash = hash();
    const button = bar.querySelector('[data-compression-save]');
    if (!originalHash || !button) return;
    const data = await api(`/api/renditions/${encodeURIComponent(originalHash)}`).catch(() => ({ rendition:null }));
    button.textContent = data.rendition ? 'Update squished' : 'Save squished';
  }

  async function activateDefaults() {
    await loadPresets();
    const type = activeType();
    const bar = type === 'image' ? imageBar : type === 'video' ? videoBar : null;
    if (!bar) return;
    const preset = presets.find(item => item.mediaType === type && item.isDefault);
    if (preset) {
      bar.querySelector('[data-compression-preset]').value = preset.id;
      applyPreset(type, preset.options);
    }
    refreshSaveLabel(type, bar).catch(() => {});
  }

  window.addEventListener('mochimono:optimize-open', () => setTimeout(() => activateDefaults().catch(() => {}), 0));
  window.addEventListener('mochimono:work-changed', () => {
    const type = activeType();
    refreshSaveLabel(type, type === 'image' ? imageBar : videoBar).catch(() => {});
  });
  loadPresets().catch(() => {});
}