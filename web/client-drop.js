import './client-bridge.js';

if (location.pathname.startsWith('/files')) {
  const style = document.createElement('style');
  style.textContent = `
    .client-drop-target{position:fixed;inset:12px;z-index:80;display:grid;place-items:center;border:2px dashed rgba(239,160,154,.55);border-radius:18px;background:rgba(13,12,14,.9);color:#f4eeea;font:700 22px/1.2 Inter,system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .12s}
    .client-drop-target.show{opacity:1}
    .client-import-result{position:fixed;z-index:81;right:18px;bottom:18px;width:min(430px,calc(100vw - 36px));padding:13px 14px;border:1px solid #302b30;border-radius:12px;background:#171518;color:#f4eeea;box-shadow:0 18px 60px rgba(0,0,0,.5);font:12px/1.4 Inter,system-ui,sans-serif}
    .client-import-result[hidden]{display:none!important}.client-import-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.client-import-head strong{font-size:13px}.client-import-close{border:0;background:transparent;color:#8f8583;font-size:18px;cursor:pointer}.client-import-progress{height:4px;margin:9px 0 6px;border-radius:999px;background:#292529;overflow:hidden}.client-import-progress i{display:block;height:100%;background:#efa09a;transition:width .15s}.client-import-meta{color:#aaa19e}.client-import-dupes{max-height:150px;margin-top:8px;overflow:auto}.client-import-examples{padding:5px 0;color:#817876;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.client-import-dupe{padding:6px 0;border-top:1px solid #262326}.client-import-dupe b{display:block;color:#e7dfdc;font-weight:650}.client-import-dupe span{display:block;color:#8f8583;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  `;
  document.head.append(style);

  const target = document.createElement('div');
  target.className = 'client-drop-target';
  target.textContent = 'Drop to add to Mochimono';
  document.body.append(target);

  const result = document.createElement('div');
  result.className = 'client-import-result';
  result.hidden = true;
  result.innerHTML = `
    <div class="client-import-head"><strong data-import-title>Adding files</strong><button class="client-import-close" aria-label="Close">×</button></div>
    <div class="client-import-progress"><i data-import-bar></i></div>
    <div class="client-import-meta" data-import-meta></div>
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
    const nested = await Promise.all(children.map(child => entryFiles(child, root)));
    return nested.flat();
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
          if (handle) {
            gathered.push(...await handleFiles(handle));
            continue;
          }
        }
      } catch {}
      try {
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          gathered.push(...await entryFiles(entry));
          continue;
        }
      } catch {}
      const file = item.getAsFile?.();
      if (file) gathered.push({ file, path: file.webkitRelativePath || file.name });
    }
    if (!gathered.length) {
      for (const file of dataTransfer.files || []) gathered.push({ file, path: file.webkitRelativePath || file.name });
    }
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

  function priorText(source) {
    const where = [source.sourceName, source.path].filter(Boolean).join(' · ');
    return where || 'Existing object';
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

  function queryValue(value) {
    return String(value || '').replaceAll('"', '').trim();
  }

  function showDroppedFiles(files) {
    window.mochimonoAddedBatch?.clear?.();
    const directory = commonDirectory(files);
    const query = directory
      ? `path:"${queryValue(directory)}"`
      : files.length === 1
        ? `name:"${queryValue(files[0].file.name)}"`
        : '';
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
    for (const file of batch) {
      window.mochimonoFileDates?.set(file.hash, { fileDate: file.fileDate || file.createdAt || file.addedAt, addedAt: file.addedAt });
    }
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
    result.querySelector('[data-import-title]').textContent = 'Adding files';
    result.querySelector('[data-import-bar]').style.width = '0%';
    result.querySelector('[data-import-meta]').textContent = `${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'}`;
    result.querySelector('[data-import-dupes]').replaceChildren();
    showDroppedFiles(files);

    const label = files.length === 1 ? files[0].path : files[0].path.split('/')[0] || 'Drop';
    const started = await request('/api/client/import/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label })
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
      const params = new URLSearchParams({
        session: started.session,
        path: normalizePath(item.path),
        mtime: new Date(item.file.lastModified || Date.now()).toISOString()
      });
      const data = await request(`/api/client/import/file?${params}`, {
        method: 'PUT',
        headers: { 'x-mochimono-file-mime': item.file.type || 'application/octet-stream' },
        body: item.file
      });
      if (data.ignored) ignored++;
      else {
        // During the live view, keep upload order stable: each later file sorts
        // just after the previous one instead of repeatedly jumping to the top.
        const addedAt = new Date(liveStartedAt - index).toISOString();
        queueLive(liveFile(data, item, importId, addedAt));
        if (data.existing) {
          existing++;
          duplicates.push(data);
        } else added++;
      }
      result.querySelector('[data-import-bar]').style.width = `${(index + 1) / files.length * 100}%`;
    }

    flushLive();
    try { await window.mochimonoLibrary?.refresh?.(); } catch {}

    const total = files.length;
    const handled = added + existing + ignored;
    result.querySelector('[data-import-title]').textContent = 'Added to Mochimono';
    const parts = [`${handled.toLocaleString()} / ${total.toLocaleString()}`, `${added.toLocaleString()} new`];
    if (ignored) parts.push(`${ignored.toLocaleString()} ignored`);
    result.querySelector('[data-import-meta]').textContent = parts.join(' · ');

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
      await importDropped(await droppedFiles(event.dataTransfer));
    } catch (error) {
      flushLive();
      result.hidden = false;
      result.querySelector('[data-import-title]').textContent = 'Import failed';
      result.querySelector('[data-import-meta]').textContent = error.message;
      result.querySelector('[data-import-bar]').style.width = '0%';
    }
  });
}
