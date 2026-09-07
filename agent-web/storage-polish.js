import './storage-insights.js';
import './browser-folders.js';

const protectionMenu = document.querySelector('#clientProtection');
const serverStorage = document.querySelector('#serverStorage');
const headerActions = document.querySelector('.client-head-actions');
const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
const friendOrigin = `http://${host}:8644`;
const SNAPSHOT_KEY = 'mochimono-storage-location-snapshots-v1';

function openProtectionSettings() {
  const button = document.querySelector('#protectionSettings');
  if (button) {
    button.click();
    return;
  }
  setTimeout(() => document.querySelector('#protectionSettings')?.click(), 150);
}

function formatBytes(number) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Math.max(0, Number(number) || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatKnownAt(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'
  });
}

function newestDate(...values) {
  let best = 0;
  for (const value of values) {
    const time = new Date(value || 0).getTime();
    if (Number.isFinite(time) && time > best) best = time;
  }
  return best ? new Date(best).toISOString() : '';
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
}[char]));

function storageNumbers(location) {
  const used = Math.max(0, Number(location?.mochimonoBytes) || 0);
  const free = Math.max(0, Number(location?.freeBytes) || 0);
  const capacity = Math.max(0, Number(location?.capacityBytes) || 0);
  // The useful bar is "Mochimono data vs room left for Mochimono", not total
  // disk usage. Other applications/files may also consume the physical disk.
  const usable = used + free;
  const percent = usable ? Math.max(0, Math.min(100, used / usable * 100)) : 0;
  return { capacity, free, used, usable, percent };
}

function rootForPath(value) {
  const path = String(value || '').trim();
  const drive = /^([a-z]:)[\\/]/i.exec(path);
  if (drive) return `${drive[1].toUpperCase()}\\`;
  const unc = /^(\\\\[^\\]+\\[^\\]+)(?:\\|$)/.exec(path);
  if (unc) return `${unc[1]}\\`;
  if (path.startsWith('/')) return '/';
  return path;
}

function rootKey(value) {
  return rootForPath(value).replace(/[\\/]+$/, '').toLowerCase();
}

function localLocations(folders, device) {
  const groups = new Map();
  for (const folder of folders || []) {
    const root = rootForPath(folder.path);
    const key = rootKey(root);
    if (!root || !key) continue;
    let group = groups.get(key);
    if (!group) {
      group = {
        id:`local:${key}`,
        type:'local',
        name:root,
        path:root,
        meta:String(device || ''),
        online:false,
        capacityBytes:0,
        freeBytes:0,
        mochimonoBytes:0,
        folderCount:0,
        lastKnownAt:''
      };
      groups.set(key, group);
    }
    group.folderCount++;
    // Indexed folder size remains useful even when the physical drive is gone.
    group.mochimonoBytes += Math.max(0, Number(folder.bytes) || 0);
    group.lastKnownAt = newestDate(group.lastKnownAt, folder.lastIndexed, folder.lastSynced);
    const capacity = Math.max(0, Number(folder.capacityBytes) || 0);
    const free = Math.max(0, Number(folder.freeBytes) || 0);
    if (capacity > 0) {
      group.online = true;
      if (!group.capacityBytes || capacity > group.capacityBytes) group.capacityBytes = capacity;
      if (!group.freeBytes || free > group.freeBytes) group.freeBytes = free;
    }
  }
  for (const group of groups.values()) {
    const parts = [group.meta, `${group.folderCount} folder${group.folderCount === 1 ? '' : 's'}`].filter(Boolean);
    group.meta = parts.join(' · ');
  }
  return [...groups.values()];
}

function backupLocations(backups) {
  return (backups || []).map((backup, index) => ({
    id:`backup:${rootKey(backup.path) || index}`,
    type:'backup',
    name:String(backup.meta?.name || 'Backup'),
    path:String(backup.path || ''),
    meta:String(backup.path || ''),
    online:Number(backup.totalBytes) > 0,
    capacityBytes:Math.max(0, Number(backup.totalBytes) || 0),
    freeBytes:Math.max(0, Number(backup.freeBytes) || 0),
    mochimonoBytes:Math.max(0, Number(backup.local?.bytes) || 0),
    lastKnownAt:newestDate(backup.meta?.lastBackupAt, backup.meta?.lastVerifiedAt, backup.local?.oldestVerification)
  }));
}

