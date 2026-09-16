const input = document.querySelector('#importPath');
const choose = document.querySelector('#chooseImport');
const addPanel = document.querySelector('#folderAdd');
const addToggle = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');
const folders = document.querySelector('#folders');
const folderSection = document.querySelector('.storage-folders-section');

if (addToggle) {
  let browserSelection = new Set();
  let browserPath = '';
  let browserData = null;
  let adding = false;
  let addMode = 'local';
  let addScope = 'media';
  let dragDepth = 0;

  if (addPanel) addPanel.hidden = true;
  const addCopy = addToggle.querySelector('.storage-add-copy');
  if (addCopy) addCopy.textContent = 'Add or drop folders';
  addToggle.title = 'Add folders or drop them here';

  const style = document.createElement('style');
  style.textContent = `
    .multi-folder-browser{width:min(720px,calc(100vw - 24px));max-width:720px;padding:0;overflow:hidden}
    .multi-folder-browser .dialog-head{padding:15px 17px 10px;margin:0}.multi-folder-browser .dialog-head h3{font-size:15px}
    .folder-browser-path{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:0 17px 10px}.folder-browser-path input{min-width:0;font:11px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
    .folder-browser-tools{display:flex;align-items:center;gap:6px;padding:0 17px 10px}.folder-browser-current{margin-left:auto;display:flex;align-items:center;gap:6px;color:#aaa29f;font-size:10px;cursor:pointer}.folder-browser-current input{width:auto;margin:0}
    .folder-browser-mode,.folder-browser-scope{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:0 17px 11px}.folder-browser-scope{padding-top:0}
    .folder-browser-mode button,.folder-browser-scope button{display:grid;gap:2px;min-height:47px;padding:8px 10px;border:1px solid #2d292d;border-radius:9px;background:#151316;color:#aaa29f;text-align:left;cursor:pointer}.folder-browser-mode button:hover,.folder-browser-scope button:hover{background:#1e1b20;color:#e7dfdb}.folder-browser-mode button.active,.folder-browser-scope button.active{border-color:#665456;background:#211c20;color:#f0e7e2}
    .folder-browser-mode strong,.folder-browser-scope strong{font-size:11px;font-weight:720;color:inherit}.folder-browser-mode span,.folder-browser-scope span{font-size:9px;color:#77706e}.folder-browser-mode button.active span,.folder-browser-scope button.active span{color:#aaa19e}
    .folder-browser-list{height:min(55vh,460px);min-height:240px;overflow:auto;border-top:1px solid #272329;border-bottom:1px solid #272329;background:#0d0c0e}.folder-browser-row{display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;border-bottom:1px solid #1d1a1e}.folder-browser-row:last-child{border-bottom:0}.folder-browser-row:hover{background:#151316}.folder-browser-row label{height:42px;display:grid;place-items:center;cursor:pointer}.folder-browser-row label input{width:auto;margin:0}
    .folder-browser-open{height:42px;min-width:0;padding:0 12px 0 0;border:0;background:transparent;color:#d0c7c3;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.folder-browser-open::before{content:'›';display:inline-block;width:20px;color:#746d6a;font-size:18px;vertical-align:-1px}.folder-browser-empty{padding:28px 17px;color:#77706e;text-align:center;font-size:10px}
    .folder-browser-footer{display:flex;align-items:center;gap:8px;padding:11px 17px 15px}.folder-browser-count{color:#8f8784;font-size:10px}.folder-browser-footer .spacer{flex:1}.folder-browser-add{min-width:76px}
    .folder-drop-overlay{position:fixed;z-index:10000;inset:58px 12px 12px;display:grid;place-items:center;border:2px dashed #6e595d;border-radius:18px;background:rgba(13,12,14,.91);backdrop-filter:blur(7px);pointer-events:none;opacity:0;transform:scale(.99);transition:opacity .12s ease,transform .12s ease}.folder-drop-overlay.show{opacity:1;transform:scale(1)}.folder-drop-copy{display:grid;gap:5px;text-align:center}.folder-drop-copy strong{color:#eee4df;font-size:18px}.folder-drop-copy span{color:#99908c;font-size:11px}.storage-folders-section.folder-drop-target #showFolderAdd{border-color:#655155;background:#1d171b}
    @media(prefers-reduced-motion:reduce){.folder-drop-overlay{transition:none}}
  `;
  document.head.append(style);

  const browser = document.createElement('dialog');
  browser.className = 'small-dialog multi-folder-browser';
  browser.innerHTML = `
    <div class="dialog-head"><h3 data-browser-title>Add folders</h3><button type="button" class="icon" data-browser-close>×</button></div>
    <div class="folder-browser-path"><input data-browser-path aria-label="Folder path"><button type="button" class="secondary" data-browser-go>Go</button></div>
    <div class="folder-browser-tools"><button type="button" class="action-link" data-browser-up>↑ Up</button><label class="folder-browser-current"><input type="checkbox" data-browser-current> This folder</label></div>
    <div class="folder-browser-mode" role="group" aria-label="Folder storage">
      <button type="button" data-browser-mode="local" class="active"><strong>Local</strong><span>Index on this device</span></button>
      <button type="button" data-browser-mode="cloud"><strong>Cloud</strong><span>Index + sync a Cloud copy</span></button>
    </div>
    <div class="folder-browser-scope" role="group" aria-label="Files to index">
      <button type="button" data-browser-scope="media" class="active"><strong>Media</strong><span>Photos + videos</span></button>
      <button type="button" data-browser-scope="all"><strong>Everything</strong><span>All files</span></button>
    </div>
    <div class="folder-browser-list" data-browser-list><div class="folder-browser-empty">Loading…</div></div>
    <div class="folder-browser-footer"><span class="folder-browser-count" data-browser-count>Select folders</span><span class="spacer"></span><button type="button" class="secondary" data-browser-cancel>Cancel</button><button type="button" class="primary folder-browser-add" data-browser-confirm disabled>Add</button></div>`;
  document.body.append(browser);

  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'folder-drop-overlay';
  dropOverlay.innerHTML = '<div class="folder-drop-copy"><strong>Drop folders into Mochimono</strong><span>Choose Local or Cloud before anything starts.</span></div>';
  document.body.append(dropOverlay);

  const browserTitle = browser.querySelector('[data-browser-title]');
  const browserPathInput = browser.querySelector('[data-browser-path]');
  const browserList = browser.querySelector('[data-browser-list]');
  const browserCurrent = browser.querySelector('[data-browser-current]');
  const browserCount = browser.querySelector('[data-browser-count]');
  const browserUp = browser.querySelector('[data-browser-up]');
  const browserConfirm = browser.querySelector('[data-browser-confirm]');
  const browserModes = [...browser.querySelectorAll('[data-browser-mode]')];
  const browserScopes = [...browser.querySelectorAll('[data-browser-scope]')];

  const clean = value => String(value || '').trim().replace(/[\\/]+$/, '');
  const key = value => clean(value).toLowerCase();
  const absolutePath = value => /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(String(value || '').trim());

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

  function selectedKeys() { return new Set([...browserSelection].map(key)); }
  function setSelected(path, checked) {
    const wanted = key(path);
    for (const existing of [...browserSelection]) if (key(existing) === wanted) browserSelection.delete(existing);
    if (checked && clean(path)) browserSelection.add(clean(path));
    updateCount();
  }
  function setMode(mode) { addMode = mode === 'cloud' ? 'cloud' : 'local'; browserModes.forEach(button => button.classList.toggle('active', button.dataset.browserMode === addMode)); updateCount(); }
  function setScope(scope) { addScope = scope === 'all' ? 'all' : 'media'; browserScopes.forEach(button => button.classList.toggle('active', button.dataset.browserScope === addScope)); updateCount(); }

  function updateCount() {
    const count = browserSelection.size, mode = addMode === 'cloud' ? 'Cloud' : 'Local', scope = addScope === 'all' ? 'Everything' : 'Media';
    browserCount.textContent = count ? `${count.toLocaleString()} selected · ${mode} · ${scope}` : `Select folders · ${mode} · ${scope}`;
    browserTitle.textContent = count ? `Add ${count.toLocaleString()} folder${count === 1 ? '' : 's'}` : 'Add folders';
    browserConfirm.disabled = !count || adding;
    browserConfirm.textContent = adding ? (addMode === 'cloud' ? 'Adding to queue…' : 'Adding to queue…') : 'Add';
  }

  function renderBrowser() {
    if (!browserData) return;
    browserPath = browserData.path; browserPathInput.value = browserPath; browserUp.disabled = !browserData.parent; browserUp.dataset.path = browserData.parent || '';
    const selected = selectedKeys(); browserCurrent.checked = selected.has(key(browserPath));
    const directories = browserData.directories || [];
    if (!directories.length) { browserList.innerHTML = '<div class="folder-browser-empty">No folders here.</div>'; updateCount(); return; }
    browserList.replaceChildren(...directories.map(directory => {
      const row = document.createElement('div'); row.className = 'folder-browser-row';
      const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(key(directory.path)); checkbox.dataset.selectPath = directory.path; checkbox.setAttribute('aria-label', `Add ${directory.name}`); label.append(checkbox);
      const open = document.createElement('button'); open.type = 'button'; open.className = 'folder-browser-open'; open.dataset.openPath = directory.path; open.textContent = directory.name; open.title = directory.path;
      row.append(label, open); return row;
    }));
    updateCount();
  }

  async function loadBrowser(path = '') {
    browserList.innerHTML = '<div class="folder-browser-empty">Loading…</div>';
    try { browserData = await request(`/api/client/folder-browser${path ? `?path=${encodeURIComponent(path)}` : ''}`); renderBrowser(); }
    catch (error) { browserList.replaceChildren(); const empty = document.createElement('div'); empty.className = 'folder-browser-empty error'; empty.textContent = error.message; browserList.append(empty); }
  }

  async function openBrowser(event, initialPaths = []) {
    event?.preventDefault(); event?.stopImmediatePropagation();
    const initial = [...new Set((initialPaths || []).map(clean).filter(Boolean))];
    if (browser.open) { for (const path of initial) setSelected(path, true); return; }
    browserSelection = new Set(initial); browserData = null; adding = false; setMode('local'); setScope('media'); browser.showModal(); updateCount();
    const start = initial[0] || browserPath || clean(input?.value);
    await loadBrowser(start);
  }

  function refreshNow(paths = []) {
    folders?.dispatchEvent(new MouseEvent('click', { bubbles:true }));
    frame?.contentWindow?.mochimonoClientBridge?.followLocalIndex?.(paths);
    setTimeout(() => { frame?.contentWindow?.mochimonoLibrary?.refresh?.().catch?.(() => {}); frame?.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {}); }, 180);
  }

  async function addSelected(event) {
    event?.preventDefault(); event?.stopImmediatePropagation(); if (adding || !browserSelection.size) return;
    adding = true; updateCount();
    const paths = [...browserSelection], addedPaths = [], failed = []; let added = 0;
    const endpoint = addMode === 'cloud' ? '/api/folders' : '/api/browse-folders';
    for (const path of paths) {
      try { await request(endpoint, { method:'POST', body:JSON.stringify({ path, scope:addScope }) }); added++; addedPaths.push(path); }
      catch (error) { failed.push({ path, error:error.message }); }
    }
    adding = false;
    if (failed.length) { browserSelection = new Set(failed.map(item => item.path)); updateCount(); renderBrowser(); toast(`${added ? `${added} queued · ` : ''}${failed.length} failed: ${failed[0].error}`); if (added) refreshNow(addedPaths); return; }
    browser.close(); if (input) input.value = ''; refreshNow(addedPaths);
    const mode = addMode === 'cloud' ? 'Cloud' : 'Local', scope = addScope === 'all' ? 'Everything' : 'Media';
    toast(`${added.toLocaleString()} folder${added === 1 ? '' : 's'} queued · ${mode} · ${scope}`);
  }

  function uriPath(uri) {
    try {
      const url = new URL(uri);
      if (url.protocol !== 'file:') return '';
      let path = decodeURIComponent(url.pathname || '');
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      if (url.hostname) path = `//${url.hostname}${path}`;
      return clean(path.replaceAll('/', navigator.userAgent.includes('Windows') ? '\\' : '/'));
    } catch { return ''; }
  }

  function droppedPaths(event) {
    const transfer = event.dataTransfer, values = [];
    for (const file of transfer?.files || []) if (file.path && absolutePath(file.path)) values.push(file.path);
    for (const line of String(transfer?.getData('text/uri-list') || '').split(/\r?\n/)) { const path = line && !line.startsWith('#') ? uriPath(line) : ''; if (path) values.push(path); }
    for (const line of String(transfer?.getData('text/plain') || '').split(/\r?\n/)) if (absolutePath(line)) values.push(line.trim().replace(/^['"]|['"]$/g, ''));
    return [...new Map(values.map(value => [key(value), clean(value)])).values()].filter(Boolean);
  }
  function dragHasFolders(event) { const types = [...(event.dataTransfer?.types || [])]; return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain'); }
  function showDrop(show) { dropOverlay.classList.toggle('show', show); folderSection?.classList.toggle('folder-drop-target', show); }

  addToggle.addEventListener('click', openBrowser, true); choose?.addEventListener('click', openBrowser, true);
  browser.addEventListener('change', event => { const checkbox = event.target.closest('[data-select-path]'); if (checkbox) setSelected(checkbox.dataset.selectPath, checkbox.checked); if (event.target === browserCurrent && browserPath) setSelected(browserPath, browserCurrent.checked); });
  browser.addEventListener('click', event => {
    const mode = event.target.closest('[data-browser-mode]'); if (mode) return setMode(mode.dataset.browserMode);
    const scope = event.target.closest('[data-browser-scope]'); if (scope) return setScope(scope.dataset.browserScope);
    const open = event.target.closest('[data-open-path]'); if (open) return void loadBrowser(open.dataset.openPath);
    if (event.target.closest('[data-browser-up]')) return void loadBrowser(browserUp.dataset.path);
    if (event.target.closest('[data-browser-go]')) return void loadBrowser(browserPathInput.value.trim());
    if (event.target.closest('[data-browser-close],[data-browser-cancel]')) return browser.close();
    if (event.target.closest('[data-browser-confirm]')) return void addSelected(event);
  });
  browserPathInput.addEventListener('keydown', event => { if (event.key !== 'Enter') return; event.preventDefault(); loadBrowser(browserPathInput.value.trim()); });
  browser.addEventListener('cancel', () => { browserSelection.clear(); browserData = null; adding = false; });

  folderSection?.addEventListener('dragenter', event => { if (!dragHasFolders(event)) return; event.preventDefault(); dragDepth++; showDrop(true); });
  folderSection?.addEventListener('dragover', event => { if (!dragHasFolders(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; showDrop(true); });
  folderSection?.addEventListener('dragleave', event => { if (!dragHasFolders(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
  folderSection?.addEventListener('drop', event => {
    if (!dragHasFolders(event)) return;
    event.preventDefault(); dragDepth = 0; showDrop(false);
    const paths = droppedPaths(event);
    if (paths.length) void openBrowser(event, paths);
    else { toast('Your browser hid the native folder path. Choose the folder here instead.'); void openBrowser(event); }
  });

  window.mochimonoAddFolders = paths => openBrowser(null, Array.isArray(paths) ? paths : [paths]);
  window.addEventListener('mochimono-folder-intent-ui', () => openBrowser());
}
