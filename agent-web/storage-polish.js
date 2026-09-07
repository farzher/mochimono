import './storage-insights.js';
import './browser-folders.js';

const protectionMenu = document.querySelector('#clientProtection');
const serverStorage = document.querySelector('#serverStorage');
const headerActions = document.querySelector('.client-head-actions');
const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
const friendOrigin = `http://${host}:8644`;

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

function storageNumbers(location) {
  const capacity = Math.max(0, Number(location?.capacityBytes) || 0);
  const free = Math.max(0, Math.min(capacity, Number(location?.freeBytes) || 0));
  const used = Math.max(0, capacity - free);
  const percent = capacity ? Math.max(0, Math.min(100, used / capacity * 100)) : 0;
  return { capacity, free, used, percent };
}

function locationIdentity(location) {
  const rawName = String(location?.name || '').trim() || 'Storage';
  const path = String(location?.path || '').trim();
  if (location?.type === 'cloud' || /^cloud$/i.test(rawName)) return { title: 'Cloud', meta: '' };
  if (location?.type === 'friend') {
    const connection = String(location.connection || '').trim();
    return { title: rawName, meta: connection && connection !== 'offline' ? `${connection[0].toUpperCase()}${connection.slice(1)} connection` : 'Friend storage' };
  }
  const parts = rawName.split(/\s+·\s+/).filter(Boolean);
  if (parts.length > 1) return { title: parts.at(-1), meta: parts.slice(0, -1).join(' · ') };
  if (path && path !== rawName) return { title: rawName, meta: path };
  return { title: rawName, meta: '' };
}