function cloudLocation(state) {
  const stats = state?.server?.online && state.server.stats ? state.server.stats : null;
  return stats ? {
    id:'cloud',
    type:'cloud',
    name:'Cloud',
    online:true,
    capacityBytes:Math.max(0, Number(stats.capacityBytes) || 0),
    freeBytes:Math.max(0, Number(stats.freeBytes) || 0),
    mochimonoBytes:Math.max(0, Number(stats.bytes) || 0),
    lastKnownAt:''
  } : { id:'cloud', type:'cloud', name:'Cloud', online:false, lastKnownAt:'' };
}

function loadSnapshots() {
  try {
    const value = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function applyLastKnown(locations) {
  const snapshots = loadSnapshots();
  const now = new Date().toISOString();
  let changed = false;
  const result = locations.map(location => {
    const cached = snapshots[location.id] || null;
    if (location.online) {
      snapshots[location.id] = {
        capacityBytes:Math.max(0, Number(location.capacityBytes) || 0),
        freeBytes:Math.max(0, Number(location.freeBytes) || 0),
        mochimonoBytes:Math.max(0, Number(location.mochimonoBytes) || 0),
        lastKnownAt:now
      };
      changed = true;
      return { ...location, lastKnownAt:now, stale:false };
    }

    const indexedUsed = Math.max(0, Number(location.mochimonoBytes) || 0);
    const useIndexedUsage = location.type === 'local';
    return {
      ...location,
      capacityBytes:Math.max(0, Number(location.capacityBytes) || Number(cached?.capacityBytes) || 0),
      freeBytes:Math.max(0, Number(location.freeBytes) || Number(cached?.freeBytes) || 0),
      mochimonoBytes:useIndexedUsage ? indexedUsed : Math.max(indexedUsed, Number(cached?.mochimonoBytes) || 0),
      lastKnownAt:newestDate(location.lastKnownAt, cached?.lastKnownAt),
      stale:true,
      hasLiveSnapshot:Boolean(cached?.lastKnownAt)
    };
  });
  if (changed) {
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots)); } catch {}
  }
  return result;
}

function locationIdentity(location) {
  if (location.type === 'cloud') return { title:'Cloud', meta:'' };
  if (location.type === 'local') return { title:location.name || location.path || 'Local', meta:location.meta || '' };
  if (location.type === 'backup') return { title:location.name || 'Backup', meta:location.meta || '' };
  if (location.type === 'friend') {
    const connection = String(location.connection || '').trim();
    const meta = connection && connection !== 'offline'
      ? `${connection[0].toUpperCase()}${connection.slice(1)} connection`
      : 'Friend storage';
    return { title:String(location.name || 'Friend storage'), meta };
  }
  return { title:String(location.name || 'Storage'), meta:String(location.path || '') };
}

