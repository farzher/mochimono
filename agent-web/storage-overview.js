const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const filesFrame = document.querySelector('#filesFrame');
const storageToggle = document.querySelector('[data-client-tab="storage"]');

if (storagePane) {
  const style = document.createElement('style');
  style.textContent = `
    .storage-overview{margin-bottom:18px}.storage-overview .section-head{margin-bottom:9px}
    .storage-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
    .storage-summary-card{display:block;min-width:0;width:100%;padding:12px;border:1px solid #2b272c;border-radius:12px;background:#171518;color:inherit;text-align:left;box-shadow:none}
    button.storage-summary-card{cursor:pointer}.storage-summary-card:hover{background:#1d1a1e;border-color:#3a343b}.storage-summary-card:focus-visible{outline:2px solid rgba(239,160,154,.32);outline-offset:1px}
    .storage-summary-card>span{display:block;color:#847b79;font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}
    .storage-summary-card>strong{display:block;margin-top:5px;color:#eee7e3;font-size:17px;line-height:1.15}
    .storage-summary-card>small{display:block;margin-top:5px;color:#918885;font-size:10px;line-height:1.4}
    .storage-summary-card.safe>strong{color:#c8dfcd}.storage-summary-card.warn>strong{color:#e1c398}
    .storage-summary-card em{display:block;margin-top:7px;color:#706966;font-size:9px;font-style:normal;font-weight:700}
    .storage-protection-line{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin-top:7px;padding:10px 12px;border:1px solid rgba(126,184,137,.16);border-radius:11px;background:rgba(92,143,102,.06);color:inherit;text-align:left;box-shadow:none}
    button.storage-protection-line:hover{background:rgba(92,143,102,.1);border-color:rgba(126,184,137,.26)}
    .storage-protection-line>div{min-width:0}.storage-protection-line strong{display:block;color:#c8dfcd;font-size:12px}.storage-protection-line span{display:block;margin-top:2px;color:#8e8582;font-size:9px;line-height:1.35}.storage-protection-line b{flex:0 0 auto;color:#dce8df;font-size:14px}.storage-protection-line em{flex:0 0 auto;color:#8fac96;font-size:9px;font-style:normal}
    .storage-attention{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;margin-top:7px;padding:9px 11px;border:0;border-radius:10px;background:rgba(255,255,255,.025);color:#918885;font-size:10px;text-align:left;box-shadow:none}.storage-attention:hover{background:rgba(255,255,255,.045)}.storage-attention b{color:#d8c09d;font-weight:700}.storage-attention em{flex:0 0 auto;color:#a38e73;font-size:9px;font-style:normal}
    .storage-integrity{display:flex;align-items:center;gap:12px;margin-top:9px;padding:11px 12px;border:1px solid #2b272c;border-radius:11px;background:#151316}.storage-integrity-copy{min-width:0;flex:1}.storage-integrity-copy strong{display:block;color:#ded6d2;font-size:11px}.storage-integrity-copy span{display:block;margin-top:3px;color:#817a77;font-size:9px;line-height:1.4}.storage-integrity-state{flex:0 0 auto;font-size:10px;font-weight:750;color:#9dbca4}.storage-integrity.warn .storage-integrity-state{color:#d1ae7a}.storage-integrity.bad .storage-integrity-state{color:#df9790}.storage-integrity button{flex:0 0 auto;padding:6px 9px;border-radius:8px;background:#272328;color:#cfc6c2;font-size:9px}.storage-integrity button:hover{background:#312c32}.storage-integrity button:disabled{opacity:.55;cursor:default}
    .folder-protection{display:inline-flex;align-items:center;gap:3px;margin-top:5px;padding:0;border:0;border-radius:0;background:transparent;color:#817977;font-size:9px;font-weight:500;text-align:left;box-shadow:none}.folder-protection:hover{background:transparent;color:#aaa09d}.folder-protection .safe{color:#9ebfa5}.folder-protection .warn{color:#c8a97e}.folder-protection:after{content:'›';margin-left:3px;color:#655e5d}
    @media(max-width:900px){.storage-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:520px){.storage-summary-grid{grid-template-columns:1fr 1fr}.storage-summary-card{padding:10px}.storage-protection-line{align-items:flex-start;flex-wrap:wrap;gap:4px}.storage-protection-line em{margin-left:auto}.storage-integrity{align-items:flex-start;flex-wrap:wrap}.storage-integrity-state{margin-left:auto}}
  `;
  document.head.append(style);

  const section = document.createElement('section');
  section.className = 'dashboard-section storage-overview';
  section.innerHTML = '<div class="section-head"><h2>Storage</h2></div><div data-storage-overview><div class="muted">Loading…</div></div><div data-integrity-overview></div>';
  storagePane.prepend(section);
  const target = section.querySelector('[data-storage-overview]');
  const integrityTarget = section.querySelector('[data-integrity-overview]');

  let refreshing = false;
  let lastRefresh = 0;
  let lastKey = '';
  let integrityTimer = 0;

  function bytes(number) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = Number(number) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function age(value) {
    if (!value) return 'never';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 'unknown';
    const days = Math.max(0, Math.floor((Date.now() - time) / 86400000));
    if (days < 1) return 'today';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    const years = days / 365;
    return `${years < 2 ? years.toFixed(1) : Math.floor(years)}y ago`;
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
    const checked = Number(info.checked) || 0;
    const total = Number(info.total) || 0;
    const bad = Number(info.bad) || 0;
    const catalogBad = info.catalog?.status === 'corrupt';
    let className = '';
    let state = 'Healthy';
    let detail = '';

    if (info.running) {
      className = 'warn';
      state = `Checking ${Number(progress.checked || 0).toLocaleString()} / ${Number(progress.total || total).toLocaleString()}`;
      detail = `SHA-256 scrub running${progress.current ? ` · ${String(progress.current).slice(0, 12)}…` : ''}`;
    } else if (bad || catalogBad) {
      className = 'bad';
      state = bad ? `${bad.toLocaleString()} damaged` : 'Catalog problem';
      detail = `${checked.toLocaleString()} of ${total.toLocaleString()} objects checked · last full scrub ${age(info.lastScrubAt)}${bad ? ' · connect a healthy backup and Verify it to repair matching objects' : ''}${catalogBad ? ' · SQLite catalog check failed' : ''}`;
    } else if (!info.lastScrubAt) {
      className = 'warn';
      state = 'Not scrubbed yet';
      detail = `${checked.toLocaleString()} of ${total.toLocaleString()} objects have verified hashes · run a full scrub to establish storage health`;
    } else {
      state = `${total.toLocaleString()} objects healthy`;
      detail = `Full SHA-256 scrub ${age(info.lastScrubAt)} · catalog ${info.catalog?.status === 'healthy' ? 'healthy' : 'not checked'}`;
    }

    integrityTarget.innerHTML = `<div class="storage-integrity ${className}">
      <div class="storage-integrity-copy"><strong>Mochimono integrity</strong><span>${esc(detail)}</span></div>
      <div class="storage-integrity-state">${esc(state)}</div>
      <button type="button" data-integrity-scrub ${info.running ? 'disabled' : ''}>${info.lastScrubAt ? 'Scrub again' : 'Check now'}</button>
    </div>`;
  }

  async function refreshIntegrity() {
    clearTimeout(integrityTimer);
    if (storagePane.hidden) return;
    try {
      const info = await json('/api/integrity');
      renderIntegrity(info);
      integrityTimer = setTimeout(refreshIntegrity, info.running ? 1500 : 15000);
    } catch {
      integrityTarget.innerHTML = '<div class="storage-integrity warn"><div class="storage-integrity-copy"><strong>Mochimono integrity</strong><span>Integrity status unavailable until the server is updated and connected.</span></div><div class="storage-integrity-state">Unavailable</div></div>';
      integrityTimer = setTimeout(refreshIntegrity, 15000);
    }
  }

  function statsForLocation(id, rows, byHash, server, verified) {
    const here = rows.filter(row => row[1] === id);
    let total = 0;
    let safe = 0;
    let needs = 0;
    const hashes = new Set();
    for (const [hash] of here) {
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
      const key = String(row.dataset.folderPath || '').replace(/[\\/]+$/, '').toLowerCase();
      const definition = definitions.get(key);
      if (!definition) continue;
      const stats = statsForLocation(definition.id, local.files || [], byHash, server, verified);
      let line = row.querySelector('.folder-protection');
      if (!line) {
        line = document.createElement('button');
        line.type = 'button';
        line.className = 'folder-protection';
        row.querySelector('.storage-copy')?.append(line);
      }
      line.dataset.openWhere = `folder:${definition.id}`;
      line.title = 'View this folder in the library';
      const parts = [];
      if (stats.safe) parts.push(`<span class="safe">${esc(bytes(stats.safe))} safe to free</span>`);
      if (stats.needs) parts.push(`<span class="warn">${esc(bytes(stats.needs))} needs protection</span>`);
      line.innerHTML = parts.join(' · ') || '<span>Protection status unavailable</span>';
    }
  }

  async function refresh(force = false) {
    if (refreshing || (!force && Date.now() - lastRefresh < 45_000)) return;
    refreshing = true;
    try {
      const [files, local, driveData] = await Promise.all([
        catalog(),
        json('/api/client/locations').catch(() => ({ locations: [], files: [] })),
        json('/api/drives').catch(() => ({ drives: [] }))
      ]);
      const drives = driveData.drives || [];
      const driveRows = await Promise.all(drives.map(async drive => ({
        drive,
        files: await driveFiles(String(drive.id)).catch(() => [])
      })));
      const byHash = new Map(files.map(file => [file.hash, file]));
      const server = new Set(files.filter(file => file.serverStored !== false).map(file => file.hash));
      const localHashes = new Set((local.files || []).map(row => row[0]));
      const verified = new Set();
      const backed = new Set();
      let backupPhysicalBytes = 0;
      for (const item of driveRows) for (const file of item.files) {
        backed.add(file.hash);
        if (file.verifiedAt) verified.add(file.hash);
        backupPhysicalBytes += Number(byHash.get(file.hash)?.size) || 0;
      }

      let localBytes = 0;
      let safeBytes = 0;
      let needsLocalBytes = 0;
      for (const [hash] of local.files || []) {
        const size = Number(byHash.get(hash)?.size) || 0;
        localBytes += size;
        if (server.has(hash) && verified.has(hash)) safeBytes += size;
        else needsLocalBytes += size;
      }
      const serverBytes = [...server].reduce((sum, hash) => sum + (Number(byHash.get(hash)?.size) || 0), 0);
      const verifiedBytes = [...verified].reduce((sum, hash) => sum + (Number(byHash.get(hash)?.size) || 0), 0);
      const onlyLocal = [...localHashes].filter(hash => !server.has(hash) && !backed.has(hash));
      const needsProtection = files.filter(file => !server.has(file.hash) || !verified.has(file.hash));
      const notLocal = files.filter(file => !localHashes.has(file.hash));
      const key = JSON.stringify([files.length, localBytes, safeBytes, serverBytes, verifiedBytes, backupPhysicalBytes, onlyLocal.length, needsProtection.length, drives.length]);

      if (key !== lastKey) {
        lastKey = key;
        target.innerHTML = `<div class="storage-summary-grid">
          <button type="button" class="storage-summary-card" data-open-where="local"><span>This PC</span><strong>${esc(bytes(localBytes))}</strong><small>${localHashes.size.toLocaleString()} indexed files · ${esc(bytes(Math.max(0, safeBytes)))} safe to free</small><em>View files →</em></button>
          <button type="button" class="storage-summary-card" data-open-where="server"><span>Mochimono</span><strong>${esc(bytes(serverBytes))}</strong><small>${server.size.toLocaleString()} healthy files stored${server.size ? '' : ' · server unavailable or empty'}</small><em>View files →</em></button>
          <button type="button" class="storage-summary-card safe" data-open-where="verified-backup"><span>Verified backups</span><strong>${esc(bytes(verifiedBytes))}</strong><small>${verified.size.toLocaleString()} unique files · ${drives.length.toLocaleString()} backup ${drives.length === 1 ? 'drive' : 'drives'}</small><em>View files →</em></button>
          <button type="button" class="storage-summary-card warn" data-open-where="needs-protection"><span>Needs protection</span><strong>${needsProtection.length.toLocaleString()}</strong><small>${onlyLocal.length.toLocaleString()} only on this PC · ${notLocal.length.toLocaleString()} not on this PC</small><em>Review →</em></button>
        </div>
        <button type="button" class="storage-protection-line" data-open-where="safe-local"><div><strong>Safe to free from this PC</strong><span>These local files also exist in healthy Mochimono storage and on at least one verified backup.</span></div><b>${esc(bytes(safeBytes))}</b><em>Review →</em></button>
        ${needsLocalBytes || onlyLocal.length ? `<button type="button" class="storage-attention" data-open-where="local-needs"><span><b>${esc(bytes(needsLocalBytes))}</b> on this PC is not yet safe to free${onlyLocal.length ? ` · ${onlyLocal.length.toLocaleString()} ${onlyLocal.length === 1 ? 'file has' : 'files have'} no other known copy` : ''}.</span><em>Review →</em></button>` : ''}`;
      }
      decorateFolders(local, byHash, server, verified);
      lastRefresh = Date.now();
    } catch {
      if (!lastKey) target.innerHTML = '<div class="muted">Storage overview unavailable.</div>';
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
    if (!storagePane.hidden) { refresh(true); refreshIntegrity(); }
    else clearTimeout(integrityTimer);
  }).observe(storagePane, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => {
    if (!storagePane.hidden && lastKey) refresh();
  }).observe(folders, { childList: true, subtree: true });
  window.addEventListener('focus', () => { if (!storagePane.hidden) { refresh(); refreshIntegrity(); } }, { passive: true });
  setInterval(() => { if (!storagePane.hidden) refresh(); }, 60_000);
  refresh(true);
  refreshIntegrity();
}
