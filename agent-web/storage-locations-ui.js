const storagePane = document.querySelector('#storagePane');
const sourceSection = document.querySelector('.storage-folders-section');
const backupSection = document.querySelector('.storage-backups-section');
const toastNode = document.querySelector('#toast');

if (storagePane && sourceSection && backupSection) {
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const friendOrigin = `http://${host}:8644`;
  const SNAPSHOT_KEY = 'mochimono-storage-location-snapshots-v1';
  const TYPE_ORDER = { cloud:0, local:1, backup:2, friend:3 };
  let locations = [];
  let backups = [];
  let friendBackups = [];
  let shares = [];
  let state = null;
  let refreshTimer = 0;
  let refreshing = false;

  const style = document.createElement('style');
  style.textContent = `
    #storagePane .storage-backups-section{display:none!important}
    #storagePane .storage-folders-section>.storage-section-heading{grid-column:1/-1}
    .storage-section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;min-width:0;margin:2px 0 -2px}
    .storage-section-heading-copy{min-width:0}.storage-section-heading h2{margin:0;color:#eee6e2;font-size:17px;font-weight:760;letter-spacing:-.025em}
    .storage-section-heading p{margin:4px 0 0;color:#756e6c;font-size:10px;line-height:1.45}
    .managed-storage-section{margin-top:16px;padding-top:26px;border-top:1px solid #211e21}
    .managed-storage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;margin-top:15px}
    .managed-storage-card{position:relative;min-width:0;padding:0;overflow:hidden;border:1px solid #292529;border-radius:16px;background:#121013;color:#e9e1dd;text-align:left;box-shadow:0 1px 0 rgba(255,255,255,.025) inset,0 8px 28px rgba(0,0,0,.09);transition:border-color .14s ease,background .14s ease,box-shadow .14s ease,transform .14s ease}
    .managed-storage-card:hover,.managed-storage-card:focus-visible{border-color:#453c42;background:#151316;box-shadow:0 1px 0 rgba(255,255,255,.035) inset,0 14px 36px rgba(0,0,0,.15);outline:none;transform:translateY(-1px)}
    .managed-storage-card.offline{opacity:.72}.managed-storage-card.offline:hover{opacity:.9}
    .managed-storage-hero{position:relative;aspect-ratio:16/9;overflow:hidden;border-bottom:1px solid #252225;background:radial-gradient(circle at 18% 18%,rgba(239,160,154,.12),transparent 34%),linear-gradient(145deg,#151216,#0d0c0e 70%)}
    .managed-storage-hero:after{content:'';position:absolute;inset:auto -18% -54% 26%;height:90%;border:1px solid rgba(255,255,255,.055);border-radius:50%;transform:rotate(-9deg);box-shadow:0 0 0 20px rgba(255,255,255,.012),0 0 0 42px rgba(255,255,255,.009)}
    .managed-storage-card[data-location-type="local"] .managed-storage-hero{background:radial-gradient(circle at 18% 18%,rgba(152,171,201,.12),transparent 34%),linear-gradient(145deg,#12151a,#0c0d10 70%)}
    .managed-storage-card[data-location-type="backup"] .managed-storage-hero{background:radial-gradient(circle at 18% 18%,rgba(191,164,124,.12),transparent 34%),linear-gradient(145deg,#171510,#0e0d0b 70%)}
    .managed-storage-card[data-location-type="friend"] .managed-storage-hero{background:radial-gradient(circle at 18% 18%,rgba(153,137,211,.17),transparent 34%),linear-gradient(145deg,#15131c,#0d0c11 70%)}
    .managed-storage-type-icon{position:absolute;left:18px;top:18px;width:54px;height:54px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(9,8,10,.42);color:#d4cac6;backdrop-filter:blur(9px)}
    .managed-storage-type-icon svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
    .managed-storage-hero-badge{position:absolute;right:14px;top:14px;padding:5px 7px;border:1px solid rgba(255,255,255,.07);border-radius:999px;background:rgba(8,7,9,.45);color:#938b89;font-size:8px;font-weight:790;letter-spacing:.08em;text-transform:uppercase;backdrop-filter:blur(8px)}
    .managed-storage-hero-stat{position:absolute;left:18px;bottom:16px;color:#cfc5c1;font-size:11px;font-weight:720}.managed-storage-hero-stat small{display:block;margin-top:2px;color:#77706f;font-size:9px;font-weight:620}
    .managed-storage-card-copy{min-height:105px;padding:14px 15px 15px}.managed-storage-card-title{display:flex;align-items:center;gap:8px;min-width:0}.managed-storage-card-title strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f0e8e4;font-size:15px;font-weight:750;letter-spacing:-.018em}
    .managed-storage-status-dot{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#77b788;box-shadow:0 0 0 3px rgba(119,183,136,.08)}.offline .managed-storage-status-dot{background:#766c6c;box-shadow:none}
    .managed-storage-card-meta{display:block;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#78716f;font-size:10px}
    .managed-storage-meter{display:block;height:4px;margin-top:12px;overflow:hidden;border-radius:999px;background:#292529}.managed-storage-meter i{display:block;height:100%;border-radius:inherit;background:#d99892;transition:width .25s ease}.managed-storage-card[data-location-type="friend"] .managed-storage-meter i{background:#9283ce}
    .managed-storage-add{border-style:dashed;background:#100f11;color:#847b79}.managed-storage-add .managed-storage-hero{display:grid;place-items:center;background:#111013}.managed-storage-add .managed-storage-hero:after{display:none}.managed-storage-add-mark{width:54px;height:54px;display:grid;place-items:center;border:1px dashed #494148;border-radius:16px;color:#7f7678;font-size:30px;font-weight:250}.managed-storage-add:hover .managed-storage-add-mark{border-color:#6b5d64;color:#c0b5b1}
    .managed-storage-shares{margin-top:22px;padding-top:18px;border-top:1px solid #1d1a1d}.managed-storage-shares[hidden]{display:none!important}.managed-storage-shares-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}.managed-storage-shares-head strong{color:#aea4a1;font-size:11px}.managed-storage-share-list{display:flex;gap:8px;flex-wrap:wrap}.managed-storage-share{display:flex;align-items:center;gap:8px;max-width:100%;padding:8px 10px;border:1px solid #282428;border-radius:10px;background:#111012;color:#817977;font-size:9px}.managed-storage-share strong{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cfc6c2;font-size:10px}.managed-storage-share button{padding:3px 6px;background:transparent;color:#9e9491;font-size:9px}.managed-storage-share button:hover{background:#242124;color:#fff}
    .storage-location-dialog{width:min(570px,calc(100vw - 28px))}.storage-location-dialog .dialog-head h3{max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .storage-location-inspect{display:grid;gap:16px}.storage-location-inspect-hero{display:grid;grid-template-columns:auto minmax(0,1fr);gap:13px;align-items:center;padding:13px;border:1px solid #2a262a;border-radius:12px;background:#121013}.storage-location-inspect-icon{width:46px;height:46px;display:grid;place-items:center;border-radius:12px;background:#1c191d;color:#cfc5c1}.storage-location-inspect-icon svg{width:27px;height:27px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.storage-location-inspect-copy{min-width:0}.storage-location-inspect-copy strong{display:block;color:#ebe3df;font-size:13px}.storage-location-inspect-copy span{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#817976;font-size:10px}
    .storage-location-capacity{display:grid;gap:7px}.storage-location-capacity-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:#8c8380;font-size:10px}.storage-location-capacity-head strong{color:#d7cfcb;font-size:12px}.storage-location-capacity-track{height:7px;overflow:hidden;border-radius:999px;background:#292529}.storage-location-capacity-track i{display:block;height:100%;border-radius:inherit;background:#df9892}.storage-location-detail-list{display:grid}.storage-location-detail{display:grid;grid-template-columns:115px minmax(0,1fr);gap:12px;padding:9px 0;border-top:1px solid #242124;font-size:10px}.storage-location-detail:first-child{border-top:0}.storage-location-detail dt{color:#756e6c}.storage-location-detail dd{margin:0;min-width:0;overflow-wrap:anywhere;color:#c4bbb7;white-space:pre-line}.storage-location-actions{display:flex;gap:7px;flex-wrap:wrap}.storage-location-actions button{font-size:10px}.storage-location-actions .secondary{background:#211e22;color:#bdb4b0}.storage-location-actions .secondary:hover{background:#2a262b;color:#fff}
    .storage-add-options{display:grid;gap:7px}.storage-add-option{width:100%;display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:11px;align-items:center;padding:10px;border:1px solid #292529;border-radius:10px;background:#121013;color:#cfc6c2;text-align:left}.storage-add-option:hover{border-color:#453c42;background:#181519}.storage-add-option-icon{width:36px;height:36px;display:grid;place-items:center;border-radius:9px;background:#1c191d;color:#aaa09d}.storage-add-option-icon svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.storage-add-option-copy strong,.storage-add-option-copy span{display:block}.storage-add-option-copy strong{font-size:11px}.storage-add-option-copy span{margin-top:2px;color:#7e7674;font-size:9px;font-weight:550}.storage-add-option-action{color:#8d8381;font-size:9px;font-weight:700}.storage-add-option[disabled]{opacity:.58;cursor:default}.storage-add-note{margin-top:4px;color:#706967;font-size:9px;line-height:1.45}
    .storage-backup-add-path{padding:8px 9px;border:1px solid #2b272b;border-radius:9px;background:#111012;color:#a69c99;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
    @media(max-width:700px){.managed-storage-grid{grid-template-columns:1fr}.storage-section-heading{align-items:flex-start}.storage-location-detail{grid-template-columns:90px minmax(0,1fr)}}
  `;
  document.head.append(style);

  const sourceHeading = document.createElement('div');
  sourceHeading.className = 'storage-section-heading';
  sourceHeading.innerHTML = `<div class="storage-section-heading-copy"><h2>Sources</h2><p>Folders Mochimono watches and indexes. This is where files come from.</p></div>`;
  sourceSection.prepend(sourceHeading);

  const section = document.createElement('section');
  section.className = 'managed-storage-section';
  section.innerHTML = `
    <div class="storage-section-heading">
      <div class="storage-section-heading-copy"><h2>Storage locations</h2><p>Places Mochimono keeps managed copies of your files.</p></div>
    </div>
    <div class="managed-storage-grid" data-managed-storage-grid><div class="managed-storage-card managed-storage-add" aria-hidden="true"><div class="managed-storage-hero"></div></div></div>
    <div class="managed-storage-shares" data-managed-storage-shares hidden>
      <div class="managed-storage-shares-head"><strong>Storage you offer to friends</strong></div>
      <div class="managed-storage-share-list" data-managed-storage-share-list></div>
    </div>`;
  sourceSection.after(section);

  const inspectDialog = document.createElement('dialog');
  inspectDialog.className = 'small-dialog storage-location-dialog';
  inspectDialog.innerHTML = `<div class="dialog-head"><h3 data-location-dialog-title>Storage</h3><button class="icon" data-location-close>×</button></div><div data-location-dialog-body></div>`;
  document.body.append(inspectDialog);

  const addDialog = document.createElement('dialog');
  addDialog.className = 'small-dialog storage-location-dialog';
  addDialog.innerHTML = `<div class="dialog-head"><h3>Add storage</h3><button class="icon" data-storage-add-close>×</button></div><div class="storage-add-options" data-storage-add-options></div>`;
  document.body.append(addDialog);

  const backupDialog = document.createElement('dialog');
  backupDialog.className = 'small-dialog storage-location-dialog';
  backupDialog.innerHTML = `
    <div class="dialog-head"><h3>Add backup drive</h3><button class="icon" data-storage-backup-close>×</button></div>
    <div class="field-stack">
      <div class="storage-backup-add-path" data-storage-backup-path>No folder selected</div>
      <label class="field-label">Name</label><input data-storage-backup-name placeholder="Backup drive">
      <label class="field-label">Back up</label><select data-storage-backup-scope><option value="">Everything</option></select>
      <div class="storage-add-note">Mochimono will initialize this folder as an independent backup and start the first update immediately.</div>
    </div>
    <div class="dialog-actions"><button class="secondary" data-storage-backup-choose>Choose another folder</button><div class="spacer"></div><button class="secondary" data-storage-backup-close>Cancel</button><button class="primary" data-storage-backup-save>Add</button></div>`;
  document.body.append(backupDialog);

  const grid = section.querySelector('[data-managed-storage-grid]');
  const sharesBlock = section.querySelector('[data-managed-storage-shares]');
  const shareList = section.querySelector('[data-managed-storage-share-list]');
  let pendingBackupPath = '';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  function rootForPath(value) {
    const path = String(value || '').trim();
    const drive = /^([a-z]:)[\\/]/i.exec(path);
    if (drive) return `${drive[1].toUpperCase()}\\`;
    const unc = /^(\\\\[^\\]+\\[^\\]+)(?:\\|$)/.exec(path);
    if (unc) return `${unc[1]}\\`;
    if (path.startsWith('/')) return '/';
    return path;
  }
  const rootKey = value => pathKey(rootForPath(value));
  function bytes(number) {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Math.max(0, Number(number) || 0), unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }
  function age(value) {
    const time = new Date(value || 0).getTime();
    if (!Number.isFinite(time) || !time) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 60) return `${days}d ago`;
    const months = Math.floor(days / 30.44);
    return months < 24 ? `${Math.max(1, months)}mo ago` : `${Math.floor(months / 12)}y ago`;
  }
  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    clearTimeout(toastNode.timer);
    toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
  }
  async function json(url, options = {}) {
    const response = await fetch(url, {
      cache:'no-store',
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
      body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText || 'Storage request failed');
    return data;
  }
  const local = (path, options) => json(`${friendOrigin}${path}`, options);

  function icon(type) {
    if (type === 'cloud') return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9.5 24.5h14.2a5.3 5.3 0 0 0 .7-10.5A8.4 8.4 0 0 0 8.5 12.4a6.1 6.1 0 0 0 1 12.1Z"/></svg>`;
    if (type === 'local') return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="7" width="22" height="18" rx="3"/><path d="M8.5 20h15M10 12h12M10 16h7"/></svg>`;
    if (type === 'backup') return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="6" y="5" width="20" height="22" rx="3"/><path d="M10 10h12M10 15h12M11 22h.1M16 22h5"/></svg>`;
    if (type === 'friend') return `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="10.5" cy="12" r="4"/><circle cx="21.5" cy="12" r="4"/><path d="M4.5 25c.7-4 2.8-6 6-6 2.5 0 4.2 1.2 5.1 3.5M16.4 22.5c1-2.3 2.7-3.5 5.1-3.5 3.2 0 5.3 2 6 6M13.5 15.5l5 0"/></svg>`;
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="6" y="6" width="20" height="20" rx="4"/></svg>`;
  }

  function typeLabel(location) {
    if (location.type === 'cloud') return 'Primary cloud';
    if (location.type === 'local') return 'This PC';
    if (location.type === 'backup') return 'Backup drive';
    if (location.type === 'friend') return 'Friend drive';
    return 'Storage';
  }
  function locationTitle(location) {
    if (location.type === 'cloud') return 'Cloud';
    if (location.type === 'local') return location.name || location.path || 'Local storage';
    return location.name || (location.type === 'backup' ? 'Backup' : 'Friend storage');
  }
  function storageNumbers(location) {
    const used = Math.max(0, Number(location.mochimonoBytes) || 0);
    const free = Math.max(0, Number(location.freeBytes) || 0);
    const capacity = Math.max(0, Number(location.capacityBytes) || 0);
    const usable = used + free;
    return { used, free, capacity, usable, percent:usable ? Math.max(0, Math.min(100, used / usable * 100)) : 0 };
  }
  function snapshot(location) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}') || {}; } catch {}
    return stored[location.snapshotId || location.id] || null;
  }
  function withLastKnown(location) {
    if (location.online) return location;
    const cached = snapshot(location);
    if (!cached) return location;
    return {
      ...location,
      capacityBytes:Number(location.capacityBytes) || Number(cached.capacityBytes) || 0,
      freeBytes:Number(location.freeBytes) || Number(cached.freeBytes) || 0,
      mochimonoBytes:Math.max(Number(location.mochimonoBytes) || 0, Number(cached.mochimonoBytes) || 0),
      lastKnownAt:location.lastKnownAt || cached.lastKnownAt || ''
    };
  }

  function composeLocations(folderStats, backupData, rawFriendLocations, currentState) {
    const result = [];
    const stats = currentState?.server?.online ? currentState.server.stats : null;
    result.push(stats ? {
      id:'cloud', snapshotId:'cloud', type:'cloud', name:'Cloud', online:true,
      capacityBytes:Number(stats.capacityBytes) || 0,
      freeBytes:Number(stats.freeBytes) || 0,
      mochimonoBytes:Number(stats.bytes) || 0
    } : { id:'cloud', snapshotId:'cloud', type:'cloud', name:'Cloud', online:false });

    const localGroups = new Map();
    for (const folder of folderStats || []) {
      const root = rootForPath(folder.path);
      const key = rootKey(root);
      if (!key) continue;
      const group = localGroups.get(key) || {
        id:`local:${key}`, snapshotId:`local:${key}`, type:'local', name:root, path:root,
        online:false, capacityBytes:0, freeBytes:0, mochimonoBytes:0, sources:[]
      };
      group.mochimonoBytes += Math.max(0, Number(folder.bytes) || 0);
      group.sources.push({ path:folder.path, files:Number(folder.files) || 0, protected:folder.protected !== false });
      const capacity = Math.max(0, Number(folder.capacityBytes) || 0);
      const free = Math.max(0, Number(folder.freeBytes) || 0);
      if (capacity > 0) {
        group.online = true;
        group.capacityBytes = Math.max(group.capacityBytes, capacity);
        group.freeBytes = Math.max(group.freeBytes, free);
      }
      group.lastKnownAt = folder.lastIndexed || folder.lastSynced || group.lastKnownAt || '';
      localGroups.set(key, group);
    }
    result.push(...localGroups.values());

    for (let index = 0; index < (backupData || []).length; index++) {
      const backup = backupData[index];
      result.push({
        id:`backup-path:${pathKey(backup.path)}`,
        snapshotId:`backup:${rootKey(backup.path) || index}`,
        type:'backup',
        name:backup.meta?.name || backup.path || 'Backup',
        path:backup.path || '',
        online:Number(backup.totalBytes) > 0,
        capacityBytes:Number(backup.totalBytes) || 0,
        freeBytes:Number(backup.freeBytes) || 0,
        mochimonoBytes:Number(backup.local?.bytes) || 0,
        lastKnownAt:backup.meta?.lastVerifiedAt || backup.meta?.lastBackupAt || '',
        backupIndex:index,
        backup
      });
    }

    for (const friend of rawFriendLocations || []) {
      if (friend.type === 'friend') result.push({ ...friend, snapshotId:friend.id });
    }
    return result;
  }

  function enrichLocations(raw, friendData, currentState) {
    return (raw || []).map(original => {
      const location = { ...original };
      if (location.type === 'cloud') {
        location.server = currentState?.settings?.server || '';
      } else if (location.type === 'local') {
        location.device = currentState?.settings?.device || '';
      } else if (location.type === 'friend') {
        const targetId = String(location.id || '').replace(/^friend:/, '');
        const target = (friendData || []).find(item => String(item.id) === targetId);
        if (target) {
          location.targetId = targetId;
          location.target = target;
          location.name = target.name || location.name;
          location.peerName = target.peerName || '';
          location.lastKnownAt = target.lastVerifiedAt || target.lastBackupAt || '';
        }
      }
      return withLastKnown(location);
    }).sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || locationTitle(a).localeCompare(locationTitle(b)));
  }

  function cardMeta(location) {
    if (!location.online) return location.lastKnownAt ? `Offline · last seen ${age(location.lastKnownAt)}` : 'Offline';
    if (location.type === 'cloud') return location.server || 'Primary Mochimono Cloud';
    if (location.type === 'local') {
      const count = location.sources?.length || 0;
      return `${location.device || 'This device'}${count ? ` · ${count} source${count === 1 ? '' : 's'}` : ''}`;
    }
    if (location.type === 'backup') return location.path || 'Independent backup';
    if (location.type === 'friend') {
      const connection = String(location.connection || '').trim();
      return `${location.peerName || 'Friend'}${connection && connection !== 'offline' ? ` · ${connection === 'relayed' ? 'Relayed' : 'Direct'}` : ''}`;
    }
    return location.path || '';
  }

  function card(location) {
    const numbers = storageNumbers(location);
    const freeLabel = location.online && numbers.free ? `${bytes(numbers.free)} free` : location.online ? 'Online' : 'Offline';
    const usedLabel = numbers.used ? `${bytes(numbers.used)} managed` : typeLabel(location);
    return `<button class="managed-storage-card ${location.online ? '' : 'offline'}" type="button" data-location-id="${esc(location.id)}" data-location-type="${esc(location.type)}">
      <div class="managed-storage-hero">
        <span class="managed-storage-type-icon">${icon(location.type)}</span>
        <span class="managed-storage-hero-badge">${esc(typeLabel(location))}</span>
        <span class="managed-storage-hero-stat">${esc(freeLabel)}<small>${esc(usedLabel)}</small></span>
      </div>
      <div class="managed-storage-card-copy">
        <div class="managed-storage-card-title"><i class="managed-storage-status-dot"></i><strong>${esc(locationTitle(location))}</strong></div>
        <span class="managed-storage-card-meta" title="${esc(cardMeta(location))}">${esc(cardMeta(location))}</span>
        <span class="managed-storage-meter"><i style="width:${numbers.used ? `max(2px,${numbers.percent}%)` : '0'}"></i></span>
      </div>
    </button>`;
  }

  function addCard() {
    return `<button class="managed-storage-card managed-storage-add" type="button" data-add-storage>
      <div class="managed-storage-hero"><span class="managed-storage-add-mark">＋</span></div>
      <div class="managed-storage-card-copy"><div class="managed-storage-card-title"><strong>Add storage</strong></div><span class="managed-storage-card-meta">Backup drive, friend drive, Cloud, or another local source</span></div>
    </button>`;
  }

  function render() {
    grid.innerHTML = locations.map(card).join('') + addCard();
    sharesBlock.hidden = !shares.length;
    shareList.innerHTML = shares.map(share => {
      const storage = share.storage || {};
      const quota = Number(share.quotaBytes) || 0;
      const status = share.paired ? `${share.peerName || 'Friend'} · ${storage.online ? 'online' : 'offline'}` : 'Waiting for friend';
      const amount = `${bytes(storage.usedBytes || 0)} used${quota ? ` / ${bytes(quota)}` : ''}`;
      return `<div class="managed-storage-share" data-share-id="${esc(share.id)}"><strong>${esc(share.name || 'Offered storage')}</strong><span>${esc(status)} · ${esc(amount)}</span><button type="button" data-inspect-share>Manage</button></div>`;
    }).join('');
  }

  function detailsRow(label, value) {
    if (value == null || value === '') return '';
    return `<div class="storage-location-detail"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  }
  function scopeLabel(backup) {
    const policy = backup?.meta?.policy || backup?.remote?.policy || {};
    return policy.all === false ? policy.collectionName || `Collection ${policy.collectionId || ''}`.trim() : 'Everything';
  }

  function hiddenBackupButton(location, selector) {
    const row = document.querySelector(`#backups [data-backup-index="${Number(location.backupIndex)}"]`);
    return row?.querySelector(selector) || null;
  }
  function hiddenFriendButton(location, selector) {
    const id = location.targetId || String(location.id || '').replace(/^friend:/, '');
    return document.querySelector(`#backups [data-friend-backup="${CSS.escape(id)}"] ${selector}`);
  }

  function openLocation(location) {
    const numbers = storageNumbers(location);
    const status = location.online ? 'Online' : location.lastKnownAt ? `Offline · last seen ${age(location.lastKnownAt)}` : 'Offline';
    const rows = [];
    if (location.type === 'cloud') {
      rows.push(detailsRow('Role', 'Primary managed storage'), detailsRow('Server', location.server), detailsRow('Status', status));
    } else if (location.type === 'local') {
      rows.push(detailsRow('Device', location.device || 'This device'), detailsRow('Drive', location.path || location.name), detailsRow('Status', status));
      if (location.sources?.length) rows.push(detailsRow('Sources', location.sources.map(item => item.path).join('\n')));
    } else if (location.type === 'backup') {
      const backup = location.backup || {};
      rows.push(detailsRow('Path', backup.path || location.path), detailsRow('Backs up', scopeLabel(backup)), detailsRow('Files', Number(backup.local?.count || 0).toLocaleString()), detailsRow('Last update', backup.meta?.lastBackupAt ? age(backup.meta.lastBackupAt) : 'Not yet'), detailsRow('Last verify', backup.meta?.lastVerifiedAt ? age(backup.meta.lastVerifiedAt) : 'Not yet'), detailsRow('Status', status));
    } else if (location.type === 'friend') {
      const target = location.target || {};
      rows.push(detailsRow('Friend', target.peerName || location.peerName || 'Friend'), detailsRow('Connection', location.online ? (location.connection === 'relayed' ? 'Relayed through TURN' : 'Direct P2P') : 'Offline'), detailsRow('Encryption', 'End-to-end encrypted'), detailsRow('Last update', target.lastBackupAt ? age(target.lastBackupAt) : 'Not yet'), detailsRow('Last verify', target.lastVerifiedAt ? age(target.lastVerifiedAt) : 'Not yet'));
    }
    if (numbers.capacity) rows.push(detailsRow('Physical capacity', bytes(numbers.capacity)));

    let actions = '';
    if (location.type === 'cloud') {
      actions = `<button class="primary" data-location-action="cloud">Manage Cloud</button>`;
    } else if (location.type === 'local') {
      actions = `<button class="primary" data-location-action="source">Add source</button>`;
    } else if (location.type === 'backup') {
      const hasFiles = Number(location.backup?.local?.count || 0) > 0;
      actions = `<button class="primary" data-location-action="backup-update" ${location.online ? '' : 'disabled'}>Update</button><button class="secondary" data-location-action="backup-verify" ${hasFiles && location.online ? '' : 'disabled'}>Verify</button><button class="secondary" data-location-action="backup-restore" ${hasFiles ? '' : 'disabled'}>Restore</button><button class="secondary" data-location-action="backup-edit">Edit</button>`;
    } else if (location.type === 'friend') {
      const target = location.target || {};
      const hasBackup = Boolean(target.lastBackupAt || Number(target.coverage?.protectedBytes));
      actions = `<button class="primary" data-location-action="friend-update" ${location.online ? '' : 'disabled'}>Update</button><button class="secondary" data-location-action="friend-verify" ${hasBackup && location.online ? '' : 'disabled'}>Verify</button><button class="secondary" data-location-action="friend-restore" ${hasBackup ? '' : 'disabled'}>Restore</button><button class="secondary" data-location-action="friend-key">Recovery key</button>`;
    }

    delete inspectDialog.dataset.shareId;
    inspectDialog.dataset.locationId = location.id;
    inspectDialog.querySelector('[data-location-dialog-title]').textContent = locationTitle(location);
    inspectDialog.querySelector('[data-location-dialog-body]').innerHTML = `<div class="storage-location-inspect">
      <div class="storage-location-inspect-hero"><div class="storage-location-inspect-icon">${icon(location.type)}</div><div class="storage-location-inspect-copy"><strong>${esc(typeLabel(location))}</strong><span>${esc(cardMeta(location))}</span></div></div>
      <div class="storage-location-capacity">
        <div class="storage-location-capacity-head"><strong>${esc(numbers.used ? `${bytes(numbers.used)} managed` : 'No managed data yet')}</strong><span>${esc(numbers.free ? `${bytes(numbers.free)} free` : status)}</span></div>
        <div class="storage-location-capacity-track"><i style="width:${numbers.used ? `max(2px,${numbers.percent}%)` : '0'}"></i></div>
      </div>
      <dl class="storage-location-detail-list">${rows.join('')}</dl>
      <div class="storage-location-actions">${actions}</div>
    </div>`;
    if (!inspectDialog.open) inspectDialog.showModal();
  }

  function openShare(share) {
    const storage = share.storage || {};
    const quota = Number(share.quotaBytes) || 0;
    inspectDialog.dataset.shareId = share.id;
    delete inspectDialog.dataset.locationId;
    inspectDialog.querySelector('[data-location-dialog-title]').textContent = share.name || 'Offered storage';
    inspectDialog.querySelector('[data-location-dialog-body]').innerHTML = `<div class="storage-location-inspect">
      <div class="storage-location-inspect-hero"><div class="storage-location-inspect-icon">${icon('friend')}</div><div class="storage-location-inspect-copy"><strong>Offered to a friend</strong><span>${esc(share.paired ? `${share.peerName || 'Friend'} · ${storage.online ? 'online' : 'offline'}` : 'Waiting to pair')}</span></div></div>
      <dl class="storage-location-detail-list">${detailsRow('Folder', share.path || '')}${detailsRow('Used', bytes(storage.usedBytes || 0))}${detailsRow('Limit', quota ? bytes(quota) : 'Available free space')}${detailsRow('Paired with', share.paired ? share.peerName || 'Friend' : 'Nobody yet')}</dl>
      <div class="storage-location-actions"><button class="primary" data-location-action="share-invite">${share.paired ? 'Re-pair' : 'Invite'}</button><button class="secondary" data-location-action="share-remove">Stop offering</button></div>
    </div>`;
    if (!inspectDialog.open) inspectDialog.showModal();
  }

  function renderAddOptions() {
    const cloud = locations.find(item => item.type === 'cloud');
    addDialog.querySelector('[data-storage-add-options]').innerHTML = `
      <button class="storage-add-option" type="button" data-add-kind="cloud"><span class="storage-add-option-icon">${icon('cloud')}</span><span class="storage-add-option-copy"><strong>Cloud</strong><span>${cloud?.online ? 'Manage the primary Mochimono Cloud' : 'Connect a primary Mochimono Cloud'}</span></span><span class="storage-add-option-action">${cloud?.online ? 'Manage' : 'Connect'}</span></button>
      <button class="storage-add-option" type="button" data-add-kind="local"><span class="storage-add-option-icon">${icon('local')}</span><span class="storage-add-option-copy"><strong>Local storage</strong><span>Add another Source on this PC; local copies are derived from Sources</span></span><span class="storage-add-option-action">Add source</span></button>
      <button class="storage-add-option" type="button" data-add-kind="backup"><span class="storage-add-option-icon">${icon('backup')}</span><span class="storage-add-option-copy"><strong>Backup drive</strong><span>Add an independent folder or external drive</span></span><span class="storage-add-option-action">Add</span></button>
      <button class="storage-add-option" type="button" data-add-kind="friend"><span class="storage-add-option-icon">${icon('friend')}</span><span class="storage-add-option-copy"><strong>Friend drive</strong><span>Use encrypted storage a friend offered you</span></span><span class="storage-add-option-action">Pair</span></button>
      <button class="storage-add-option" type="button" data-add-kind="offer"><span class="storage-add-option-icon">${icon('friend')}</span><span class="storage-add-option-copy"><strong>Offer storage</strong><span>Give a friend encrypted space on this PC or drive</span></span><span class="storage-add-option-action">Offer</span></button>
      <div class="storage-add-note">Cloud is a single primary location. Backup and friend drives can be added multiple times. Local storage comes from the Sources you add above.</div>`;
  }

  function showConnectionDialog() {
    const dialog = document.querySelector('#connectionDialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function chooseBackup() {
    try {
      const picked = await json('/api/pick-folder');
      const path = String(picked.path || '').trim();
      if (!path) return;
      const existing = backups.find(item => pathKey(item.path) === pathKey(path));
      if (existing) {
        const location = locations.find(item => item.type === 'backup' && pathKey(item.path) === pathKey(path));
        if (addDialog.open) addDialog.close();
        if (location) openLocation(location);
        return;
      }
      pendingBackupPath = path;
      backupDialog.querySelector('[data-storage-backup-path]').textContent = path;
      backupDialog.querySelector('[data-storage-backup-name]').value = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || 'Backup';
      const select = backupDialog.querySelector('[data-storage-backup-scope]');
      select.innerHTML = '<option value="">Everything</option>';
      try {
        const collections = (await json('/api/backup-collections')).collections || [];
        if (collections.length) select.insertAdjacentHTML('beforeend', `<optgroup label="Smart Collections">${collections.map(item => `<option value="${Number(item.id)}" data-name="${esc(item.name)}">✦ ${esc(item.name)}</option>`).join('')}</optgroup>`);
      } catch {}
      if (addDialog.open) addDialog.close();
      if (!backupDialog.open) backupDialog.showModal();
    } catch (error) { toast(error.message); }
  }

  async function saveBackup() {
    if (!pendingBackupPath) return;
    const button = backupDialog.querySelector('[data-storage-backup-save]');
    const select = backupDialog.querySelector('[data-storage-backup-scope]');
    const collectionId = Number(select.value) || 0;
    const selected = select.selectedOptions[0];
    button.disabled = true;
    try {
      await json('/api/backup/init', { method:'POST', body:{ path:pendingBackupPath, name:backupDialog.querySelector('[data-storage-backup-name]').value.trim(), types:[], configure:false } });
      await json('/api/backup/policy', { method:'POST', body:{ path:pendingBackupPath, collectionId:collectionId || null, collectionName:collectionId ? selected?.dataset.name || selected?.textContent?.replace(/^✦\s*/, '') || '' : '' } });
      await json('/api/backup/update', { method:'POST', body:{ path:pendingBackupPath } });
      backupDialog.close();
      toast('Backup added');
      pendingBackupPath = '';
      setTimeout(refresh, 180);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }

  function trigger(selector) {
    const button = document.querySelector(selector);
    if (!button) { toast('That storage control is still loading.'); return false; }
    button.click();
    return true;
  }

  async function handleAction(action) {
    const location = locations.find(item => item.id === inspectDialog.dataset.locationId);
    const share = shares.find(item => item.id === inspectDialog.dataset.shareId);
    if (action === 'cloud') {
      inspectDialog.close();
      showConnectionDialog();
      return;
    }
    if (action === 'source') {
      inspectDialog.close();
      sourceSection.scrollIntoView({ behavior:'smooth', block:'start' });
      setTimeout(() => document.querySelector('#showFolderAdd')?.click(), 200);
      return;
    }
    if (action?.startsWith('backup-') && location) {
      const map = { 'backup-update':'[data-update]', 'backup-verify':'[data-verify]', 'backup-restore':'[data-restore]', 'backup-edit':'[data-configure]' };
      const button = hiddenBackupButton(location, map[action]);
      if (!button) return toast('Backup controls are still loading.');
      inspectDialog.close();
      button.click();
      return;
    }
    if (action?.startsWith('friend-') && location) {
      const map = { 'friend-update':'[data-friend-update]', 'friend-verify':'[data-friend-verify]', 'friend-restore':'[data-friend-restore]', 'friend-key':'[data-friend-key]' };
      const button = hiddenFriendButton(location, map[action]);
      if (!button) return toast('Friend drive controls are still loading.');
      inspectDialog.close();
      button.click();
      return;
    }
    if (action === 'share-invite' && share) {
      const button = document.querySelector(`.friend-share-list [data-friend-share="${CSS.escape(share.id)}"] [data-share-invite]`);
      if (!button) return toast('Friend sharing controls are still loading.');
      inspectDialog.close();
      button.click();
      return;
    }
    if (action === 'share-remove' && share) {
      const button = document.querySelector(`.friend-share-list [data-friend-share="${CSS.escape(share.id)}"] [data-share-remove]`);
      if (!button) return toast('Friend sharing controls are still loading.');
      inspectDialog.close();
      button.click();
    }
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = 0;
    if (refreshing || storagePane.hidden || document.hidden) return schedule(1800);
    refreshing = true;
    try {
      const [friendLocationResult, folderResult, backupResult, friendResult, shareResult, stateResult] = await Promise.allSettled([
        local('/local/storage-locations'),
        json('/api/folder-stats'),
        json('/api/backups'),
        local('/local/friend-backups'),
        local('/local/friend-shares'),
        json('/api/state')
      ]);
      const folderStats = folderResult.status === 'fulfilled' ? folderResult.value.folders || [] : [];
      backups = backupResult.status === 'fulfilled' ? backupResult.value.backups || [] : [];
      friendBackups = friendResult.status === 'fulfilled' ? friendResult.value.backups || [] : [];
      shares = shareResult.status === 'fulfilled' ? shareResult.value.shares || [] : [];
      state = stateResult.status === 'fulfilled' ? stateResult.value : null;
      const rawFriendLocations = friendLocationResult.status === 'fulfilled' ? (friendLocationResult.value.locations || []).filter(item => item.type === 'friend') : [];
      locations = enrichLocations(composeLocations(folderStats, backups, rawFriendLocations, state), friendBackups, state);
      render();
    } catch {}
    finally {
      refreshing = false;
      schedule(6000);
    }
  }
  function schedule(delay = 0) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, Math.max(0, delay));
  }

  grid.addEventListener('click', event => {
    const add = event.target.closest('[data-add-storage]');
    if (add) { renderAddOptions(); if (!addDialog.open) addDialog.showModal(); return; }
    const cardNode = event.target.closest('[data-location-id]');
    if (!cardNode) return;
    const location = locations.find(item => item.id === cardNode.dataset.locationId);
    if (location) openLocation(location);
  });
  shareList.addEventListener('click', event => {
    const row = event.target.closest('[data-share-id]');
    if (!row) return;
    const share = shares.find(item => item.id === row.dataset.shareId);
    if (share) openShare(share);
  });
  addDialog.addEventListener('click', event => {
    const kind = event.target.closest('[data-add-kind]')?.dataset.addKind;
    if (!kind) return;
    if (kind === 'cloud') { addDialog.close(); showConnectionDialog(); }
    else if (kind === 'local') { addDialog.close(); sourceSection.scrollIntoView({ behavior:'smooth', block:'start' }); setTimeout(() => document.querySelector('#showFolderAdd')?.click(), 200); }
    else if (kind === 'backup') chooseBackup();
    else if (kind === 'friend') { addDialog.close(); trigger('[data-add-friend-backup]'); }
    else if (kind === 'offer') { addDialog.close(); trigger('[data-offer-friend-storage]'); }
  });
  inspectDialog.addEventListener('click', event => {
    const action = event.target.closest('[data-location-action]')?.dataset.locationAction;
    if (action) handleAction(action);
  });
  inspectDialog.querySelector('[data-location-close]').onclick = () => inspectDialog.close();
  addDialog.querySelector('[data-storage-add-close]').onclick = () => addDialog.close();
  backupDialog.querySelectorAll('[data-storage-backup-close]').forEach(button => button.onclick = () => backupDialog.close());
  backupDialog.querySelector('[data-storage-backup-choose]').onclick = () => { backupDialog.close(); chooseBackup(); };
  backupDialog.querySelector('[data-storage-backup-save]').onclick = saveBackup;

  window.addEventListener('focus', () => schedule(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  schedule(80);
}