function makeCapacityUi() {
  if (!headerActions || document.querySelector('.storage-capacity-overview')) return null;
  document.querySelector('.storage-location-overview')?.remove();
  if (serverStorage) serverStorage.style.display = 'none';

  const style = document.createElement('style');
  style.textContent = `
    .storage-capacity-overview{position:relative;width:292px;flex:0 0 auto}
    .storage-capacity-overview summary{display:grid;gap:5px;padding:5px 7px;border-radius:9px;cursor:pointer;list-style:none;outline:none}
    .storage-capacity-overview summary::-webkit-details-marker{display:none}
    .storage-capacity-overview summary:hover,.storage-capacity-overview[open] summary{background:#181519}
    .storage-capacity-line{display:flex;align-items:baseline;gap:0;min-width:0;color:#b9b0ad;font-size:11px;font-weight:650;line-height:1.2;white-space:nowrap}
    .storage-capacity-line .free{color:#d8cfcb}
    .storage-capacity-line:after{content:'⌄';margin-left:auto;padding-left:8px;color:#70696a;font-size:10px;transform:translateY(-1px)}
    .storage-capacity-overview[open] .storage-capacity-line:after{content:'⌃'}
    .storage-capacity-bar,.storage-location-bar{display:block;width:100%;overflow:hidden;border-radius:999px;background:#292529}
    .storage-capacity-bar{height:6px}.storage-location-bar{height:4px;margin-top:8px;background:#282429}
    .storage-capacity-bar b,.storage-location-bar b{display:block;height:100%;border-radius:inherit;background:#efa09a;transition:width .25s ease}
    .storage-capacity-panel{position:absolute;z-index:60;right:0;top:calc(100% + 8px);width:min(410px,calc(100vw - 20px));padding:8px;border:1px solid #302b30;border-radius:13px;background:#171518;box-shadow:0 18px 54px rgba(0,0,0,.48)}
    .storage-capacity-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 8px 9px;color:#8c8381;font-size:10px;font-weight:650}
    .storage-capacity-panel-head strong{color:#dcd3cf;font-size:12px;font-weight:720}
    .storage-location-list{display:grid;gap:4px;max-height:min(430px,60vh);overflow:auto}
    .storage-location-row{padding:10px;border-radius:9px;background:#111012;border:1px solid transparent}
    .storage-location-row:hover{border-color:#302b30;background:#141215}
    .storage-location-row.offline{opacity:.78}
    .storage-location-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;min-width:0}
    .storage-location-title{min-width:0}.storage-location-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6ddda;font-size:12px;font-weight:710}
    .storage-location-title span{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#77706e;font-size:9px;font-weight:560}
    .storage-location-amounts{flex:0 0 auto;color:#a59c99;font-size:10px;font-weight:620;text-align:right;white-space:nowrap}
    .storage-location-amounts .free{color:#d3cac6}
    .storage-location-stale{display:block;margin-top:3px;color:#807775;font-size:9px;font-weight:560}
    .storage-location-offline{color:#a8908b;font-size:10px;font-weight:700}
    @media(max-width:700px){.storage-capacity-overview{width:190px}.storage-capacity-line .stored,.storage-capacity-line .separator{display:none}.storage-capacity-panel{right:-39px}.storage-capacity-overview summary{padding:4px 5px}}
  `;
  document.head.append(style);

  const details = document.createElement('details');
  details.className = 'storage-capacity-overview';
  details.innerHTML = `
    <summary aria-label="Storage usage and locations">
      <div class="storage-capacity-line"><span class="stored" data-storage-primary-used>Storage</span><span class="separator" data-storage-primary-separator></span><span class="free" data-storage-primary-free></span></div>
      <i class="storage-capacity-bar"><b data-storage-primary-bar></b></i>
    </summary>
    <div class="storage-capacity-panel">
      <div class="storage-capacity-panel-head"><strong>Storage locations</strong><span data-storage-location-count></span></div>
      <div class="storage-location-list" data-storage-location-list></div>
    </div>`;
  headerActions.prepend(details);

  document.addEventListener('pointerdown', event => {
    if (details.open && !details.contains(event.target)) details.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && details.open) details.open = false;
  });
  return details;
}

