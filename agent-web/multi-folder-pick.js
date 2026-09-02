const input = document.querySelector('#importPath');
const choose = document.querySelector('#chooseImport');
const browse = document.querySelector('#startBrowse');
const protect = document.querySelector('#startImport');
const addPanel = document.querySelector('#folderAdd');
const addToggle = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');

if (input && choose && browse && protect && addPanel) {
  let picked = [];
  let browserSelection = new Set();
  let browserPath = '';
  let browserData = null;

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
    .multi-folder-browser{width:min(700px,calc(100vw - 24px));max-width:700px;padding:0;overflow:hidden}
    .multi-folder-browser .dialog-head{padding:14px 16px 10px}
    .folder-browser-path{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:0 16px 10px}
    .folder-browser-path input{min-width:0;font:11px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
    .folder-browser-tools{display:flex;align-items:center;gap:6px;padding:0 16px 9px}
    .folder-browser-current{margin-left:auto;display:flex;align-items:center;gap:6px;color:#aaa29f;font-size:10px;cursor:pointer}
    .folder-browser-list{height:min(52vh,430px);min-height:220px;overflow:auto;border-top:1px solid #272329;border-bottom:1px solid #272329;background:#0d0c0e}
    .folder-browser-row{display:grid;grid-template-columns:34px minmax(0,1fr);align-items:center;border-bottom:1px solid #1d1a1e}
    .folder-browser-row:last-child{border-bottom:0}
    .folder-browser-row:hover{background:#151316}
    .folder-browser-row label{height:38px;display:grid;place-items:center;cursor:pointer}
    .folder-browser-row input{margin:0}
    .folder-browser-open{height:38px;min-width:0;padding:0 10px 0 0;border:0;background:transparent;color:#c9c1bd;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .folder-browser-open::before{content:'▸';display:inline-block;width:18px;color:#746d6a}
    .folder-browser-empty{padding:24px 16px;color:#77706e;text-align:center;font-size:10px}
    .folder-browser-footer{display:flex;align-items:center;gap:8px;padding:10px 16px 14px}
    .folder-browser-count{color:#8f8784;font-size:10px}
    .folder-browser-footer .spacer{flex:1}
  `;
  document.head.append(style);

  const selected = document.createElement('div');
  selected.className = 'multi-folder-selection';
  selected.hidden = true;
  selected.innerHTML = '<div class="multi-folder-selection-head"><span data-multi-folder-count></span><button type="button" class="action-link" data-clear-multi-folders>Clear</button></div><div class="multi-folder-selection-list"></div>';
  addPanel.querySelector('.folder-path-row')?.after(selected);

  const browser = document.createElement('dialog');
  browser.className = 'small-dialog multi-folder-browser';
  browser.innerHTML = `
    <div class="dialog-head"><h3>Choose folders</h3><button type="button" class="icon" data-browser-close>×</button></div>
    <div class="folder-browser-path"><input data-browser-path aria-label="Folder path"><button type="button" class="secondary" data-browser-go>Go</button></div>
    <div class="folder-browser-tools"><button type="button" class="action-link" data-browser-up>↑ Up</button><label class="folder-browser-current"><input type="checkbox" data-browser-current> Select this folder</label></div>
    <div class="folder-browser-list" data-browser-list><div class="folder-browser-empty">Loading…</div></div>
    <div class="folder-browser-footer"><span class="folder-browser-count" data-browser-count></span><span class="spacer"></span><button type="button" class="secondary" data-browser-cancel>Cancel</button><button type="button" class="primary" data-browser-confirm>Choose selected</button></div>`;
  document.body.append(browser);

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
      input.placeholder = 'Folder or drive';
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

  const browserPathInput = browser.querySelector('[data-browser-path]');
  const browserList = browser.querySelector('[data-browser-list]');
  const browserCurrent = browser.querySelector('[data-browser-current]');
  const browserCount = browser.querySelector('[data-browser-count]');
  const browserUp = browser.querySelector('[data-browser-up]');

  function selectedKeySet() {
    return new Set([...browserSelection].map(key));
  }

  function updateBrowserCount() {
    const count = browserSelection.size;
    browserCount.textContent = count ? `${count.toLocaleString()} selected` : 'Select one or more folders';
    browser.querySelector('[data-browser-confirm]').disabled = !count;
  }

  function toggleBrowserPath(path, checked) {
    const wanted = key(path);
    for (const existing of [...browserSelection]) if (key(existing) === wanted) browserSelection.delete(existing);
    if (checked) browserSelection.add(clean(path));
    updateBrowserCount();
  }

  function renderBrowser() {
    if (!browserData) return;
    browserPath = browserData.path;
    browserPathInput.value = browserPath;
    browserUp.disabled = !browserData.parent;
    browserUp.dataset.path = browserData.parent || '';
    const selectedKeys = selectedKeySet();
    browserCurrent.checked = selectedKeys.has(key(browserPath));

    if (!(browserData.directories || []).length) {
      browserList.innerHTML = '<div class="folder-browser-empty">No folders here.</div>';
      updateBrowserCount();
      return;
    }

    browserList.replaceChildren(...browserData.directories.map(directory => {
      const row = document.createElement('div');
      row.className = 'folder-browser-row';
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedKeys.has(key(directory.path));
      checkbox.dataset.selectPath = directory.path;
      label.append(checkbox);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'folder-browser-open';
      open.dataset.openPath = directory.path;
      open.textContent = directory.name;
      open.title = directory.path;
      row.append(label, open);
      return row;
    }));
    updateBrowserCount();
  }

  async function loadBrowser(path = '') {
    browserList.innerHTML = '<div class="folder-browser-empty">Loading…</div>';
    try {
      browserData = await request(`/api/client/folder-browser${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      renderBrowser();
    } catch (error) {
      browserList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'folder-browser-empty error';
      empty.textContent = error.message;
      browserList.append(empty);
    }
  }

  async function openBrowser(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    browserSelection = new Set(pathsToAdd());
    browserData = null;
    updateBrowserCount();
    browser.showModal();
    await loadBrowser(browserPath || input.value.trim());
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
        setPicked(failed.map(item => item.path));
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
  choose.addEventListener('click', openBrowser, true);
  browse.addEventListener('click', event => addFolders('browse', event), true);
  protect.addEventListener('click', event => addFolders('protect', event), true);

  browser.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-select-path]');
    if (checkbox) toggleBrowserPath(checkbox.dataset.selectPath, checkbox.checked);
    if (event.target === browserCurrent && browserPath) toggleBrowserPath(browserPath, browserCurrent.checked);
  });
  browser.addEventListener('click', event => {
    const open = event.target.closest('[data-open-path]');
    if (open) return void loadBrowser(open.dataset.openPath);
    if (event.target.closest('[data-browser-up]')) return void loadBrowser(browserUp.dataset.path);
    if (event.target.closest('[data-browser-go]')) return void loadBrowser(browserPathInput.value.trim());
    if (event.target.closest('[data-browser-close],[data-browser-cancel]')) return browser.close();
    if (event.target.closest('[data-browser-confirm]')) {
      setPicked([...browserSelection]);
      browser.close();
    }
  });
  browserPathInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadBrowser(browserPathInput.value.trim());
    }
  });
  browser.addEventListener('cancel', () => { browserData = null; });

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
