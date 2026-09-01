const input = document.querySelector('#importPath');
const choose = document.querySelector('#chooseImport');
const browse = document.querySelector('#startBrowse');
const protect = document.querySelector('#startImport');
const addPanel = document.querySelector('#folderAdd');
const addToggle = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');

if (input && choose && browse && protect && addPanel) {
  let picked = [];

  const style = document.createElement('style');
  style.textContent = `
    .multi-folder-selection{display:grid;gap:5px;margin-top:8px}
    .multi-folder-selection[hidden]{display:none}
    .multi-folder-selection-head{display:flex;align-items:center;justify-content:space-between;padding:0 2px;color:#827a78;font-size:9px;font-weight:650}
    .multi-folder-selection-list{display:grid;gap:4px;max-height:176px;overflow:auto;padding-right:2px}
    .multi-folder-selected{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) 26px;align-items:center;gap:6px;padding:6px 6px 6px 9px;border:1px solid #2d2930;border-radius:8px;background:#0f0e10}
    .multi-folder-selected code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aaa29f;font:10px/1.35 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
    .multi-folder-selected button{width:26px;height:26px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:#776f6d;font-size:15px}
    .multi-folder-selected button:hover{background:#242126;color:#fff}
  `;
  document.head.append(style);

  const selected = document.createElement('div');
  selected.className = 'multi-folder-selection';
  selected.hidden = true;
  selected.innerHTML = '<div class="multi-folder-selection-head"><span data-multi-folder-count></span><button type="button" class="action-link" data-clear-multi-folders>Clear</button></div><div class="multi-folder-selection-list"></div>';
  addPanel.querySelector('.folder-path-row')?.after(selected);

  const clean = value => String(value || '').trim().replace(/[\\/]+$/, '');
  const key = value => clean(value).toLowerCase();
  const unique = paths => {
    const seen = new Set();
    return paths.map(clean).filter(path => path && !seen.has(key(path)) && seen.add(key(path)));
  };

  function pathsToAdd() {
    return unique([...picked, input.value.trim()]);
  }

  function render() {
    selected.hidden = picked.length < 2;
    if (picked.length < 2) {
      selected.querySelector('.multi-folder-selection-list').replaceChildren();
      selected.querySelector('[data-multi-folder-count]').textContent = '';
      return;
    }
    selected.querySelector('[data-multi-folder-count]').textContent = `${picked.length.toLocaleString()} folders selected`;
    const list = selected.querySelector('.multi-folder-selection-list');
    list.replaceChildren(...picked.map((path, index) => {
      const row = document.createElement('div');
      row.className = 'multi-folder-selected';
      row.innerHTML = '<code></code><button type="button" aria-label="Remove folder" title="Remove">×</button>';
      row.querySelector('code').textContent = path;
      row.querySelector('code').title = path;
      row.querySelector('button').dataset.removeMultiFolder = String(index);
      return row;
    }));
  }

  function setPicked(paths) {
    picked = unique(paths);
    if (picked.length === 1) {
      input.value = picked[0];
      picked = [];
    } else if (picked.length > 1) {
      input.value = '';
      input.placeholder = 'Add another folder path';
    }
    render();
  }

  function clearPicked() {
    picked = [];
    input.value = '';
    input.placeholder = 'Folder or drive';
    render();
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function toast(text) {
    const element = document.querySelector('#toast');
    if (!element) return;
    element.textContent = text;
    element.classList.add('show');
    clearTimeout(element.timer);
    element.timer = setTimeout(() => element.classList.remove('show'), 2800);
  }

  async function pickFolders(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    choose.disabled = true;
    try {
      const result = await request('/api/pick-folder?multiple=1');
      const paths = Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : [];
      if (paths.length) setPicked(paths);
    } catch (error) {
      toast(error.message);
    } finally {
      choose.disabled = false;
    }
  }

  async function addFolders(mode, event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    const paths = pathsToAdd();
    if (!paths.length) return toast('Choose one or more folders.');

    browse.disabled = true;
    protect.disabled = true;
    const failed = [];
    let added = 0;
    const endpoint = mode === 'browse' ? '/api/browse-folders' : '/api/folders';
    try {
      for (const path of paths) {
        try {
          await request(endpoint, { method: 'POST', body: JSON.stringify({ path }) });
          added++;
        } catch (error) {
          failed.push({ path, error: error.message });
        }
      }

      if (failed.length) {
        picked = failed.map(item => item.path);
        input.value = '';
        input.placeholder = picked.length === 1 ? picked[0] : 'Add another folder path';
        render();
        toast(`${added ? `${added} added · ` : ''}${failed.length} failed: ${failed[0].error}`);
      } else {
        clearPicked();
        addPanel.hidden = true;
        addToggle?.classList.remove('active');
        toast(`${added.toLocaleString()} folder${added === 1 ? '' : 's'} added`);
      }

      setTimeout(() => {
        frame?.contentWindow?.mochimonoLibrary?.refresh?.().catch?.(() => {});
        frame?.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {});
      }, 350);
    } finally {
      browse.disabled = false;
      protect.disabled = false;
    }
  }

  choose.onclick = null;
  choose.addEventListener('click', pickFolders, true);
  browse.addEventListener('click', event => addFolders('browse', event), true);
  protect.addEventListener('click', event => addFolders('protect', event), true);

  selected.addEventListener('click', event => {
    if (event.target.closest('[data-clear-multi-folders]')) return clearPicked();
    const remove = event.target.closest('[data-remove-multi-folder]');
    if (!remove) return;
    picked.splice(Number(remove.dataset.removeMultiFolder), 1);
    if (picked.length === 1) {
      input.value = picked[0];
      picked = [];
      input.placeholder = 'Folder or drive';
    }
    render();
  });
}