function renderCapacity(details, locations) {
  if (!details) return;
  const all = Array.isArray(locations) ? locations : [];
  const online = all.filter(location => location.online);
  const offline = all.length - online.length;
  const primary = all.find(location => location.type === 'cloud' && location.online) || online[0] || null;

  const usedNode = details.querySelector('[data-storage-primary-used]');
  const separatorNode = details.querySelector('[data-storage-primary-separator]');
  const freeNode = details.querySelector('[data-storage-primary-free]');
  const bar = details.querySelector('[data-storage-primary-bar]');
  const count = details.querySelector('[data-storage-location-count]');
  const list = details.querySelector('[data-storage-location-list]');

  if (primary) {
    const numbers = storageNumbers(primary);
    usedNode.textContent = `${formatBytes(numbers.used)} stored`;
    separatorNode.textContent = ' · ';
    freeNode.textContent = `${formatBytes(numbers.free)} free`;
    bar.style.width = numbers.used ? `max(2px,${numbers.percent}%)` : '0';
    const label = locationIdentity(primary).title;
    details.title = `${label}: ${formatBytes(numbers.used)} stored by Mochimono · ${formatBytes(numbers.free)} free for more`;
  } else {
    usedNode.textContent = all.length ? 'Storage offline' : 'Storage';
    separatorNode.textContent = '';
    freeNode.textContent = '';
    bar.style.width = '0';
    details.title = all.length ? 'Storage locations are currently offline; last known information is shown in the breakdown' : 'Storage';
  }

  count.textContent = `${online.length} online${offline ? ` · ${offline} offline` : ''}`;
  list.innerHTML = all.length ? all.map(location => {
    const identity = locationIdentity(location);
    const numbers = storageNumbers(location);
    const knownAt = formatKnownAt(location.lastKnownAt);
    const title = location.error || location.path || location.name || '';
    const identityHtml = `<div class="storage-location-title"><strong>${esc(identity.title)}</strong>${identity.meta ? `<span>${esc(identity.meta)}</span>` : ''}</div>`;

    if (!location.online) {
      const amountLines = [];
      if (numbers.used || location.type === 'local') amountLines.push(`<span>${formatBytes(numbers.used)} stored</span>`);
      if (numbers.free) amountLines.push(`<span class="free">${formatBytes(numbers.free)} free</span>`);
      else if (numbers.used || location.type === 'local') amountLines.push('<span class="free">Free space unknown</span>');
      const stale = knownAt ? `Offline · last seen ${knownAt}` : 'Offline · last seen unknown';
      const amounts = amountLines.length
        ? `<div class="storage-location-amounts">${amountLines.join('<br>')}<span class="storage-location-stale">${esc(stale)}</span></div>`
        : `<div class="storage-location-amounts"><span class="storage-location-offline">Offline</span><span class="storage-location-stale">${esc(knownAt ? `Last seen ${knownAt}` : 'No previous live snapshot')}</span></div>`;
      const detail = [title, numbers.used ? `${formatBytes(numbers.used)} last known/indexed Mochimono data` : '', numbers.free ? `${formatBytes(numbers.free)} free at last live check` : '', stale].filter(Boolean).join(' · ');
      return `<div class="storage-location-row offline" title="${esc(detail)}"><div class="storage-location-head">${identityHtml}${amounts}</div>${numbers.usable ? `<i class="storage-location-bar"><b style="width:${numbers.used ? `max(2px,${numbers.percent}%)` : '0'}"></b></i>` : ''}</div>`;
    }

    const detail = numbers.capacity
      ? `${formatBytes(numbers.used)} stored by Mochimono · ${formatBytes(numbers.free)} free · ${formatBytes(numbers.capacity)} physical capacity`
      : `${formatBytes(numbers.used)} stored by Mochimono · ${formatBytes(numbers.free)} free`;
    return `<div class="storage-location-row" title="${esc(detail)}"><div class="storage-location-head">${identityHtml}<div class="storage-location-amounts"><span>${formatBytes(numbers.used)} stored</span><br><span class="free">${formatBytes(numbers.free)} free</span></div></div>${numbers.usable ? `<i class="storage-location-bar"><b style="width:${numbers.used ? `max(2px,${numbers.percent}%)` : '0'}"></b></i>` : ''}</div>`;
  }).join('') : '<div class="storage-location-row offline"><div class="storage-location-offline">No storage locations yet</div></div>';
}

async function fetchJson(path) {
  const response = await fetch(path, { cache:'no-store' });
  if (!response.ok) throw new Error(response.statusText);
  return response.json();
}

async function refreshCapacity(details) {
  const [stateResult, foldersResult, backupsResult, friendResult] = await Promise.allSettled([
    fetchJson('/api/state'),
    fetchJson('/api/folder-stats'),
    fetchJson('/api/backups'),
    fetchJson(`${friendOrigin}/local/storage-locations`)
  ]);

  const state = stateResult.status === 'fulfilled' ? stateResult.value : {};
  const folders = foldersResult.status === 'fulfilled' ? foldersResult.value?.folders || [] : [];
  const backups = backupsResult.status === 'fulfilled' ? backupsResult.value?.backups || [] : [];
  const friendLocations = friendResult.status === 'fulfilled'
    ? (friendResult.value?.locations || []).filter(location => location.type === 'friend')
    : [];

  const locations = applyLastKnown([
    cloudLocation(state),
    ...localLocations(folders, state?.settings?.device),
    ...backupLocations(backups),
    ...friendLocations
  ]);
  renderCapacity(details, locations);
}

protectionMenu?.addEventListener('click', openProtectionSettings);

setTimeout(() => {
  document.querySelector('.storage-location-overview')?.remove();
  const details = makeCapacityUi();
  if (!details) return;
  refreshCapacity(details).catch(() => renderCapacity(details, []));
  setInterval(() => refreshCapacity(details).catch(() => {}), 5000);
}, 0);
