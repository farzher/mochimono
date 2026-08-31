const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');

if (storagePane) {
  const style = document.createElement('style');
  style.textContent = `
    .storage-overview{margin-bottom:18px}.storage-overview .section-head{margin-bottom:9px}
    .storage-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
    .storage-summary-card{min-width:0;padding:12px;border:1px solid #2b272c;border-radius:12px;background:#171518}
    .storage-summary-card>span{display:block;color:#847b79;font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}
    .storage-summary-card>strong{display:block;margin-top:5px;color:#eee7e3;font-size:17px;line-height:1.15}
    .storage-summary-card>small{display:block;margin-top:5px;color:#918885;font-size:10px;line-height:1.4}
    .storage-summary-card.safe>strong{color:#c8dfcd}.storage-summary-card.warn>strong{color:#e1c398}
    .storage-protection-line{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:7px;padding:10px 12px;border:1px solid rgba(126,184,137,.16);border-radius:11px;background:rgba(92,143,102,.06)}
    .storage-protection-line>div{min-width:0}.storage-protection-line strong{display:block;color:#c8dfcd;font-size:12px}.storage-protection-line span{display:block;margin-top:2px;color:#8e8582;font-size:9px;line-height:1.35}.storage-protection-line b{flex:0 0 auto;color:#dce8df;font-size:14px}
    .storage-attention{margin-top:7px;padding:9px 11px;border-radius:10px;background:rgba(255,255,255,.025);color:#918885;font-size:10px}.storage-attention b{color:#d8c09d;font-weight:700}
    .folder-protection{margin-top:5px;color:#817977;font-size:9px}.folder-protection .safe{color:#9ebfa5}.folder-protection .warn{color:#c8a97e}
    @media(max-width:900px){.storage-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:520px){.storage-summary-grid{grid-template-columns:1fr 1fr}.storage-summary-card{padding:10px}.storage-summary-card>strong{font-size:15px}.storage-protection-line{align-items:flex-start;flex-direction:column;gap:4px}}
  `;
  document.head.append(style);

  const section = document.createElement('section');
  section.className = 'dashboard-section storage-overview';
  section.innerHTML = '<div class="section-head"><h2>Storage</h2></div><div data-storage-overview><div class="muted">Loading…</div></div>';
  storagePane.prepend(section);
  const target = section.querySelector('[data-storage-overview]');

  let refreshing = false;
  let lastRefresh = 0;
  let lastKey = '';

  function bytes(number) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = Number(number) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  async function json(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
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
        line = document.createElement('div');
        line.className = 'folder-protection';
        row.querySelector('.storage-copy')?.append(line);
      }
      const parts = [];
      if (stats.safe) parts.push(`<span class="safe">${esc(bytes(stats.safe))} safe to free</span>`);
      if (stats.needs) parts.push(`<span class="warn">${esc(bytes(stats.needs))} needs protection</span>`);
      line.innerHTML = parts.join(' · ') || '<span>Protection status unavailable</span>';
    }
  }

  async function refresh(force = false) {
    if (refreshing || (!force && Date.now() - lastRefresh < 12_000)) return;
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
          <article class="storage-summary-card"><span>This PC</span><strong>${esc(bytes(localBytes))}</strong><small>${localHashes.size.toLocaleString()} indexed files · ${esc(bytes(Math.max(0, safeBytes)))} safe to free</small></article>
          <article class="storage-summary-card"><span>Mochimono</span><strong>${esc(bytes(serverBytes))}</strong><small>${server.size.toLocaleString()} files stored${server.size ? '' : ' · server unavailable or empty'}</small></article>
          <article class="storage-summary-card safe"><span>Verified backups</span><strong>${esc(bytes(verifiedBytes))}</strong><small>${verified.size.toLocaleString()} unique files · ${drives.length.toLocaleString()} backup ${drives.length === 1 ? 'drive' : 'drives'}</small></article>
          <article class="storage-summary-card warn"><span>Needs protection</span><strong>${needsProtection.length.toLocaleString()}</strong><small>${onlyLocal.length.toLocaleString()} only on this PC · ${notLocal.length.toLocaleString()} not on this PC</small></article>
        </div>
        <div class="storage-protection-line"><div><strong>Safe to free from this PC</strong><span>These local files also exist in Mochimono and on at least one verified backup.</span></div><b>${esc(bytes(safeBytes))}</b></div>
        ${needsLocalBytes || onlyLocal.length ? `<div class="storage-attention"><b>${esc(bytes(needsLocalBytes))}</b> on this PC is not yet safe to free${onlyLocal.length ? ` · ${onlyLocal.length.toLocaleString()} ${onlyLocal.length === 1 ? 'file has' : 'files have'} no other known copy` : ''}.</div>` : ''}`;
      }
      decorateFolders(local, byHash, server, verified);
      lastRefresh = Date.now();
    } catch {
      if (!lastKey) target.innerHTML = '<div class="muted">Storage overview unavailable.</div>';
    } finally {
      refreshing = false;
    }
  }

  new MutationObserver(() => {
    if (!storagePane.hidden) refresh(true);
  }).observe(storagePane, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => {
    if (!storagePane.hidden && lastKey) refresh();
  }).observe(folders, { childList: true, subtree: true });
  window.addEventListener('focus', () => { if (!storagePane.hidden) refresh(); }, { passive: true });
  setInterval(() => { if (!storagePane.hidden) refresh(); }, 15_000);
  refresh(true);
}
