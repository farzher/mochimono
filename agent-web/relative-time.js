const folderTimes = new Map();
const backupByPath = new Map();

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

function setTime(element, value) {
  if (!element || !value) return;
  const text = relativeTime(value);
  if (text && element.textContent !== text) element.textContent = text;
  const title = exactTime(value);
  if (title && element.title !== title) element.title = title;
}

function renderTimes() {
  for (const row of document.querySelectorAll('#folders [data-folder-path]')) {
    const label = row.querySelector('[data-folder-status]');
    if (!label || label.classList.contains('working')) continue;
    setTime(label, folderTimes.get(cleanPath(row.dataset.folderPath)));
  }

  for (const row of document.querySelectorAll('#backups [data-backup-index]')) {
    const path = cleanPath(row.querySelector('.storage-path')?.textContent);
    const location = backupByPath.get(path);
    const label = row.querySelector('.item-state');
    if (!location || !label) continue;
    const remote = location.remote;
    if (!remote || remote.policy?.missing) continue;
    const missing = Math.max(0, Number(remote.desiredBytes) - Number(remote.protectedBytes));
    if (missing) continue;
    setTime(label, location.meta?.lastBackupAt || location.local?.oldestVerification);
  }
}

async function refreshTimes() {
  const [stateResult, backupResult] = await Promise.allSettled([
    fetch('/api/state', { cache: 'no-store' }).then(response => response.ok ? response.json() : null),
    fetch('/api/backups', { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
  ]);

  if (stateResult.status === 'fulfilled' && stateResult.value) {
    folderTimes.clear();
    for (const folder of stateResult.value.settings?.folders || []) {
      if (folder.lastSynced) folderTimes.set(cleanPath(folder.path), folder.lastSynced);
    }
  }

  if (backupResult.status === 'fulfilled' && backupResult.value) {
    backupByPath.clear();
    for (const location of backupResult.value.backups || []) backupByPath.set(cleanPath(location.path), location);
  }

  renderTimes();
}

const observer = new MutationObserver(renderTimes);
observer.observe(document.querySelector('#storagePane'), { childList: true, subtree: true, characterData: true });

refreshTimes();
setInterval(renderTimes, 1000);
setInterval(refreshTimes, 5000);