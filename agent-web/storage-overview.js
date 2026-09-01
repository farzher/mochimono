const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const backups = document.querySelector('#backups');
const filesFrame = document.querySelector('#filesFrame');
const storageToggle = document.querySelector('[data-client-tab="storage"]');

if (storagePane) {
  const style = document.createElement('style');
  style.textContent = `
    #storagePane{width:min(980px,calc(100% - 42px));padding-top:20px;gap:34px}
    body.storage-page-active .client-storage{display:none!important}

    .storage-overview{display:grid;gap:12px;margin-bottom:3px}
    .storage-page-title{margin:0 0 4px;font-size:22px;line-height:1;letter-spacing:-.035em}
    .storage-glance-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
    .storage-glance-card{position:relative;min-width:0;min-height:112px;padding:18px;border:1px solid #29262a;border-radius:16px;background:#151316;color:inherit;text-align:left;box-shadow:none;overflow:hidden}
    .storage-glance-card:hover{background:#1a171b;border-color:#3a343b}
    .storage-glance-card:focus-visible,.storage-quick-card:focus-visible{outline:2px solid rgba(239,160,154,.38);outline-offset:2px}
    .storage-glance-card span{display:block;color:#8b8280;font-size:11px;font-weight:680}
    .storage-glance-card strong{display:block;margin-top:9px;color:#f0e9e5;font-size:27px;font-weight:720;line-height:1;letter-spacing:-.045em}
    .storage-glance-card.backups strong{color:#c6ddcb}
    .storage-card-alert{position:absolute;top:12px;right:12px;min-width:21px;height:21px;display:grid!important;place-items:center;padding:0 6px;border-radius:999px;background:rgba(221,129,122,.13);color:#e89a94!important;font-size:10px!important;font-weight:800!important}

    .storage-quick-row{display:grid;grid-template-columns:1fr 1fr;gap:9px}
    .storage-quick-card{min-width:0;min-height:67px;display:flex;align-items:center;gap:10px;padding:13px 15px;border:1px solid #29262a;border-radius:13px;background:#121113;color:inherit;text-align:left;box-shadow:none}
    .storage-quick-card:hover{background:#181619;border-color:#373238}
    .storage-quick-card strong{font-size:18px;line-height:1;letter-spacing:-.025em}
    .storage-quick-card span{color:#8e8582;font-size:11px;font-weight:650}
    .storage-quick-card.freeable strong{color:#b8d8bf}
    .storage-quick-card.needs strong{color:#ddb879}
    .storage-quick-card.good{cursor:default}.storage-quick-card.good:hover{background:#121113;border-color:#29262a}
    .storage-quick-card.good strong{color:#a9cdb1;font-size:17px}

    .storage-integrity{min-height:42px;display:flex;align-items:center;gap:9px;padding:0 4px;color:#8e8582;font-size:10px}
    .storage-integrity-dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#80c895;box-shadow:0 0 0 3px rgba(128,200,149,.08)}
    .storage-integrity strong{color:#c9c0bd;font-size:11px;font-weight:700}
    .storage-integrity span:not(.storage-integrity-dot){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .storage-integrity.warn .storage-integrity-dot{background:#d7b06d;box-shadow:0 0 0 3px rgba(215,176,109,.08)}
    .storage-integrity.bad .storage-integrity-dot{background:#dd817a;box-shadow:0 0 0 3px rgba(221,129,122,.09)}
    .storage-integrity.bad strong{color:#e3a09a}.storage-integrity.warn strong{color:#d7b987}
    .storage-integrity button{margin-left:auto;width:29px;height:29px;display:grid;place-items:center;padding:0;border-radius:8px;background:transparent;color:#7f7775;font-size:15px;font-weight:500}
    .storage-integrity button:hover{background:#211e22;color:#eee7e3}.storage-integrity button:disabled{opacity:.45}
    .storage-integrity-progress{width:72px;height:3px;overflow:hidden;border-radius:999px;background:#282428}
    .storage-integrity-progress i{display:block;height:100%;border-radius:inherit;background:#d7b06d;transition:width .15s ease}

    #storagePane>.dashboard-section{display:grid;gap:8px}
    #storagePane .section-head{min-height:32px;border:0;padding:0 2px}
    #storagePane .section-head h2{color:#9c9290;font-size:12px;font-weight:720;letter-spacing:.01em}
    #storagePane .round-action{width:29px;height:29px;border-radius:8px;font-size:17px}
    #storagePane .item-list{display:grid;gap:7px}
    #storagePane .storage-item{grid-template-columns:minmax(0,1fr) auto;gap:12px;min-height:69px;padding:12px 13px;border:1px solid #252226!important;border-radius:13px;background:#121113}
    #storagePane .storage-item:hover{background:#171518;border-color:#302b31!important}
    #storagePane .storage-copy{cursor:pointer}
    #storagePane .storage-title{gap:8px}
    #storagePane .storage-title strong{font-size:13px;font-weight:700;color:#ddd5d1}
    #storagePane .storage-path{display:none!important}
    #storagePane .storage-meta{margin-top:5px;gap:0;color:#817977;font-size:11px}
    #storagePane .folder-item .storage-meta span,#storagePane .backup-item .storage-meta span{display:none!important}
    #storagePane .folder-item .storage-meta span:nth-child(3),#storagePane .backup-item .storage-meta span:nth-child(5){display:inline!important}
    #storagePane .folder-item .item-state{display:none!important}
    #storagePane .backup-item .item-state.good{width:7px;height:7px;margin-left:auto;border-radius:50%;background:#80c895;font-size:0;box-shadow:0 0 0 3px rgba(128,200,149,.07)}
    #storagePane .backup-item .item-state:not(.good){font-size:10px}
    #storagePane .storage-meter{height:3px;margin-top:9px;background:#242125}
    #storagePane .storage-mode{width:7px;height:7px;padding:0;border-radius:50%;font-size:0}
    #storagePane .storage-mode.protected{background:#d89b95}.storage-mode.local{background:#787b84}
    #storagePane .folder-protection{display:none!important}
    #storagePane .item-actions{width:auto;gap:1px;opacity:.35}
    #storagePane .storage-item:hover .item-actions,#storagePane .storage-item:focus-within .item-actions{opacity:1}
    #storagePane .item-actions .action-link,#storagePane .item-actions .icon{width:30px;height:30px;display:grid;place-items:center;padding:0;border-radius:8px;color:#8e8582}
    #storagePane .item-actions .action-link:hover,#storagePane .item-actions .icon:hover{background:#252126;color:#fff}
    #storagePane [data-sync-folder],#storagePane [data-update],#storagePane [data-restore],#storagePane [data-verify],#storagePane [data-configure],#storagePane [data-protect-folder]{font-size:0}
    #storagePane [data-sync-folder]::before,#storagePane [data-update]::before{content:'↻';font-size:16px;font-weight:500}
    #storagePane [data-restore]::before{content:'↥';font-size:16px;font-weight:500}
    #storagePane [data-verify]::before{content:'✓';font-size:14px;font-weight:750}
    #storagePane [data-configure]::before{content:'⋯';font-size:18px;font-weight:700;line-height:1}
    #storagePane [data-protect-folder]::before{content:'＋';font-size:16px;font-weight:500}
    #storagePane .item-progress{margin-top:9px;padding-top:8px}

    #storagePane .folder-add,#storagePane .inline-add{padding:10px;border:1px solid #282429;border-radius:12px;background:#121113}
    #storagePane .folder-add{border-bottom:1px solid #282429}
    #storagePane .folder-mode-options{margin-top:7px}
    #storagePane .folder-mode-option{padding:10px 12px;border-radius:9px;text-align:center}
    #storagePane .folder-mode-option strong{font-size:11px}
    #storagePane .folder-mode-option span,#storagePane .folder-mode-note{display:none}
    #storagePane .empty-state,#storagePane .muted{padding:18px 4px;color:#696261;font-size:11px}
    #storagePane .background-work{margin:0;padding:0 3px}

    @media(max-width:700px){
      #storagePane{width:min(100% - 20px,980px);padding-top:12px;gap:27px}
      .storage-page-title{font-size:20px}
      .storage-glance-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
      .storage-glance-card{min-height:91px;padding:13px 11px;border-radius:13px}
      .storage-glance-card span{font-size:9px}.storage-glance-card strong{margin-top:8px;font-size:20px}
      .storage-quick-row{gap:6px}.storage-quick-card{min-height:58px;padding:11px 12px}.storage-quick-card strong{font-size:16px}.storage-quick-card span{font-size:9px}
      #storagePane .storage-item{grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:11px;border-radius:12px}
      #storagePane .item-actions{opacity:.65;justify-content:flex-end;flex-wrap:nowrap}
      #storagePane .backup-actions{flex-wrap:nowrap}
      #storagePane .inline-add{grid-template-columns:1fr auto auto}
      #storagePane .inline-add input{grid-column:auto}
    }
    @media(max-width:440px){
      .storage-glance-card strong{font-size:18px}.storage-glance-card span{font-size:8px}
      .storage-quick-card{gap:7px;padding:10px}.storage-quick-card strong{font-size:15px}
      #storagePane .storage-title strong{font-size:12px}
    }
  `;
  document.head.append(style);

  const section = document.createElement('section');
  section.className = 'storage-overview';
  section.innerHTML = '<h2 class="storage-page-title">Storage</h2><div data-storage-overview><div class="muted">Loading…</div></div><div data-integrity-overview></div>';
  storagePane.prepend(section);
  const target = section.querySelector('[data-storage-overview]');
  const integrityTarget = section.querySelector('[data-integrity-overview]');

  let refreshing = false;
  let lastRefresh = 0;
  let lastKey = '';
  let lastVersion = '';
  let integrityTimer = 0;
  let integrityWasRunning = false;

  function bytes(number) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = Number(number) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function age(value) {
    if (!value) return '';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return '';
    const days = Math.max(0, Math.floor((Date.now() - time) / 86400000));
    if (days < 1) return 'today';
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    const years = days / 365;
    return `${years < 2 ? years.toFixed(1) : Math.floor(years)}y`;
  }

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  async function json(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${response.status}`);
    return data;
  }

  async function catalog() {
    const files = [];
    let after = '';
    do {
      const page = await json(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`);
      files.push(...(page.files || []));
      after = page.nextAfter || '';
    } while (after);
    return files;
  }

  async function badPrimaryHashes() {
    const hashes = new Set();
    let after = '';
    try {
      do {
        const page = await json(`/api/integrity/bad?limit=5000&after=${encodeURIComponent(after)}`);
        for (const object of page.objects || []) hashes.add(object.hash);
        after = page.nextAfter || '';
      } while (after);
    } catch {}
    return hashes;
  }

  async function driveFiles(id) {
    const files = [];
    let after = '';
    do {
      const page = await json(`/api/drives/${encodeURIComponent(id)}/files?limit=5000&after=${encodeURIComponent(after)}`);
      files.push(...(page.files || []));
      after = page.nextAfter || '';
    } while (after);
    return files;
  }

  async function openLibraryWhere(value) {
    const locations = filesFrame?.contentWindow?.mochimonoLocations;
    if (!locations?.select) return;
    await locations.select(value);
    if (!storagePane.hidden) storageToggle?.click();
    filesFrame?.focus();
  }

  function renderIntegrity(info) {
    const progress = info.progress || {};
    const total = Number(info.total) || 0;
    const bad = Number(info.bad) || 0;
    const catalogBad = info.catalog?.status === 'corrupt';
    const checked = Number(progress.checked || info.checked) || 0;
    const progressTotal = Number(progress.total || total) || 0;
    let className = '';
    let state = 'Healthy';
    let meta = info.lastScrubAt ? age(info.lastScrubAt) : '';
    let title = `Storage integrity: ${total.toLocaleString()} objects`;
    let progressHtml = '';

    if (info.running) {
      className = 'warn';
      const percent = progressTotal ? Math.max(0, Math.min(100, checked / progressTotal * 100)) : 0;
      state = progressTotal ? `${Math.round(percent)}%` : 'Checking';
      meta = '';
      progressHtml = `<span class="storage-integrity-progress"><i style="width:${percent}%"></i></span>`;
      title = `Checking storage integrity: ${checked.toLocaleString()} of ${progressTotal.toLocaleString()}`;
    } else if (bad || catalogBad) {
      className = 'bad';
      state = bad ? `${bad.toLocaleString()} damaged` : 'Catalog issue';
      meta = 'Repair needed';
      title = bad ? `${bad.toLocaleString()} damaged objects detected. Verify a healthy backup to repair matching objects.` : 'The Mochimono catalog integrity check failed.';
    } else if (!info.lastScrubAt) {
      className = 'warn';
      state = 'Not checked';
      meta = '';
      title = 'Run a full storage integrity check.';
    } else {
      title = `Healthy · ${total.toLocaleString()} objects · last checked ${age(info.lastScrubAt)}`;
    }

    integrityTarget.innerHTML = `<div class="storage-integrity ${className}" title="${esc(title)}">
      <span class="storage-integrity-dot" aria-hidden="true"></span>
      <strong>${esc(state)}</strong>
      ${meta ? `<span>${esc(meta)}</span>` : ''}
      ${progressHtml}
      <button type="button" data-integrity-scrub ${info.running ? 'disabled' : ''} aria-label="Check storage integrity" title="Check storage integrity">↻</button>
    </div>`;
  }

  async function refreshIntegrity() {
    clearTimeout(integrityTimer);
    if (storagePane.hidden) return;
    try {
      const info = await json('/api/integrity');
      renderIntegrity(info);
      if (integrityWasRunning && !info.running) {
        lastRefresh = 0;
        refresh(true);
        filesFrame?.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {});
      }
      integrityWasRunning = Boolean(info.running);
      integrityTimer = setTimeout(refreshIntegrity, info.running ? 1500 : 15000);
    } catch {
      integrityTarget.innerHTML = '<div class="storage-integrity warn" title="Integrity status unavailable"><span class="storage-integrity-dot"></span><strong>Offline</strong></div>';
      integrityTimer = setTimeout(refreshIntegrity, 15000);
    }
  }

  function statsForLocation(id, rows, byHash, server, verified) {
    let total = 0;
    let safe = 0;
    let needs = 0;
    const hashes = new Set();
    for (const [hash, locationId] of rows) {
      if (locationId !== id) continue;
      const size = Number(byHash.get(hash)?.size) || 0;
      total += size;
      hashes.add(hash);
      if (server.has(hash) && verified.has(hash)) safe += size;
      else needs += size;
    }
    return { files: hashes.size, total, safe, needs };
  }

  function decorateFolders(local, byHash, server, verified) {
    const definitions = new Map((local.locations || []).map(item => [String(item.rootPath || '').replace(/[\\/]+$/, '').toLowerCase(), item]));
    for (const row of folders?.querySelectorAll('[data-folder-path]') || []) {
      row.querySelector('.folder-protection')?.remove();
      const key = String(row.dataset.folderPath || '').replace(/[\\/]+$/, '').toLowerCase();
      const definition = definitions.get(key);
      if (!definition) continue;
      const stats = statsForLocation(definition.id, local.files || [], byHash, server, verified);
      row.classList.toggle('storage-risk', stats.needs > 0);
      const copy = row.querySelector('.storage-copy');
      if (copy) {
        copy.dataset.openWhere = `folder:${definition.id}`;
        copy.title = stats.needs
          ? `${bytes(stats.needs)} needs protection · click to view folder`
          : `${bytes(stats.safe)} protected · click to view folder`;
      }
    }
  }

  function compactRows() {
    const actions = [
      ['[data-sync-folder]', 'Sync folder'],
      ['[data-update]', 'Update backup'],
      ['[data-restore]', 'Restore backup'],
      ['[data-verify]', 'Verify backup'],
      ['[data-configure]', 'Backup settings'],
      ['[data-protect-folder]', 'Protect with Mochimono']
    ];
    for (const [selector, label] of actions) {
      for (const button of storagePane.querySelectorAll(selector)) {
        if (!button.title) button.title = label;
        if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', label);
      }
    }
  }

  async function refresh(force = false) {
    if (refreshing || (!force && Date.now() - lastRefresh < 45_000)) return;
    refreshing = true;
    try {
      const currentVersion = String((await json('/api/catalog/version').catch(() => ({ version: '' }))).version || '');
      if (!force && lastKey && currentVersion && currentVersion === lastVersion) {
        lastRefresh = Date.now();
        return;
      }

      const [files, local, driveData, damaged] = await Promise.all([
        catalog(),
        json('/api/client/locations').catch(() => ({ locations: [], files: [] })),
        json('/api/drives').catch(() => ({ drives: [] })),
        badPrimaryHashes()
      ]);
      const drives = driveData.drives || [];
      const driveRows = await Promise.all(drives.map(async drive => ({ drive, files: await driveFiles(String(drive.id)).catch(() => []) })));
      const byHash = new Map(files.map(file => [file.hash, file]));
      const server = new Set(files.filter(file => file.serverStored !== false && !damaged.has(file.hash)).map(file => file.hash));
      const localHashes = new Set((local.files || []).map(row => row[0]));
      const verified = new Set();
      let backupPhysicalBytes = 0;
      for (const item of driveRows) for (const file of item.files) {
        if (file.verifiedAt) verified.add(file.hash);
        backupPhysicalBytes += Number(byHash.get(file.hash)?.size) || 0;
      }

      let localBytes = 0;
      let safeBytes = 0;
      for (const [hash] of local.files || []) {
        const size = Number(byHash.get(hash)?.size) || 0;
        localBytes += size;
        if (server.has(hash) && verified.has(hash)) safeBytes += size;
      }
      const serverBytes = [...server].reduce((sum, hash) => sum + (Number(byHash.get(hash)?.size) || 0), 0);
      const verifiedBytes = [...verified].reduce((sum, hash) => sum + (Number(byHash.get(hash)?.size) || 0), 0);
      const needsProtection = files.filter(file => !server.has(file.hash) || !verified.has(file.hash));
      const key = JSON.stringify([files.length, localBytes, safeBytes, serverBytes, verifiedBytes, backupPhysicalBytes, needsProtection.length, drives.length, damaged.size]);

      if (key !== lastKey) {
        lastKey = key;
        const localTitle = `${localHashes.size.toLocaleString()} indexed files on this PC`;
        const serverTitle = `${server.size.toLocaleString()} healthy files in Mochimono${damaged.size ? ` · ${damaged.size.toLocaleString()} damaged` : ''}`;
        const backupTitle = `${verified.size.toLocaleString()} unique verified files · ${drives.length.toLocaleString()} backup ${drives.length === 1 ? 'drive' : 'drives'} · ${bytes(backupPhysicalBytes)} stored physically`;
        target.innerHTML = `<div class="storage-glance-grid">
          <button type="button" class="storage-glance-card" data-open-where="local" title="${esc(localTitle)}"><span>This PC</span><strong>${esc(bytes(localBytes))}</strong></button>
          <button type="button" class="storage-glance-card" data-open-where="server" title="${esc(serverTitle)}"><span>Mochimono</span><strong>${esc(bytes(serverBytes))}</strong>${damaged.size ? `<span class="storage-card-alert">${damaged.size.toLocaleString()}</span>` : ''}</button>
          <button type="button" class="storage-glance-card backups" data-open-where="verified-backup" title="${esc(backupTitle)}"><span>Backups</span><strong>${esc(bytes(verifiedBytes))}</strong></button>
        </div>
        <div class="storage-quick-row">
          <button type="button" class="storage-quick-card freeable" data-open-where="safe-local" title="Local data with both a healthy Mochimono copy and a verified backup"><strong>${esc(bytes(safeBytes))}</strong><span>Freeable</span></button>
          ${needsProtection.length
            ? `<button type="button" class="storage-quick-card needs" data-open-where="needs-protection" title="Files that still need another healthy copy"><strong>${needsProtection.length.toLocaleString()}</strong><span>Need protection</span></button>`
            : '<div class="storage-quick-card good" title="All known files meet the current protection rule"><strong>✓</strong><span>Protected</span></div>'}
        </div>`;
      }

      lastVersion = currentVersion || lastVersion;
      decorateFolders(local, byHash, server, verified);
      compactRows();
      lastRefresh = Date.now();
    } catch {
      if (!lastKey) target.innerHTML = '<div class="muted">Storage unavailable</div>';
    } finally {
      refreshing = false;
    }
  }

  function openFromClick(event) {
    const open = event.target.closest('[data-open-where]');
    if (open) openLibraryWhere(open.dataset.openWhere).catch(() => {});
  }

  target.addEventListener('click', openFromClick);
  folders?.addEventListener('click', openFromClick);
  integrityTarget.addEventListener('click', async event => {
    const button = event.target.closest('[data-integrity-scrub]');
    if (!button) return;
    button.disabled = true;
    try {
      await json('/api/integrity/scrub', { method: 'POST' });
      await refreshIntegrity();
    } catch (error) {
      button.disabled = false;
      button.title = error.message;
    }
  });

  new MutationObserver(() => {
    document.body.classList.toggle('storage-page-active', !storagePane.hidden);
    if (!storagePane.hidden) { refresh(true); refreshIntegrity(); compactRows(); }
    else clearTimeout(integrityTimer);
  }).observe(storagePane, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => {
    compactRows();
    if (!storagePane.hidden && lastKey) refresh();
  }).observe(folders, { childList: true, subtree: true });
  new MutationObserver(() => {
    compactRows();
    if (!storagePane.hidden && lastKey) refresh(true);
  }).observe(backups, { childList: true, subtree: true });

  window.addEventListener('focus', () => { if (!storagePane.hidden) { refresh(); refreshIntegrity(); } }, { passive: true });
  setInterval(() => { if (!storagePane.hidden) refresh(); }, 60_000);
  document.body.classList.toggle('storage-page-active', !storagePane.hidden);
  compactRows();
  refresh(true);
  refreshIntegrity();
}