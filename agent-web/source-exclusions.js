const folders = document.querySelector('#folders');
const toastNode = document.querySelector('#toast');

const style = document.createElement('style');
style.textContent = `
.source-ignore-dialog{width:min(620px,calc(100vw - 28px));border:0;border-radius:14px;background:#171518;color:#eee8e4;padding:15px;box-shadow:0 28px 90px rgba(0,0,0,.62)}
.source-ignore-dialog::backdrop{background:rgba(0,0,0,.58);backdrop-filter:blur(3px)}
.source-ignore-copy{margin:5px 0 12px;color:#8f8783;font:11px/1.5 system-ui}.source-ignore-copy strong{color:#cfc6c2}.source-ignore-copy code{color:#c9c0bc;font:10px ui-monospace,SFMono-Regular,Consolas,monospace}
.source-ignore-list{display:grid;gap:5px;max-height:290px;overflow:auto}.source-ignore-empty{padding:20px 8px;text-align:center;color:#746d6b;font-size:11px}
.source-ignore-item{min-width:0;display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:8px;background:#111012}.source-ignore-item code{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d7cfcb;font:10.5px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace}.source-ignore-item button{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:#8f8582;cursor:pointer}.source-ignore-item button:hover{background:#29252a;color:#fff}
.source-ignore-add{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;margin-top:11px}.source-ignore-add input{min-width:0;height:34px;box-sizing:border-box;border:1px solid rgba(255,255,255,.09);border-radius:8px;background:#0f0e10;color:#eee8e4;padding:0 9px;font:11px/1 system-ui;outline:0}.source-ignore-add button{height:34px;padding:0 11px;border:0;border-radius:8px;background:#28242a;color:#d8cfcb;font:700 10px/1 system-ui;cursor:pointer}.source-ignore-add button.primary{background:#eee8e4;color:#171416}.source-ignore-add button:hover{filter:brightness(1.08)}
.source-ignore-status{min-height:17px;padding-top:6px;color:#958c88;font-size:10px}.item-actions [data-source-ignore]{white-space:nowrap}
@media(max-width:620px){.source-ignore-add{grid-template-columns:1fr auto}.source-ignore-add input{grid-column:1/-1}}
`;
document.head.append(style);

const dialog = document.createElement('dialog');
dialog.className = 'source-ignore-dialog';
dialog.innerHTML = `
  <div class="dialog-head"><div><h3>Ignored paths & patterns</h3><div class="picker-path" data-ignore-root></div></div><button class="icon" data-ignore-close aria-label="Close">×</button></div>
  <p class="source-ignore-copy">Ignored files and folders are <strong>skipped before scanning, hashing, or uploading</strong>. Patterns support <code>*</code>, <code>?</code>, and <code>**</code>, for example <code>**/node_modules</code> or <code>**/*.tmp</code>. Existing Cloud copies are kept.</p>
  <div class="source-ignore-list" data-ignore-list></div>
  <div class="source-ignore-add">
    <input data-ignore-input placeholder="Path or pattern, e.g. **/node_modules">
    <button type="button" data-ignore-choose>Choose folder</button>
    <button type="button" class="primary" data-ignore-add>Ignore</button>
  </div>
  <div class="source-ignore-status" data-ignore-status></div>`;
document.body.append(dialog);

const rootNode = dialog.querySelector('[data-ignore-root]');
const listNode = dialog.querySelector('[data-ignore-list]');
const input = dialog.querySelector('[data-ignore-input]');
const status = dialog.querySelector('[data-ignore-status]');
let activeRoot = '';
let exclusions = [];

function toast(text) {
  if (!toastNode) return;
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
}

async function json(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

function render() {
  rootNode.textContent = activeRoot;
  rootNode.title = activeRoot;
  listNode.innerHTML = exclusions.length
    ? exclusions.map(path => `<div class="source-ignore-item"><code title="${escapeHtml(path)}">${escapeHtml(path)}</code><button type="button" data-include-path="${escapeHtml(path)}" title="Include again" aria-label="Include again">×</button></div>`).join('')
    : '<div class="source-ignore-empty">Nothing ignored in this source.</div>';
}

async function load(root) {
  status.textContent = 'Loading…';
  const data = await json(`/api/source-exclusions?path=${encodeURIComponent(root)}`);
  activeRoot = data.path;
  exclusions = data.exclusions || [];
  render();
  status.textContent = '';
}

async function open(root) {
  activeRoot = root;
  input.value = '';
  exclusions = [];
  render();
  dialog.showModal();
  try { await load(root); }
  catch (error) { status.textContent = error.message; }
}

function installButtons() {
  for (const row of folders?.querySelectorAll?.('[data-folder-path]') || []) {
    const actions = row.querySelector('.item-actions');
    if (!actions || actions.querySelector('[data-source-ignore]')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-link';
    button.dataset.sourceIgnore = '1';
    button.textContent = 'Ignore…';
    button.title = 'Ignore files, subfolders, or patterns from this source';
    button.addEventListener('click', () => open(row.dataset.folderPath).catch(error => toast(error.message)));
    actions.prepend(button);
  }
}

new MutationObserver(installButtons).observe(folders, { childList:true, subtree:true });
installButtons();

dialog.querySelector('[data-ignore-close]').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });

dialog.querySelector('[data-ignore-choose]').addEventListener('click', async () => {
  try {
    const picked = await json('/api/pick-folder');
    if (picked.path) input.value = picked.path;
  } catch (error) { status.textContent = error.message; }
});

dialog.querySelector('[data-ignore-add]').addEventListener('click', async () => {
  const target = input.value.trim();
  if (!target || !activeRoot) return;
  status.textContent = 'Updating source…';
  try {
    const data = await json('/api/source-exclusions', { method:'POST', body:{ path:activeRoot, exclude:target } });
    exclusions = data.exclusions || [];
    input.value = '';
    render();
    status.textContent = 'Ignored. Mochimono is refreshing this source.';
    toast('Ignored from source');
  } catch (error) { status.textContent = error.message; }
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter') dialog.querySelector('[data-ignore-add]').click();
});

listNode.addEventListener('click', async event => {
  const button = event.target.closest('[data-include-path]');
  if (!button || !activeRoot) return;
  const path = button.dataset.includePath;
  status.textContent = 'Updating source…';
  try {
    const data = await json('/api/source-exclusions', { method:'POST', body:{ path:activeRoot, include:path } });
    exclusions = data.exclusions || [];
    render();
    status.textContent = 'Included again. Mochimono is refreshing this source.';
    toast('Included in source');
  } catch (error) { status.textContent = error.message; }
});
