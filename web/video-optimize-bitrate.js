const controls = document.querySelector('[data-controls]');
const quality = document.querySelector('[data-q]');

if (controls && quality) {
  const MIN_KBPS = 10;
  const SLIDER_MAX = 1000;
  let mode = 'auto';
  let customKbps = 0;
  let sourceVideoKbps = 50000;
  let autoVideoKbps = 0;

  const section = document.createElement('div');
  section.className = 'video-optimize-section video-optimize-bitrate';
  section.innerHTML = `
    <div class="video-optimize-head"><span>Video bitrate</span><output data-vb-label>Auto</output></div>
    <div class="video-optimize-choices video-optimize-bitrate-choices">
      <button class="video-optimize-choice active" data-value="auto">Auto</button>
      <button class="video-optimize-choice" data-value="custom">Custom</button>
    </div>
    <input data-video-bitrate data-value="bitrate" type="range" min="0" max="${SLIDER_MAX}" step="1" value="0" disabled>`;

  const qualitySection = quality.closest('.video-optimize-section');
  if (qualitySection) qualitySection.after(section);
  else controls.querySelector('.video-optimize-actions')?.before(section);

  const label = section.querySelector('[data-vb-label]');
  const slider = section.querySelector('[data-video-bitrate]');
  const choices = section.querySelector('.video-optimize-bitrate-choices');

  const style = document.createElement('style');
  style.textContent = `
.video-optimize-bitrate-choices{grid-template-columns:repeat(2,1fr)!important}
.video-optimize-bitrate input[type=range]:disabled{opacity:.45}
`;
  document.head.append(style);

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const maxKbps = () => Math.max(MIN_KBPS, Math.round(Number(sourceVideoKbps) || 50000));

  function kbpsFromPosition(position) {
    const max = maxKbps();
    if (max <= MIN_KBPS) return MIN_KBPS;
    const t = clamp(Number(position) || 0, 0, SLIDER_MAX) / SLIDER_MAX;
    return Math.round(MIN_KBPS * Math.pow(max / MIN_KBPS, t));
  }

  function positionFromKbps(kbps) {
    const max = maxKbps();
    const value = clamp(Number(kbps) || MIN_KBPS, MIN_KBPS, max);
    if (max <= MIN_KBPS) return 0;
    return Math.round(Math.log(value / MIN_KBPS) / Math.log(max / MIN_KBPS) * SLIDER_MAX);
  }

  function bitrateText(kbps) {
    const value = Math.max(0, Math.round(Number(kbps) || 0));
    return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} Mbps` : `${value} kbps`;
  }

  function ensureCustomValue() {
    if (!customKbps) customKbps = clamp(autoVideoKbps || Math.min(1000, maxKbps()), MIN_KBPS, maxKbps());
    customKbps = clamp(customKbps, MIN_KBPS, maxKbps());
  }

  function sync() {
    for (const button of choices.querySelectorAll('[data-value]')) {
      button.classList.toggle('active', button.dataset.value === mode);
    }

    if (mode === 'custom') {
      ensureCustomValue();
      slider.disabled = false;
      slider.value = String(positionFromKbps(customKbps));
      label.textContent = bitrateText(customKbps);
      return;
    }

    slider.disabled = true;
    const shown = autoVideoKbps || 0;
    slider.value = String(positionFromKbps(shown || MIN_KBPS));
    label.textContent = shown ? `Auto · ${bitrateText(shown)}` : 'Auto';
  }

  function requestPreview() {
    // video-optimize.js already owns preview lifecycle. Reuse its Quality change
    // path rather than creating another session controller.
    quality.onchange?.();
  }

  choices.addEventListener('click', event => {
    const button = event.target.closest('[data-value]');
    if (!button || button.dataset.value === mode) return;
    mode = button.dataset.value === 'custom' ? 'custom' : 'auto';
    if (mode === 'custom') ensureCustomValue();
    sync();
    requestPreview();
  });

  slider.addEventListener('input', () => {
    if (mode !== 'custom') return;
    customKbps = kbpsFromPosition(slider.value);
    sync();
  });

  slider.addEventListener('change', () => {
    if (mode !== 'custom') return;
    customKbps = kbpsFromPosition(slider.value);
    sync();
    // The live-settings controller watches click events on [data-value]. Emit
    // one before starting the replacement encode so the displayed preview keeps
    // playing while this custom bitrate sample is generated.
    slider.dispatchEvent(new MouseEvent('click', { bubbles:true }));
    requestPreview();
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    let nextInit = init;

    if (url.includes('/api/video-optimize/start') && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        body.options = {
          ...(body.options || {}),
          videoBitrateKbps:mode === 'custom' ? Math.round(customKbps || MIN_KBPS) : 0
        };
        nextInit = { ...init, body:JSON.stringify(body) };
      } catch {}
    }

    const response = await nativeFetch(input, nextInit);
    if (url.includes('/api/video-optimize/') && response.ok) {
      response.clone().json().then(data => {
        const source = Number(data?.rate?.sourceVideoKbps) || 0;
        const automatic = Number(data?.rate?.autoVideoKbps) || 0;
        if (source >= MIN_KBPS) sourceVideoKbps = source;
        if (!Number(data?.options?.videoBitrateKbps) && automatic >= MIN_KBPS) autoVideoKbps = automatic;
        if (mode === 'custom') ensureCustomValue();
        sync();
      }).catch(() => {});
    }
    return response;
  };

  window.mochimonoVideoBitrate = {
    get:() => ({ mode, kbps:mode === 'custom' ? Math.round(customKbps || MIN_KBPS) : 0, autoKbps:Math.round(autoVideoKbps || 0) }),
    set(value, preview = true) {
      const kbps = Number(value) || 0;
      mode = kbps >= MIN_KBPS ? 'custom' : 'auto';
      if (mode === 'custom') customKbps = clamp(Math.round(kbps), MIN_KBPS, maxKbps());
      sync();
      if (preview) {
        slider.dispatchEvent(new MouseEvent('click', { bubbles:true }));
        requestPreview();
      }
    }
  };

  window.addEventListener('mochimono:optimize-open', () => {
    mode = 'auto';
    customKbps = 0;
    sourceVideoKbps = 50000;
    autoVideoKbps = 0;
    sync();
  });

  sync();
}
