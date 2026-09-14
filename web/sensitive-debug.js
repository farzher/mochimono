const files = document.querySelector('#files');
const menu = document.querySelector('.file-context-menu');
const scanner = window.mochimonoSensitiveScan;

if (files && menu && scanner?.inspect) {
  const style = document.createElement('style');
  style.textContent = `
    .file-context-sensitive-debug{display:grid;gap:7px;margin-top:6px;padding:9px;border:1px solid rgba(255,255,255,.07);border-radius:9px;background:#121013;color:#cfc7c4}.file-context-sensitive-debug[hidden]{display:none}
    .sensitive-debug-head{display:flex;align-items:center;gap:7px}.sensitive-debug-head strong{font-size:10px;color:#eee8e4}.sensitive-debug-head span{margin-left:auto;color:#756e71;font-size:8.5px}
    .sensitive-debug-scores{display:grid;grid-template-columns:1fr 1fr;gap:5px}.sensitive-debug-score{padding:7px 8px;border-radius:7px;background:#1b181c}.sensitive-debug-score strong{display:block;font:780 16px/1 system-ui;color:#eee8e4}.sensitive-debug-score span{display:block;margin-top:3px;color:#81797c;font:8px/1 system-ui;text-transform:uppercase;letter-spacing:.04em}
    .sensitive-debug-decision{padding:6px 7px;border-radius:7px;background:#211e22;color:#c9bfbc;font:650 9px/1.3 system-ui}.sensitive-debug-meta,.sensitive-debug-raw{color:#777073;font:8.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.sensitive-debug-note{color:#8b817e;font:8.5px/1.35 system-ui}
    .sensitive-debug-actions{display:flex;gap:4px}.sensitive-debug-actions button{flex:1;min-height:27px;padding:4px 6px;border:0;border-radius:6px;background:#262228;color:#aaa1a0;font:700 8.5px/1.15 system-ui;cursor:pointer}.sensitive-debug-actions button:hover{background:#302b31;color:#fff}.sensitive-debug-actions button:disabled{opacity:.45;cursor:default}
    .file-context-action[data-sensitive-inspect] i{color:#d8aaa3}
  `;
  document.head.append(style);

  const standard = menu.querySelector('.file-context-standard-actions');
  const status = menu.querySelector('[data-context-status]');
  const inspectButton = document.createElement('button');
  inspectButton.type = 'button';
  inspectButton.className = 'file-context-action';
  inspectButton.dataset.sensitiveInspect = '1';
  inspectButton.innerHTML = '<i aria-hidden="true">◉</i><span class="file-context-action-text"><span>Sensitive score</span><small>Inspect NSFW model output</small></span>';
  standard?.append(inspectButton);

  const panel = document.createElement('section');
  panel.className = 'file-context-sensitive-debug';
  panel.hidden = true;
  status?.before(panel);

  let hash = '';
  let requestId = 0;

  const percent = value => `${(Math.max(0, Math.min(1, Number(value) || 0)) * 100).toFixed(1)}%`;
  const backendLabel = runtime => runtime?.backend === 'webgpu' ? 'GPU' : runtime?.backend === 'wasm' ? 'CPU' : runtime?.backend || 'cache';

  function clampMenu() {
    requestAnimationFrame(() => {
      if (menu.hidden || panel.hidden) return;
      const rect = menu.getBoundingClientRect();
      if (rect.bottom > innerHeight - 6) menu.style.top = `${Math.max(6, innerHeight - rect.height - 6)}px`;
      if (rect.right > innerWidth - 6) menu.style.left = `${Math.max(6, innerWidth - rect.width - 6)}px`;
    });
  }

  function loading(input) {
    panel.hidden = false;
    panel.innerHTML = `<div class="sensitive-debug-head"><strong>Sensitive model</strong><span>${input === 'original' ? 'original' : 'scan thumbnail'}</span></div><div class="sensitive-debug-note">Running classifier…</div>`;
    clampMenu();
  }

  function render(result) {
    const labels = Array.isArray(result.labels) ? result.labels : [];
    const raw = labels.length
      ? labels.map(row => `${row.label} ${Number(row.score).toFixed(4)}`).join(' · ')
      : `nsfw ${Number(result.nsfw).toFixed(4)} · normal ${Number(result.normal).toFixed(4)} (derived from cached score)`;
    const current = result.tag?.excluded
      ? 'Excluded'
      : result.tag?.manual
        ? 'Currently manual Sensitive'
        : result.tag?.detected
          ? `Currently detected${result.tag.confidence == null ? '' : ` at ${percent(result.tag.confidence)}`}`
          : 'Currently not tagged Sensitive';
    const source = result.source === 'cache' ? 'cached' : 'fresh';
    const input = result.input === 'original' ? 'Original image' : 'Scan thumbnail';
    const updated = result.updatedAt ? new Date(result.updatedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', second:'2-digit' }) : '';

    panel.innerHTML = `
      <div class="sensitive-debug-head"><strong>Sensitive model</strong><span>${input}</span></div>
      <div class="sensitive-debug-scores">
        <div class="sensitive-debug-score"><strong>${percent(result.nsfw)}</strong><span>NSFW</span></div>
        <div class="sensitive-debug-score"><strong>${percent(result.normal)}</strong><span>Normal</span></div>
      </div>
      <div class="sensitive-debug-decision">${result.decision} · threshold ${percent(result.threshold)}</div>
      <div class="sensitive-debug-note">${current}${result.input === 'original' ? ' · comparison only; library scans use the thumbnail' : ''}</div>
      <div class="sensitive-debug-meta">${source} · ${backendLabel(result.runtime)}${result.runtime?.dtype ? ` ${result.runtime.dtype}` : ''}${updated ? ` · ${updated}` : ''}</div>
      <div class="sensitive-debug-raw">raw: ${raw}</div>
      <div class="sensitive-debug-actions">
        <button type="button" data-sensitive-debug="cached">Scan score</button>
        <button type="button" data-sensitive-debug="fresh">Fresh thumbnail</button>
        <button type="button" data-sensitive-debug="original">Original</button>
      </div>`;
    clampMenu();
  }

  async function inspect(input = 'thumbnail', fresh = false) {
    const wanted = hash;
    if (!wanted) return;
    const mine = ++requestId;
    loading(input);
    try {
      const result = await scanner.inspect(wanted, { input, fresh });
      if (mine !== requestId || wanted !== hash || menu.hidden) return;
      render(result);
    } catch (error) {
      if (mine !== requestId || wanted !== hash || menu.hidden) return;
      panel.hidden = false;
      panel.innerHTML = `<div class="sensitive-debug-head"><strong>Sensitive model</strong></div><div class="sensitive-debug-note">${String(error?.message || error)}</div><div class="sensitive-debug-actions"><button type="button" data-sensitive-debug="fresh">Try again</button></div>`;
      clampMenu();
    }
  }

  files.addEventListener('contextmenu', event => {
    const card = event.target.closest('.file-card.media-card[data-hash]');
    hash = card && files.contains(card) ? String(card.dataset.hash || '') : '';
    requestId++;
    panel.hidden = true;
    panel.replaceChildren();
  }, true);

  inspectButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void inspect('thumbnail', false);
  });

  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-sensitive-debug]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.sensitiveDebug;
    if (action === 'original') void inspect('original', true);
    else if (action === 'fresh') void inspect('thumbnail', true);
    else void inspect('thumbnail', false);
  });
}