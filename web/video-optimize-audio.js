const controls = document.querySelector('[data-controls]');
const quality = document.querySelector('[data-q]');
const status = document.querySelector('[data-status]');

if (controls && quality) {
  let mode = 'normal';
  let lastAudio = null;

  const section = document.createElement('div');
  section.className = 'video-optimize-section video-optimize-audio';
  section.innerHTML = `
    <div class="video-optimize-head"><span>Audio</span><output data-audio-label>Normal</output></div>
    <div class="video-optimize-choices video-optimize-audio-choices">
      <button class="video-optimize-choice" data-value="original">Original</button>
      <button class="video-optimize-choice" data-value="high">High</button>
      <button class="video-optimize-choice active" data-value="normal">Normal</button>
      <button class="video-optimize-choice" data-value="small">Small</button>
      <button class="video-optimize-choice" data-value="none">None</button>
    </div>
    <div class="video-optimize-note" data-audio-note>Opus · source-aware up to 128 kbps</div>`;

  const sample = controls.querySelector('[data-s]')?.closest('.video-optimize-section');
  if (sample) sample.before(section);
  else controls.querySelector('.video-optimize-actions')?.before(section);

  const label = section.querySelector('[data-audio-label]');
  const note = section.querySelector('[data-audio-note]');
  const choices = section.querySelector('.video-optimize-audio-choices');

  const style = document.createElement('style');
  style.textContent = `
.video-optimize-audio-choices{grid-template-columns:repeat(5,1fr)!important}
@media(max-width:760px){.video-optimize-audio-choices{grid-template-columns:repeat(3,1fr)!important}}
`;
  document.head.append(style);

  function noteFor(value) {
    if (value === 'original') {
      if (lastAudio?.codec) {
        const bitrate = lastAudio.kbps ? ` · ${Math.round(lastAudio.kbps)} kbps` : '';
        return `Copies ${String(lastAudio.codec).toUpperCase()} audio without re-encoding${bitrate} · final file uses MKV; preview uses Opus`;
      }
      return 'Copies the source audio without re-encoding · final file uses MKV; preview uses Opus';
    }
    if (value === 'high') return 'Opus · source-aware up to 160 kbps';
    if (value === 'small') return 'Opus · source-aware up to 48 kbps';
    if (value === 'none') return 'Removes the audio track';
    return 'Opus · source-aware up to 128 kbps';
  }

  function sync() {
    for (const button of choices.querySelectorAll('[data-value]')) {
      button.classList.toggle('active', button.dataset.value === mode);
    }
    label.textContent = mode === 'original' ? 'Original' : mode === 'high' ? 'High' : mode === 'small' ? 'Small' : mode === 'none' ? 'None' : 'Normal';
    note.textContent = noteFor(mode);
  }

  choices.addEventListener('click', event => {
    const button = event.target.closest('[data-value]');
    if (!button || button.dataset.value === mode) return;
    mode = button.dataset.value;
    sync();
    // Reuse the base compressor's existing preview restart path. The fetch hook
    // below adds the audio mode to the request without duplicating session logic.
    quality.onchange?.();
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    let nextInit = init;

    if (url.includes('/api/video-optimize/start') && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        body.options = { ...(body.options || {}), audio:mode };
        nextInit = { ...init, body:JSON.stringify(body) };
      } catch {}
    }

    const response = await nativeFetch(input, nextInit);
    if (url.includes('/api/video-optimize/') && response.ok) {
      response.clone().json().then(data => {
        if (data && (data.audioCodec || data.sourceAudioKbps)) {
          lastAudio = { codec:data.audioCodec || '', kbps:Number(data.sourceAudioKbps) || 0 };
          sync();
          if (mode === 'original' && status && data.audioCodec) {
            setTimeout(() => {
              status.textContent = status.textContent.replace(/Opus\s+\d+(?:\.\d+)?\s*kbps/i, `Original ${String(data.audioCodec).toUpperCase()} audio`);
            }, 0);
          }
        }
      }).catch(() => {});
    }
    return response;
  };

  window.addEventListener('mochimono:optimize-open', () => {
    mode = 'normal';
    lastAudio = null;
    sync();
  });

  sync();
}