function makeCapacityUi() {
  if (!headerActions || document.querySelector('.storage-capacity-overview')) return null;
  document.querySelector('.storage-location-overview')?.remove();
  if (serverStorage) serverStorage.style.display = 'none';

  const style = document.createElement('style');
  style.textContent = `
    .storage-capacity-overview{position:relative;width:278px;flex:0 0 auto}
    .storage-capacity-overview summary{display:grid;gap:5px;padding:5px 7px;border-radius:9px;cursor:pointer;list-style:none;outline:none}
    .storage-capacity-overview summary::-webkit-details-marker{display:none}
    .storage-capacity-overview summary:hover,.storage-capacity-overview[open] summary{background:#181519}
    .storage-capacity-line{display:flex;align-items:baseline;gap:0;min-width:0;color:#b9b0ad;font-size:11px;font-weight:650;line-height:1.2;white-space:nowrap}
    .storage-capacity-line .available{color:#d8cfcb}
    .storage-capacity-line:after{content:'⌄';margin-left:auto;padding-left:8px;color:#70696a;font-size:10px;transform:translateY(-1px)}
    .storage-capacity-overview[open] .storage-capacity-line:after{content:'⌃'}
    .storage-capacity-bar,.storage-location-bar{display:block;width:100%;overflow:hidden;border-radius:999px;background:#292529}
    .storage-capacity-bar{height:6px}.storage-location-bar{height:4px;margin-top:8px;background:#282429}
    .storage-capacity-bar b,.storage-location-bar b{display:block;height:100%;border-radius:inherit;background:#efa09a;transition:width .25s ease}
    .storage-capacity-panel{position:absolute;z-index:60;right:0;top:calc(100% + 8px);width:min(390px,calc(100vw - 20px));padding:8px;border:1px solid #302b30;border-radius:13px;background:#171518;box-shadow:0 18px 54px rgba(0,0,0,.48)}
    .storage-capacity-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 8px 9px;color:#8c8381;font-size:10px;font-weight:650}
    .storage-capacity-panel-head strong{color:#dcd3cf;font-size:12px;font-weight:720}
    .storage-location-list{display:grid;gap:4px;max-height:min(420px,60vh);overflow:auto}
    .storage-location-row{padding:10px;border-radius:9px;background:#111012;border:1px solid transparent}
    .storage-location-row:hover{border-color:#302b30;background:#141215}
    .storage-location-row.offline{opacity:.58}
    .storage-location-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;min-width:0}
    .storage-location-title{min-width:0}.storage-location-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6ddda;font-size:12px;font-weight:710}
    .storage-location-title span{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#77706e;font-size:9px;font-weight:560}
    .storage-location-amounts{flex:0 0 auto;color:#a59c99;font-size:10px;font-weight:620;text-align:right;white-space:nowrap}
    .storage-location-amounts .available{color:#d3cac6}
    .storage-location-offline{color:#8d8381;font-size:10px;font-weight:650}
    @media(max-width:700px){.storage-capacity-overview{width:184px}.storage-capacity-line .used,.storage-capacity-line .separator{display:none}.storage-capacity-panel{right:-39px}.storage-capacity-overview summary{padding:4px 5px}}
  `;
  document.head.append(style);

  const details = document.createElement('details');
  details.className = 'storage-capacity-overview';
  details.innerHTML = `
    <summary aria-label="Storage usage and locations">
      <div class="storage-capacity-line"><span class="used" data-storage-total-used>Storage</span><span class="separator" data-storage-total-separator></span><span class="available" data-storage-total-free></span></div>
      <i class="storage-capacity-bar"><b data-storage-total-bar></b></i>
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
  const measurable = all.filter(location => location.online && Number(location.capacityBytes) > 0);
  const totals = measurable.reduce((sum, location) => {
    const numbers = storageNumbers(location);
    sum.capacity += numbers.capacity;
    sum.used += numbers.used;
    sum.free += numbers.free;
    return sum;
  }, { capacity:0, used:0, free:0 });
  const totalPercent = totals.capacity ? Math.min(100, totals.used / totals.capacity * 100) : 0;
  const offline = all.filter(location => !location.online).length;

  const usedNode = details.querySelector('[data-storage-total-used]');
  const separatorNode = details.querySelector('[data-storage-total-separator]');
  const freeNode = details.querySelector('[data-storage-total-free]');
  const bar = details.querySelector('[data-storage-total-bar]');
  const count = details.querySelector('[data-storage-location-count]');
  const list = details.querySelector('[data-storage-location-list]');

  if (totals.capacity) {
    usedNode.textContent = `${formatBytes(totals.used)} used`;
    separatorNode.textContent = ' · ';
    freeNode.textContent = `${formatBytes(totals.free)} available`;
    bar.style.width = totals.used ? `max(2px,${totalPercent}%)` : '0';
    details.title = `${formatBytes(totals.used)} used · ${formatBytes(totals.free)} available across ${measurable.length} online storage location${measurable.length === 1 ? '' : 's'}${offline ? ` · ${offline} offline` : ''}`;
  } else {
    usedNode.textContent = all.length ? 'Storage unavailable' : 'Storage';
    separatorNode.textContent = '';
    freeNode.textContent = '';
    bar.style.width = '0';
    details.title = all.length ? 'Storage locations are currently unavailable' : 'Storage';
  }

  count.textContent = `${measurable.length} online${offline ? ` · ${offline} offline` : ''}`;
  list.innerHTML = all.length ? all.map(location => {
    const identity = locationIdentity(location);
    const title = location.error || location.path || location.name || '';
    if (!location.online) {
      return `<div class="storage-location-row offline" title="${String(title).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}"><div class="storage-location-head"><div class="storage-location-title"><strong>${String(identity.title).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}</strong>${identity.meta ? `<span>${String(identity.meta).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}</span>` : ''}</div><span class="storage-location-offline">Unavailable</span></div></div>`;
    }
    const numbers = storageNumbers(location);
    return `<div class="storage-location-row" title="${String(title).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}"><div class="storage-location-head"><div class="storage-location-title"><strong>${String(identity.title).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}</strong>${identity.meta ? `<span>${String(identity.meta).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}</span>` : ''}</div><div class="storage-location-amounts"><span>${formatBytes(numbers.used)} used</span><br><span class="available">${formatBytes(numbers.free)} available</span></div></div>${numbers.capacity ? `<i class="storage-location-bar"><b style="width:${numbers.used ? `max(2px,${numbers.percent}%)` : '0'}"></b></i>` : ''}</div>`;
  }).join('') : '<div class="storage-location-row offline"><div class="storage-location-offline">No storage locations yet</div></div>';
}

async function refreshCapacity(details) {
  try {
    const response = await fetch(`${friendOrigin}/local/storage-locations`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderCapacity(details, data.locations || []);
  } catch {
    renderCapacity(details, []);
  }
}

protectionMenu?.addEventListener('click', openProtectionSettings);

setTimeout(() => {
  document.querySelector('.storage-location-overview')?.remove();
  const details = makeCapacityUi();
  if (!details) return;
  refreshCapacity(details);
  setInterval(() => refreshCapacity(details), 3000);
}, 0);
