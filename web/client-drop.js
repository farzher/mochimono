import './client-bridge.js';

if (location.pathname.startsWith('/files')) {
  const style = document.createElement('style');
  style.textContent = `
    .client-drop-target{position:fixed;inset:12px;z-index:80;display:grid;place-items:center;border:2px dashed rgba(239,160,154,.55);border-radius:18px;background:rgba(13,12,14,.92);color:#f4eeea;opacity:0;pointer-events:none;transition:opacity .12s}.client-drop-target.show{opacity:1}.client-drop-target div{text-align:center}.client-drop-target strong{display:block;font:750 22px/1.2 Inter,system-ui,sans-serif}.client-drop-target span{display:block;margin-top:6px;color:#a79e9b;font:500 11px/1.3 Inter,system-ui,sans-serif}
    .client-drop-choice{position:fixed;z-index:90;inset:0;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.62);font-family:Inter,system-ui,sans-serif}.client-drop-choice[hidden]{display:none!important}.client-drop-choice-card{width:min(460px,100%);padding:16px;border:1px solid #302b30;border-radius:14px;background:#171518;color:#f4eeea;box-shadow:0 24px 80px rgba(0,0,0,.58)}.client-drop-choice-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.client-drop-choice-head strong{display:block;font-size:15px}.client-drop-choice-head span{display:block;margin-top:3px;color:#8f8583;font-size:11px}.client-drop-choice-close{border:0;background:transparent;color:#8f8583;font-size:20px;cursor:pointer}.client-drop-actions{display:grid;gap:7px}.client-drop-action{display:block;width:100%;padding:10px 11px;border:1px solid #2b272c;border-radius:9px;background:#1d1a1e;color:#d9d0cd;text-align:left;cursor:pointer}.client-drop-action:hover,.client-drop-action:focus-visible{border-color:#514348;background:#252126;color:#fff;outline:none}.client-drop-action.primary{border-color:#4a373b;background:#2a2023}.client-drop-action b,.client-drop-action span{display:block}.client-drop-action b{font-size:12px}.client-drop-action span{margin-top:2px;color:#8f8583;font-size:10px;font-weight:500}.client-drop-action:hover span,.client-drop-action:focus-visible span{color:#aaa19e}.client-drop-choice-note{margin-top:9px;color:#6f6867;font-size:10px;line-height:1.35}
    .client-import-result{position:fixed;z-index:81;right:18px;bottom:18px;width:min(430px,calc(100vw - 36px));padding:13px 14px;border:1px solid #302b30;border-radius:12px;background:#171518;color:#f4eeea;box-shadow:0 18px 60px rgba(0,0,0,.5);font:12px/1.4 Inter,system-ui,sans-serif}.client-import-result[hidden]{display:none!important}.client-import-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.client-import-head strong{font-size:13px}.client-import-close{border:0;background:transparent;color:#8f8583;font-size:18px;cursor:pointer}.client-import-progress{height:4px;margin:9px 0 6px;border-radius:999px;background:#292529;overflow:hidden}.client-import-progress i{display:block;height:100%;background:#efa09a;transition:width .15s}.client-import-meta{color:#aaa19e}.client-import-note{margin-top:3px;color:#746d6c;font-size:10px}.client-import-dupes{max-height:150px;margin-top:8px;overflow:auto}.client-import-examples{padding:5px 0;color:#817876;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.client-import-dupe{padding:6px 0;border-top:1px solid #262326}.client-import-dupe b{display:block;color:#e7dfdc;font-weight:650}.client-import-dupe span{display:block;color:#8f8583;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  `;
  document.head.append(style);

  const target = document.createElement('div');
  target.className = 'client-drop-target';
  target.innerHTML = '<div><strong>Drop files</strong><span>Choose what Mochimono should do</span></div>';
  document.body.append(target);

  const choice = document.createElement('div');
  choice.className = 'client-drop-choice';
  choice.hidden = true;
  choice.innerHTML = `
    <div class="client-drop-choice-card">
      <div class="client-drop-choice-head"><div><strong data-drop-title></strong><span data-drop-meta></span></div><button class="client-drop-choice-close" aria-label="Cancel">×</button></div>
      <div class="client-drop-actions">
        <button class="client-drop-action primary" data-drop-copy><b>Copy to Mochimono</b><span>Use this drop directly · one-time Server copy · originals stay where they are</span></button>
        <button class="client-drop-action" data-drop-browse><b>Browse this folder…</b><span>Confirm it once in the native picker · local only · nothing uploaded</span></button>
        <button class="client-drop-action" data-drop-protect><b>Protect this folder…</b><span>Confirm it once in the native picker · local + Mochimono copy · watched</span></button>
      </div>
      <div class="client-drop-choice-note" data-drop-note></div>
    </div>`;
  document.body.append(choice);

  const result = document.createElement('div');
  result.className = 'client-import-result';
  result.hidden = true;
  result.innerHTML = `
    <div class="client-import-head"><strong data-import-title>Copying to Mochimono</strong><button class="client-import-close" aria-label="Close">×</button></div>
    <div class="client-import-progress"><i data-import-bar></i></div>
    <div class="client-import-meta" data-import-meta></div>
    <div class="client-import-note" data-import-note></div>
    <div class="client-import-dupes" data-import-dupes></div>`;
  document.body.append(result);
  result.querySelector('.client-import-close').onclick = () => { result.hidden = true; };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const normalizePath = value => String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');

  async function entryFiles(entry, prefix = '') {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      return [{ file, path: normalizePath(prefix ? `${prefix}/${file.name}` : file.name) }];
    }
    if (!entry.isDirectory) return [];
    const reader = entry.createReader();
    const children = [];
    while (true) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      children.push(...batch);
    }
    const root = prefix ? `${prefix}/${entry.name}` : entry.name;
    return (await Promise.all(children.map(child => entryFiles(child, root)))).flat();
  }

  async function handleFiles(handle, prefix = '') {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      return [{ file, path: normalizePath(prefix ? `${prefix}/${file.name}` : file.name) }];
    }
    if (handle.kind !== 'directory') return [];
    const root = prefix ? `${prefix}/${handle.name}` : handle.name;
    const files = [];
    for await (const child of handle.values()) files.push(...await handleFiles(child, root));
    return files;
  }

  async function droppedFiles(dataTransfer) {
    const items = [...(dataTransfer.items || [])].filter(item => item.kind === 'file');
    const gathered = [];
    for (const item of items) {
      try {
        if (item.getAsFileSystemHandle) {
          const handle = await item.getAsFileSystemHandle();
          if (handle) { gathered.push(...await handleFiles(handle)); continue; }
        }
      } catch {}
      try {
        const entry = item.webkitGetAsEntry?.();
        if (entry) { gathered.push(...await entryFiles(entry)); continue; }
      } catch {}
      const file = item.getAsFile?.();
      if (file) gathered.push({ file, path: file.webkitRelativePath || file.name });
    }
    if (!gathered.length) for (const file of dataTransfer.files || []) gathered.push({ file, path: file.webkitRelativePath || file.name });
    const unique = new Map();
    for (const item of gathered) unique.set(`${normalizePath(item.path)}\0${item.file.size}\0${item.file.lastModified}`, item);
    return [...unique.values()];
  }

  async function request(path, options = {}) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) window.parent.postMessage({ type: 'mochimono-auth-required' }, location.origin);
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function commonDirectory(items) {
    const directories = items.map(item => normalizePath(item.path).split('/').filter(Boolean).slice(0, -1));
    if (!directories.length || directories.some(parts => !parts.length)) return '';
    const common = [...directories[0]];
    for (const parts of directories.slice(1)) {
      let length = 0;
      while (length < common.length && length < parts.length && common[length].toLowerCase() === parts[length].toLowerCase()) length++;
      common.length = length;
      if (!common.length) return '';
    }
    return common.join('/');
  }

  function droppedFolderHint(items) {
    const roots = new Set();
    let nested = false;
    for (const item of items) {
      const parts = normalizePath(item.path).split('/').filter(Boolean);
      if (parts.length < 2) continue;
      nested = true;
      roots.add(parts[0]);
      if (roots.size > 1) return '';
    }
    return nested ? [...roots][0] || '' : '';
  }

  function chooseIntent(files) {
    const folder = droppedFolderHint(files);
    const local = Boolean(folder);
    const title = folder || (files.length === 1 ? files[0].file.name : `${files.length.toLocaleString()} files`);
    choice.querySelector('[data-drop-title]').textContent = title;
    choice.querySelector('[data-drop-meta]').textContent = `${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'}`;
    choice.querySelector('[data-drop-browse]').hidden = !local;
    choice.querySelector('[data-drop-protect]').hidden = !local;
    choice.querySelector('[data-drop-note]').textContent = local
      ? 'Chrome gives Mochimono the dropped contents, but not the folder’s full disk path. Copy uses the drop directly; Local/Protect need one native folder confirmation.'
      : 'Loose files can be copied directly. Persistent Local/Protect mode requires adding their folder instead.';
    choice.hidden = false;

    return new Promise(resolve => {
      const finish = value => { choice.hidden = true; resolve(value); };
      choice.querySelector('[data-drop-copy]').onclick = () => finish('copy');
      choice.querySelector('[data-drop-browse]').onclick = () => finish('browse');
      choice.querySelector('[data-drop-protect]').onclick = () => finish('protect');
      choice.querySelector('.client-drop-choice-close').onclick = () => finish('cancel');
    });
  }

  function priorText(source) {
    return [source.sourceName, source.path].filter(Boolean).join(' · ') || 'Existing object';
  }

  function queryValue(value) {
    return String(value || '').replaceAll('"', '').trim();
  }

  function showDroppedFiles(files) {
    const directory = commonDirectory(files);
    const query = directory ? `path:"${queryValue(directory)}"` : files.length === 1 ? `name:"${queryValue(files[0].file.name)}"` : '';
    if (query) window.mochimonoSearch?.setRaw(query);
    const sort = document.querySelector('#sort');
    if (sort && sort.value !== 'date-added') {
      sort.value = 'date-added';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function liveFile(data, item, importId, addedAt) {
    const base = {
      hash: data.hash,
      filename: data.name,
      originalPath: data.path,
      searchText: `${data.name} ${data.path}`,
      addedAt,
      exactImportIds: String(importId)
    };
    if (data.existing) return base;
    return {
      ...base,
      size: data.size,
      mime: item.file.type || 'application/octet-stream',
      fileDate: new Date(item.file.lastModified || Date.now()).toISOString(),
      createdAt: addedAt,
      importIds: [importId],
      reviewed: false,
      backupCount: 0
    };
  }

  let liveTimer = 0;
  let livePending = [];

  function visibleAnchor() {
    if (scrollY <= 4) return null;
    const bottom = document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0;
    const card = [...document.querySelectorAll('#files [data-hash]')].find(item => item.getBoundingClientRect().bottom > bottom + 1);
    return card ? { hash: card.dataset.hash, top: card.getBoundingClientRect().top } : null;
  }

  function restoreAnchor(anchor) {
    if (!anchor) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const card = document.querySelector(`#files [data-hash="${CSS.escape(anchor.hash)}"]`);
      if (!card) return;
      const delta = card.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > .5) scrollBy(0, delta);
    }));
  }

  function flushLive() {
    clearTimeout(liveTimer);
    liveTimer = 0;
    if (!livePending.length) return;
    const batch = livePending;
    livePending = [];
    const anchor = visibleAnchor();
    for (const file of batch) window.mochimonoFileDates?.set(file.hash, { fileDate: file.fileDate || file.createdAt || file.addedAt, addedAt: file.addedAt });
    window.mochimonoLibrary?.upsertMany?.(batch);
    window.dispatchEvent(new CustomEvent('mochimono-dates-updated'));
    restoreAnchor(anchor);
  }

  function queueLive(file) {
    livePending.push(file);
    if (livePending.length >= 16) return flushLive();
    if (!liveTimer) liveTimer = setTimeout(flushLive, 450);
  }

  async function importDropped(files) {
    if (!files.length) return;
    result.hidden = false;
    result.querySelector('[data-import-title]').textContent = 'Copying to Mochimono';
    result.querySelector('[data-import-bar]').style.width = '0%';
    result.querySelector('[data-import-meta]').textContent = `${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'}`;
    result.querySelector('[data-import-note]').textContent = 'Uploading a separate copy. Local originals are not changed.';
    result.querySelector('[data-import-dupes]').replaceChildren();
    showDroppedFiles(files);

    const label = files.length === 1 ? files[0].path : files[0].path.split('/')[0] || 'Drop';
    const started = await request('/api/client/import/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label })
    });
    const importId = Number(started.importId) || 0;
    const liveStartedAt = Date.now();
    let added = 0;
    let existing = 0;
    let ignored = 0;
    const duplicates = [];

    for (let index = 0; index < files.length; index++) {
      const item = files[index];
      result.querySelector('[data-import-meta]').textContent = `${index + 1} / ${files.length} · ${item.path}`;
      const params = new URLSearchParams({ session: started.session, path: normalizePath(item.path), mtime: new Date(item.file.lastModified || Date.now()).toISOString() });
      const data = await request(`/api/client/import/file?${params}`, {
        method: 'PUT', headers: { 'x-mochimono-file-mime': item.file.type || 'application/octet-stream' }, body: item.file
      });
      if (data.ignored) ignored++;
      else {
        const addedAt = new Date(liveStartedAt - index).toISOString();
        queueLive(liveFile(data, item, importId, addedAt));
        if (data.existing) { existing++; duplicates.push(data); }
        else added++;
      }
      result.querySelector('[data-import-bar]').style.width = `${(index + 1) / files.length * 100}%`;
    }

    flushLive();
    try { await window.mochimonoLibrary?.refresh?.(); } catch {}
    const handled = added + existing + ignored;
    result.querySelector('[data-import-title]').textContent = 'Copied to Mochimono';
    const parts = [`${handled.toLocaleString()} / ${files.length.toLocaleString()}`, `${added.toLocaleString()} new`];
    if (ignored) parts.push(`${ignored.toLocaleString()} ignored`);
    result.querySelector('[data-import-meta]').textContent = parts.join(' · ');
    result.querySelector('[data-import-note]').textContent = 'Local originals unchanged · one-time copy · not watched.';

    const duplicateBox = result.querySelector('[data-import-dupes]');
    duplicateBox.innerHTML = duplicates.length ? `
      <div class="client-import-examples">Already here</div>
      ${duplicates.map(item => {
        const prior = item.previous?.[0];
        return `<div class="client-import-dupe"><b>${esc(item.name)}</b><span>${esc(prior ? priorText(prior) : 'Same file already stored')}</span></div>`;
      }).join('')}` : '';
  }

  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    target.classList.add('show');
    event.preventDefault();
  });
  document.addEventListener('dragover', event => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.dataTransfer.dropEffect = 'copy';
    target.classList.add('show');
    event.preventDefault();
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) target.classList.remove('show');
  });
  document.addEventListener('drop', async event => {
    if (!event.dataTransfer?.files?.length && !event.dataTransfer?.items?.length) return;
    event.preventDefault();
    dragDepth = 0;
    target.classList.remove('show');
    try {
      const files = await droppedFiles(event.dataTransfer);
      if (!files.length) return;
      const intent = await chooseIntent(files);
      if (intent === 'copy') await importDropped(files);
      else if (intent === 'browse' || intent === 'protect') window.parent.postMessage({
        type: 'mochimono-folder-intent',
        mode: intent,
        hint: droppedFolderHint(files)
      }, location.origin);
    } catch (error) {
      flushLive();
      result.hidden = false;
      result.querySelector('[data-import-title]').textContent = 'Could not add files';
      result.querySelector('[data-import-meta]').textContent = error.message;
      result.querySelector('[data-import-note]').textContent = '';
      result.querySelector('[data-import-bar]').style.width = '0%';
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !choice.hidden) choice.querySelector('.client-drop-choice-close').click();
  });
}
