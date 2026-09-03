const input = document.querySelector('#importPath');
const choose = document.querySelector('#chooseImport');
const addPanel = document.querySelector('#folderAdd');
const addToggle = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');
const folders = document.querySelector('#folders');

if (addToggle) {
  let browserSelection = new Set();
  let browserPath = '';
  let browserData = null;
  let adding = false;

  // The old two-step Local/Cloud chooser stays in the DOM for compatibility
  // with older handlers, but Storage now has one simple default: add Local.
  if (addPanel) addPanel.hidden = true;

  const style = document.createElement('style');
  style.textContent = `
    .multi-folder-browser{width:min(720px,calc(100vw - 24px));max-width:720px;padding:0;overflow:hidden}
    .multi-folder-browser .dialog-head{padding:15px 17px 10px;margin:0}
    .multi-folder-browser .dialog-head h3{font-size:15px}
    .folder-browser-path{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:0 17px 10px}
    .folder-browser-path input{min-width:0;font:11px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
    .folder-browser-tools{display:flex;align-items:center;gap:6px;padding:0 17px 10px}
    .folder-browser-current{margin-left:auto;display:flex;align-items:center;gap:6px;color:#aaa29f;font-size:10px;cursor:pointer}
    .folder-browser-current input{width:auto;margin:0}
    .folder-browser-list{height:min(55vh,460px);min-height:240px;overflow:auto;border-top:1px solid #272329;border-bottom:1px solid #272329;background:#0d0c0e}
    .folder-browser-row{display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;border-bottom:1px solid #1d1a1e}
    .folder-browser-row:last-child{border-bottom:0}
    .folder-browser-row:hover{background:#151316}
    .folder-browser-row label{height:42px;display:grid;place-items:center;cursor:pointer}
    .folder-browser-row label input{width:auto;margin:0}
    .folder-browser-open{height:42px;min-width:0;padding:0 12px 0 0;border:0;background:transparent;color:#d0c7c3;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
    .folder-browser-open::before{content:'›';display:inline-block;width:20px;color:#746d6a;font-size:18px;vertical-align:-1px}
    .folder-browser-empty{padding:28px 17px;color:#77706e;text-align:center;font-size:10px}
    .folder-browser-footer{display:flex;align-items:center;gap:8px;padding:11px 17px 15px}
    .folder-browser-count{color:#8f8784;font-size:10px}
    .folder-browser-footer .spacer{flex:1}
    .folder-browser-add{min-width:76px}
  `;
  document.head.append(style);

  const browser = document.createElement('dialog');
  browser.className = 'small-dialog multi-folder-browser';
  browser.innerHTML = `
    <div class="dialog-head"><h3>Add folders</h3><button type="button" class="icon" data-browser-close>×</button></div>
    <div class="folder-browser-path"><input data-browser-path aria-label="Folder path"><button type="button" class="secondary" data-browser-go>Go</button></div>
    <div class="folder-browser-tools"><button type="button" class="action-link" data-browser-up>↑ Up</button><label class="folder-browser-current"><input type="checkbox" data-browser-current> This folder</label></div>
    <div class="folder-browser-list" data-browser-list><div class="folder-browser-empty">Loading…</div></div>
    <div class="folder-browser-footer"><span class="folder-browser-count" data-browser-count>Select folders</span><span class="spacer"></span><button type="button" class="secondary" data-browser-cancel>Cancel</button><button type="button" class="primary folder-browser-add" data-browser-confirm disabled>Add</button></div>`;
  document.body.append(browser);

  const browserPathInput = browser.querySelector('[data-browser-path]');
  const browserList = browser.querySelector('[data-browser-list]');
  const browserCurrent = browser.querySelector('[data-browser-current]');
  const browserCount = browser.querySelector('[data-browser-count]');
  const browserUp = browser.querySelector('[data-browser-up]');
  const browserConfirm = browser.querySelector('[data-browser-confirm]');

  const clean = value => String(value || '').trim().replace(/[\\/]+$/, '');
  const key = value => clean(value).toLowerCase();

  async function request(path, options = {}) {
    const response = await fetch(path, { headers: { 'content-type':'application/json' }, ...options });
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

  function selectedKeys() {
    return new Set([...browserSelection].map(key));
  }

  function setSelected(path, checked) {
    const wanted = key(path);
    for (const existing of [...browserSelection]) {
      if (key(existing) === wanted) browserSelection.delete(existing);
    }
    if (checked && clean(path)) browserSelection.add(clean(path));
    updateCount();
  }

  function updateCount() {
    const count = browserSelection.size;
    browserCount.textContent = count ? `${count.toLocaleString()} selected · Local` : 'Select folders';
    browserConfirm.disabled = !count || adding;
    browserConfirm.textContent = adding ? 'Adding…' : 'Add';
  }

  function renderBrowser() {
    if (!browserData) return;
    browserPath = browserData.path;
    browserPathInput.value = browserPath;
    browserUp.disabled = !browserData.parent;
    browserUp.dataset.path = browserData.parent || '';
    const selected = selectedKeys();
    browserCurrent.checked = selected.has(key(browserPath));

    const directories = browserData.directories || [];
    if (!directories.length) {
      browserList.innerHTML = '<div class="folder-browser-empty">No folders here.</div>';
      updateCount();
      return;
    }

    browserList.replaceChildren(...directories.map(directory => {
      const row = document.createElement('div');
      row.className = 'folder-browser-row';

      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(key(directory.path));
      checkbox.dataset.selectPath = directory.path;
      checkbox.setAttribute('aria-label', `Add ${directory.name}`);
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
    updateCount();
  }

  async function loadBrowser(path = '') {
    browserList.innerHTML = '<div class="folder-browser-empty">Loading…</div>';
    try {
      browserData = await request(`/api/client/folder-browser${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      renderBrowser();
    } catch (error) {
      browserList.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'folder-browser-empty error';
      empty.textContent = error.message;
      browserList.append(empty);
    }
  }

  async function openBrowser(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    if (browser.open) return;
    browserSelection = new Set();
    browserData = null;
    adding = false;
    updateCount();
    browser.showModal();
    await loadBrowser(browserPath || clean(input?.value));
  }

  function refreshNow(paths = []) {
    // app.js refreshes folder state on any click inside #folders. Trigger that
    // path so a newly added folder appears immediately instead of waiting for
    // the normal two-second status poll.
    folders?.dispatchEvent(new MouseEvent('click', { bubbles:true }));
    frame?.contentWindow?.mochimonoClientBridge?.followLocalIndex?.(paths);
    setTimeout(() => {
      frame?.contentWindow?.mochimonoLibrary?.refresh?.().catch?.(() => {});
      frame?.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {});
    }, 180);
  }

  async function addSelected(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    if (adding || !browserSelection.size) return;

    adding = true;
    updateCount();
    const paths = [...browserSelection];
    const addedPaths = [];
    const failed = [];
    let added = 0;

    for (const path of paths) {
      try {
        await request('/api/browse-folders', { method:'POST', body:JSON.stringify({ path }) });
        added++;
        addedPaths.push(path);
      } catch (error) {
        failed.push({ path, error:error.message });
      }
    }

    adding = false;
    if (failed.length) {
      browserSelection = new Set(failed.map(item => item.path));
      updateCount();
      renderBrowser();
      toast(`${added ? `${added} added · ` : ''}${failed.length} failed: ${failed[0].error}`);
      if (added) refreshNow(addedPaths);
      return;
    }

    browser.close();
    if (input) input.value = '';
    refreshNow(addedPaths);
    toast(`${added.toLocaleString()} folder${added === 1 ? '' : 's'} added · Local`);
  }

  // Capture beats app.js's legacy onclick that used to reveal the two-mode form.
  addToggle.addEventListener('click', openBrowser, true);
  choose?.addEventListener('click', openBrowser, true);

  browser.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-select-path]');
    if (checkbox) setSelected(checkbox.dataset.selectPath, checkbox.checked);
    if (event.target === browserCurrent && browserPath) setSelected(browserPath, browserCurrent.checked);
  });

  browser.addEventListener('click', event => {
    const open = event.target.closest('[data-open-path]');
    if (open) return void loadBrowser(open.dataset.openPath);
    if (event.target.closest('[data-browser-up]')) return void loadBrowser(browserUp.dataset.path);
    if (event.target.closest('[data-browser-go]')) return void loadBrowser(browserPathInput.value.trim());
    if (event.target.closest('[data-browser-close],[data-browser-cancel]')) return browser.close();
    if (event.target.closest('[data-browser-confirm]')) return void addSelected(event);
  });

  browserPathInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    loadBrowser(browserPathInput.value.trim());
  });

  browser.addEventListener('cancel', () => {
    browserSelection.clear();
    browserData = null;
    adding = false;
  });

  window.addEventListener('mochimono-folder-intent-ui', () => openBrowser());
}
