const folderByPath = new Map();
let backups = [];
let integrity = null;

const style = document.createElement('style');
style.textContent = `
  .storage-events{display:flex;align-items:center;flex-wrap:wrap;gap:0;margin-top:6px;color:#746d6b;font-size:9px;font-weight:550;line-height:1.35}
  .storage-event{white-space:nowrap}
  .storage-event+.storage-event::before{content:'·';margin:0 6px;color:#4f4a49}
  .storage-event.warning{color:#c2a270}
  .storage-integrity [data-integrity-relative]{color:#817977;font-size:10px;font-weight:550}
`;
document.head.append(style);

function cleanPath(value) {
  return String(value || '').replace(/[\\/]+$/, '').toLowerCase();
}

function exactTime(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function relativeTime(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '';
  const delta = Math.round((Date.now() - date.getTime()) / 1000);
  const future = delta < 0;
  const seconds = Math.abs(delta);
  const units = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second']
  ];
  const [size, name] = units.find(([size]) => seconds >= size) || units.at(-1);
  const amount = Math.floor(seconds / size);
  const text = `${amount} ${name}${amount === 1 ? '' : 's'}`;
  return future ? `in ${text}` : `${text} ago`;
}

function placeEvents(row, container) {
  const copy = row.querySelector('.storage-copy');
  if (!copy) return;
  const stats = copy.querySelector('.material-row-stats');
  if (stats) {
    if (container.previousElementSibling !== stats) stats.after(container);
    return;
  }
  const progress = copy.querySelector('[data-item-progress]');
  if (container.parentElement !== copy || container.nextElementSibling !== progress) copy.insertBefore(container, progress || null);
}

function setEvents(row, events) {
  if (!row) return;
  let container = row.querySelector(':scope .storage-events');
  if (!events.length) {
    container?.remove();
    return;
  }
  if (!container) {
    container = document.createElement('div');
    container.className = 'storage-events';
  }
  placeEvents(row, container);

  const used = new Set();
  for (const event of events) {
    used.add(event.key);
    let label = container.querySelector(`[data-event-key="${event.key}"]`);
    if (!label) {
      label = document.createElement('span');
      label.className = 'storage-event';
      label.dataset.eventKey = event.key;
      container.append(label);
    }
    label.classList.toggle('warning', Boolean(event.warning));
    const relative = event.value ? relativeTime(event.value) : '';
    const text = event.value ? `${event.label} ${relative}` : event.text;
    if (label.textContent !== text) label.textContent = text;
    const exact = event.value ? exactTime(event.value) : '';
    const title = exact ? `${event.label}: ${exact}` : event.title || '';
    if (label.title !== title) label.title = title;
  }

  for (const label of container.querySelectorAll('[data-event-key]')) {
    if (!used.has(label.dataset.eventKey)) label.remove();
  }
}

function renderFolderTimes() {
  for (const row of document.querySelectorAll('#folders [data-folder-path]')) {
    const folder = folderByPath.get(cleanPath(row.dataset.folderPath));
    if (!folder) continue;
    const protectedFolder = folder.protected !== false;
    setEvents(row, [{
      key: 'folder-sync',
      label: protectedFolder ? 'Synced' : 'Indexed',
      value: protectedFolder ? folder.lastSynced || null : folder.lastIndexed || null,
      text: protectedFolder ? 'Not synced yet' : 'Not indexed yet'
    }]);
  }
}

function renderBackupTimes() {
  for (const row of document.querySelectorAll('#backups [data-backup-index]')) {
    const location = backups[Number(row.dataset.backupIndex)];
    if (!location) continue;
    const meta = location.meta || {};
    const verifyIssues = (Number(meta.lastVerifyBad) || 0) > 0 || meta.lastVerifyCatalogHealthy === false;
    setEvents(row, [
      {
        key: 'backup-update',
        label: 'Updated',
        value: meta.lastBackupAt || null,
        text: 'Never updated'
      },
      {
        key: 'backup-verify',
        label: verifyIssues ? 'Checked' : 'Verified',
        value: meta.lastVerifiedAt || null,
        text: verifyIssues ? 'Verification needs attention' : 'Not verified yet',
        warning: verifyIssues || !meta.lastVerifiedAt
      }
    ]);
  }
}

function renderIntegrityTime() {
  const row = document.querySelector('[data-integrity-overview] .storage-integrity');
  if (!row || !integrity || integrity.running) return;
  const bad = Number(integrity.bad) || 0;
  const catalogBad = integrity.catalog?.status === 'corrupt';
  if (bad || catalogBad || !integrity.lastScrubAt) return;

  let label = row.querySelector(':scope > [data-integrity-relative]');
  if (!label) {
    label = row.querySelector(':scope > span:not(.storage-integrity-dot):not(.storage-integrity-progress)');
    if (!label) {
      label = document.createElement('span');
      row.querySelector('button')?.before(label);
    }
    label.dataset.integrityRelative = '';
  }
  const text = `Checked ${relativeTime(integrity.lastScrubAt)}`;
  if (label.textContent !== text) label.textContent = text;
  label.title = `Full integrity check: ${exactTime(integrity.lastScrubAt)}`;
}

function renderTimes() {
  renderFolderTimes();
  renderBackupTimes();
  renderIntegrityTime();
}

async function refreshTimes() {
  const [stateResult, folderStatsResult, backupResult, integrityResult] = await Promise.allSettled([
    fetch('/api/state', { cache: 'no-store' }).then(response => response.ok ? response.json() : null),
    fetch('/api/folder-stats', { cache: 'no-store' }).then(response => response.ok ? response.json() : null),
    fetch('/api/backups', { cache: 'no-store' }).then(response => response.ok ? response.json() : null),
    fetch('/api/integrity', { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
  ]);

  folderByPath.clear();
  if (stateResult.status === 'fulfilled' && stateResult.value) {
    for (const folder of stateResult.value.settings?.folders || []) folderByPath.set(cleanPath(folder.path), { ...folder });
  }
  if (folderStatsResult.status === 'fulfilled' && folderStatsResult.value) {
    for (const folder of folderStatsResult.value.folders || []) {
      const key = cleanPath(folder.path);
      folderByPath.set(key, { ...(folderByPath.get(key) || {}), ...folder });
    }
  }

  if (backupResult.status === 'fulfilled' && backupResult.value) backups = backupResult.value.backups || [];
  if (integrityResult.status === 'fulfilled' && integrityResult.value) integrity = integrityResult.value;
  renderTimes();
}

const pane = document.querySelector('#storagePane');
if (pane) new MutationObserver(renderTimes).observe(pane, { childList: true, subtree: true });

refreshTimes();
setInterval(renderTimes, 1000);
setInterval(refreshTimes, 5000);
