import ai from './ai-engine.js';

const dialog = document.querySelector('.ai-lab-dialog');
const toolbar = dialog?.querySelector('.ai-lab-toolbar');
const status = dialog?.querySelector('[data-ai-status]');

if (dialog && toolbar && !toolbar.querySelector('[data-ai-scope]')) {
  let scope = 'view';
  const originals = {
    index:ai.index.bind(ai),
    similar:ai.similar.bind(ai),
    search:ai.search.bind(ai),
    groups:ai.groups.bind(ai)
  };

  const style = document.createElement('style');
  style.textContent = `
.ai-lab-scope{height:31px;padding:0 8px;border:1px solid #373238;border-radius:8px;background:#171518;color:#bbb2af;font-size:9.5px;font-weight:700;outline:none}
.ai-lab-scope:focus{border-color:#6d6268}.ai-lab-clear{color:#9e9296}
`;
  document.head.append(style);

  const select = document.createElement('select');
  select.className = 'ai-lab-scope';
  select.dataset.aiScope = '';
  select.title = 'Choose which files AI should index and search';
  select.innerHTML = '<option value="view">Current view</option><option value="all">Entire library</option>';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'ai-lab-button ai-lab-clear';
  clear.textContent = 'Clear AI index';
  clear.title = 'Delete cached Mochimono embeddings and AI descriptions from this browser';

  const firstIndexButton = toolbar.querySelector('[data-ai-index]');
  firstIndexButton?.before(select);
  toolbar.append(clear);

  select.addEventListener('change', () => {
    scope = select.value === 'all' ? 'all' : 'view';
    if (status) status.textContent = scope === 'all'
      ? 'AI scope · entire library'
      : 'AI scope · current view';
  });

  const scoped = options => ({ ...(options || {}), scope });
  ai.index = (model = 'siglip2', options = {}) => originals.index(model, scoped(options));
  ai.similar = (hash, model = 'siglip2', options = {}) => originals.similar(hash, model, scoped(options));
  ai.search = (query, options = {}) => originals.search(query, scoped(options));
  ai.groups = (options = {}) => originals.groups(scoped(options));

  clear.addEventListener('click', async () => {
    if (!confirm('Clear Mochimono AI index and cached AI descriptions?\n\nDownloaded model files may remain in the browser cache. Your original files are not changed.')) return;
    clear.disabled = true;
    const old = clear.textContent;
    clear.textContent = 'Clearing…';
    try {
      const state = await ai.clear();
      if (status) status.textContent = `AI index cleared · ${state.webgpu ? 'WebGPU available' : 'WASM fallback'}`;
      clear.textContent = 'Cleared';
      setTimeout(() => { clear.textContent = old; }, 1200);
    } catch (error) {
      if (status) status.textContent = error.message || 'Could not clear AI index';
      clear.textContent = old;
    } finally {
      clear.disabled = false;
    }
  });

  window.mochimonoAIScope = {
    get:() => scope,
    set:value => {
      select.value = value === 'all' ? 'all' : 'view';
      select.dispatchEvent(new Event('change'));
    }
  };
}
