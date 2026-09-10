const dialog = document.querySelector('.ai-lab-dialog');
const target = dialog?.querySelector('.ai-target');
const targetName = dialog?.querySelector('[data-ai-target-name]');
const targetHash = dialog?.querySelector('[data-ai-target-hash]');
const status = dialog?.querySelector('[data-ai-status]');
const main = dialog?.querySelector('.ai-lab-main');
const progressWrap = dialog?.querySelector('.ai-lab-progress');
const progressBar = progressWrap?.querySelector('i');

if (dialog && target && targetName && targetHash && main) {
  const MODEL = 'onnx-community/whisper-large-v3-turbo';
  const CACHE_KIND = 'whisper-large-v3-turbo-transcript-v1';
  const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
  const AUDIO = new Set(['mp3','wav','flac','m4a','aac','ogg','oga','opus','wma','aiff','aif','alac']);
  const VIDEO = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
  let pipelinePromise = null;
  let generation = 0;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ai-lab-button';
  button.dataset.aiTranscribe = '';
  button.textContent = 'Transcribe';
  button.title = 'Transcribe speech locally with Whisper Large v3 Turbo';
  target.append(button);

  const section = document.createElement('section');
  section.className = 'ai-lab-section';
  section.hidden = true;
  section.innerHTML = '<div class="ai-lab-section-head"><strong>Transcript</strong><span>Whisper Large v3 Turbo · local WebGPU</span></div><div class="ai-text-output" data-ai-transcript></div>';
  const descriptionSection = main.querySelector('[data-ai-description-section]');
  descriptionSection?.after(section) || main.append(section);
  const output = section.querySelector('[data-ai-transcript]');

  function extension(name) { return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || ''; }
  function supported() { const ext = extension(targetName.textContent); return AUDIO.has(ext) || VIDEO.has(ext); }
  function syncButton() { button.hidden = !supported() || !/^[a-f0-9]{64}$/.test(targetHash.textContent.trim()); }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('mochimono-ai', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('embeddings')) {
          const store = db.createObjectStore('embeddings', { keyPath:'id' });
          store.createIndex('model', 'model', { unique:false });
          store.createIndex('hash', 'hash', { unique:false });
        }
        if (!db.objectStoreNames.contains('metadata')) {
          const store = db.createObjectStore('metadata', { keyPath:'id' });
          store.createIndex('kind', 'kind', { unique:false });
          store.createIndex('hash', 'hash', { unique:false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function cached(hash) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('metadata', 'readonly').objectStore('metadata').get(`${CACHE_KIND}:${hash}`);
        request.onsuccess = () => resolve(request.result?.value || null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function save(hash, value) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('metadata', 'readwrite');
        tx.objectStore('metadata').put({ id:`${CACHE_KIND}:${hash}`, kind:CACHE_KIND, hash, value, updatedAt:Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Could not cache transcript'));
      });
    } finally { db.close(); }
  }

  function modelProgress(data) {
    const loaded = Number(data?.loaded) || 0;
    const total = Number(data?.total) || 0;
    if (progressWrap) progressWrap.hidden = false;
    if (progressBar) progressBar.style.width = total > 0 ? `${Math.max(2, Math.min(100, loaded / total * 100))}%` : '10%';
    if (status) status.textContent = total > 0 ? `Loading Whisper · ${Math.round(loaded / total * 100)}%` : `Loading Whisper · ${data?.status || 'preparing'}`;
  }

  async function transcriber() {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (async () => {
      const { pipeline } = await import(TRANSFORMERS_URL);
      const webgpu = Boolean(navigator.gpu);
      if (webgpu) {
        try {
          return await pipeline('automatic-speech-recognition', MODEL, { device:'webgpu', dtype:'q4f16', progress_callback:modelProgress });
        } catch (error) {
          if (status) status.textContent = 'Whisper WebGPU failed · trying compact WASM fallback';
        }
      }
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-small', { device:'wasm', dtype:'q8', progress_callback:modelProgress });
    })().catch(error => { pipelinePromise = null; throw error; });
    return pipelinePromise;
  }

  async function transcribe() {
    const hash = targetHash.textContent.trim();
    if (!/^[a-f0-9]{64}$/.test(hash) || !supported()) return;
    const mine = ++generation;
    section.hidden = false;
    output.textContent = 'Checking transcript cache…';
    button.disabled = true;
    try {
      const hit = await cached(hash);
      if (mine !== generation) return;
      if (hit?.text) {
        output.textContent = hit.text;
        if (status) status.textContent = 'Cached transcript';
        return;
      }
      output.textContent = 'Loading Whisper Large v3 Turbo…';
      if (progressWrap) progressWrap.hidden = false;
      const pipe = await transcriber();
      if (mine !== generation) return;
      if (status) status.textContent = 'Transcribing locally…';
      output.textContent = 'Transcribing speech…';
      if (progressBar) progressBar.style.width = '45%';
      const result = await pipe(`/api/objects/${hash}`, {
        chunk_length_s:30,
        stride_length_s:5,
        return_timestamps:true
      });
      if (mine !== generation) return;
      const text = String(result?.text || '').trim();
      if (!text) throw new Error('Whisper did not detect speech in this file.');
      const value = { text, chunks:Array.isArray(result?.chunks) ? result.chunks : [], model:MODEL };
      await save(hash, value);
      output.textContent = text;
      if (status) status.textContent = 'Transcript cached by content hash';
      window.dispatchEvent(new CustomEvent('mochimono:ai-transcript', { detail:{ hash, ...value } }));
    } catch (error) {
      if (mine === generation) {
        output.textContent = error?.message || 'Could not transcribe this file.';
        if (status) status.textContent = output.textContent;
      }
    } finally {
      if (mine === generation) {
        button.disabled = false;
        if (progressWrap) progressWrap.hidden = true;
        if (progressBar) progressBar.style.width = '0';
      }
    }
  }

  button.addEventListener('click', transcribe);
  dialog.addEventListener('close', () => { generation++; button.disabled = false; });
  new MutationObserver(syncButton).observe(targetName, { childList:true, characterData:true, subtree:true });
  new MutationObserver(syncButton).observe(targetHash, { childList:true, characterData:true, subtree:true });
  syncButton();

  window.mochimonoAITranscription = { transcribe, supported };
}
