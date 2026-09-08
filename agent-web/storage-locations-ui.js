const storagePane = document.querySelector('#storagePane');
const sourceSection = document.querySelector('.storage-folders-section');
const backupSection = document.querySelector('.storage-backups-section');
const toastNode = document.querySelector('#toast');

if (storagePane && sourceSection && backupSection) {
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const friendOrigin = `http://${host}:8644`;
  let locations = [];
  let backups = [];
  let friendBackups = [];
  let shares = [];
  let agentState = null;
  let timer = 0;
  let busy = false;
  let pendingBackupPath = '';

  sourceSection.querySelector(':scope > .storage-section-heading')?.remove();
  document.querySelector('.managed-storage-section')?.remove();

  const style = document.createElement('style');
  style.textContent = `
    #storagePane .storage-backups-section{display:none!important}
    #storagePane .storage-folders-section>.storage-section-heading{grid-column:1/-1}
    .storage-section-heading{grid-column:1/-1;margin:0 0 -2px}
    .storage-section-heading h2{margin:0;color:#eee6e2;font-size:19px;font-weight:760;letter-spacing:-.025em}

    .managed-storage-section{margin-top:20px;padding-top:27px;border-top:1px solid #211e21}
    .managed-storage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:14px}
    .managed-storage-card{min-width:0;padding:0;overflow:hidden;border:1px solid #2b282b;border-radius:15px;background:#121013;color:#ebe3df;text-align:left;box-shadow:none;transition:border-color .12s ease,background .12s ease}
    .managed-storage-card:hover,.managed-storage-card:focus-visible{border-color:#494148;background:#151316;outline:none}
    .managed-storage-card.offline{opacity:.68}.managed-storage-card.offline:hover{opacity:.9}
    .managed-storage-visual{height:106px;display:grid;place-items:center;border-bottom:1px solid #242124;background:#100f11}
    .managed-storage-icon{width:52px;height:52px;display:grid;place-items:center;border-radius:13px;background:#19171a;color:#aaa19e}
    .managed-storage-icon svg{width:29px;height:29px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
    .managed-storage-icon.mochimono{background:transparent}
    .managed-storage-icon.mochimono .mini{transform:scale(1.48)}
    .managed-storage-copy{padding:14px 15px 15px}
    .managed-storage-title{display:flex;align-items:center;gap:8px;min-width:0}
    .managed-storage-title strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f0e8e4;font-size:16px;font-weight:740;letter-spacing:-.015em}
    .managed-storage-dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#78b98a}.offline .managed-storage-dot{background:#71696a}
    .managed-storage-meta{display:block;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8b8380;font-size:12px;font-weight:520}
    .managed-storage-space{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;color:#a89f9b;font-size:12px;font-weight:650}
    .managed-storage-space .free{color:#d4cbc7}
    .managed-storage-meter{display:block;height:5px;margin-top:7px;overflow:hidden;border-radius:999px;background:#292529}
    .managed-storage-meter i{display:block;height:100%;border-radius:inherit;background:#d99892;transition:width .2s ease}
    .managed-storage-card[data-location-type="friend"] .managed-storage-meter i{background:#9184c5}

    .managed-storage-add{border-style:dashed;background:#100f11}
    .managed-storage-add .managed-storage-visual{height:106px}
    .managed-storage-add-mark{width:48px;height:48px;display:grid;place-items:center;border:1px dashed #4a4347;border-radius:13px;color:#777073;font-size:29px;font-weight:250}
    .managed-storage-add:hover .managed-storage-add-mark{border-color:#665b61;color:#b8aeaa}
    .managed-storage-add .managed-storage-copy{min-height:69px;display:flex;align-items:center}

    .managed-storage-shares{margin-top:22px;padding-top:18px;border-top:1px solid #211e21}.managed-storage-shares[hidden]{display:none!important}
    .managed-storage-shares h3{margin:0 0 10px;color:#c9bfbb;font-size:14px;font-weight:700}
    .managed-storage-share-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:9px}
    .managed-storage-share{display:flex;align-items:center;gap:9px;min-width:0;padding:11px 12px;border:1px solid #292529;border-radius:11px;background:#111012;color:#968d89;font-size:12px;cursor:pointer}
    .managed-storage-share:hover{border-color:#413a40;background:#151316}.managed-storage-share strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd4d0;font-size:13px}

    .storage-location-dialog{width:min(550px,calc(100vw - 28px))}.storage-location-dialog .dialog-head h3{max-width:390px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:17px}
    .storage-location-inspect{display:grid;gap:15px}
    .storage-location-inspect-head{display:grid;grid-template-columns:46px minmax(0,1fr);gap:12px;align-items:center}
    .storage-location-inspect-icon{width:46px;height:46px;display:grid;place-items:center;border-radius:11px;background:#19171a;color:#aaa19e}.storage-location-inspect-icon.mochimono{background:transparent}.storage-location-inspect-icon.mochimono .mini{transform:scale(1.3)}
    .storage-location-inspect-icon svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
    .storage-location-inspect-head strong{display:block;color:#ebe3df;font-size:15px}.storage-location-inspect-head span{display:block;margin-top:2px;color:#8c8380;font-size:12px}
    .storage-location-capacity{display:grid;gap:7px}.storage-location-capacity-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#9a918e;font-size:12px}.storage-location-capacity-head strong{color:#d9d0cc;font-size:13px}
    .storage-location-capacity-track{height:6px;overflow:hidden;border-radius:999px;background:#292529}.storage-location-capacity-track i{display:block;height:100%;border-radius:inherit;background:#dc9690}
    .storage-location-detail-list{display:grid;margin:0}.storage-location-detail{display:grid;grid-template-columns:105px minmax(0,1fr);gap:12px;padding:10px 0;border-top:1px solid #242124;font-size:13px}.storage-location-detail:first-child{border-top:0}.storage-location-detail dt{color:#817976}.storage-location-detail dd{margin:0;min-width:0;overflow-wrap:anywhere;color:#c9c0bc;white-space:pre-line}
    .storage-location-actions{display:flex;gap:7px;flex-wrap:wrap}.storage-location-actions button{font-size:12px}.storage-location-actions .secondary{background:#211e22;color:#c4bbb7}.storage-location-actions .secondary:hover{background:#2b272c;color:#fff}

    .storage-add-options{display:grid;gap:8px}.storage-add-option{width:100%;display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:11px;align-items:center;padding:11px;border:1px solid #2b282b;border-radius:11px;background:#121013;color:#d1c8c4;text-align:left}.storage-add-option:hover{border-color:#494148;background:#171518}.storage-add-option-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:9px;background:#1b191c;color:#aaa19e}.storage-add-option-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.storage-add-option strong{font-size:14px}.storage-add-option-action{color:#9a918d;font-size:12px;font-weight:680}
    .storage-backup-path{padding:9px 10px;border:1px solid #2b272b;border-radius:9px;background:#111012;color:#aaa19e;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
    .storage-location-dialog .field-label{font-size:12px}.storage-location-dialog input,.storage-location-dialog select{font-size:13px}
    @media(max-width:700px){.managed-storage-grid{grid-template-columns:1fr}.managed-storage-share-list{grid-template-columns:1fr}.storage-location-detail{grid-template-columns:88px minmax(0,1fr)}}
  `;
  document.head.append(style);

  const sourceHeading = document.createElement('div');
  sourceHeading.className = 'storage-section-heading';
  sourceHeading.innerHTML = '<h2>Sources</h2>';
  sourceSection.prepend(sourceHeading);

  const section = document.createElement('section');
  section.className = 'managed-storage-section';
  section.innerHTML = `
    <div class="storage-section-heading"><h2>Storage</h2></div>
    <div class="managed-storage-grid" data-storage-grid></div>
    <div class="managed-storage-shares" data-storage-shares hidden><h3>Shared</h3><div class="managed-storage-share-list" data-share-list></div></div>`;
  sourceSection.after(section);

  const inspectDialog = document.createElement('dialog');
  inspectDialog.className = 'small-dialog storage-location-dialog';
  inspectDialog.innerHTML = `<div class="dialog-head"><h3 data-inspect-title>Storage</h3><button class="icon" data-inspect-close>×</button></div><div data-inspect-body></div>`;
  document.body.append(inspectDialog);

  const addDialog = document.createElement('dialog');
  addDialog.className = 'small-dialog storage-location-dialog';
  addDialog.innerHTML = `<div class="dialog-head"><h3>Add storage</h3><button class="icon" data-add-close>×</button></div><div class="storage-add-options">
    <button class="storage-add-option" data-add-kind="backup"><span class="storage-add-option-icon"></span><strong>Backup drive</strong><span class="storage-add-option-action">Add</span></button>
    <button class="storage-add-option" data-add-kind="friend"><span class="storage-add-option-icon"></span><strong>Friend drive</strong><span class="storage-add-option-action">Pair</span></button>
    <button class="storage-add-option" data-add-kind="offer"><span class="storage-add-option-icon"></span><strong>Offer space</strong><span class="storage-add-option-action">Share</span></button>
  </div>`;
  document.body.append(addDialog);

  const addBackupDialog = document.createElement('dialog');
  addBackupDialog.className = 'small-dialog storage-location-dialog';
  addBackupDialog.innerHTML = `
    <div class="dialog-head"><h3>Add backup</h3><button class="icon" data-backup-close>×</button></div>
    <div class="field-stack">
      <div class="storage-backup-path" data-backup-path>No folder selected</div>
      <label class="field-label">Name</label><input data-backup-name placeholder="Backup">
      <label class="field-label">Files</label><select data-backup-scope><option value="">Everything</option></select>
    </div>
    <div class="dialog-actions"><button class="secondary" data-backup-choose>Choose</button><div class="spacer"></div><button class="secondary" data-backup-close>Cancel</button><button class="primary" data-backup-save>Add</button></div>`;
  document.body.append(addBackupDialog);

  const grid = section.querySelector('[data-storage-grid]');
  const sharesBlock = section.querySelector('[data-storage-shares]');
  const shareList = section.querySelector('[data-share-list]');

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;' }[char]));
  const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  const pathName = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');

  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    clearTimeout(toastNode.timer);
    toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
  }

  function bytes(number) {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Math.max(0, Number(number) || 0), unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function age(value) {
    const time = new Date(value || 0).getTime();
    if (!time) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60); if (hours < 48) return `${hours}h ago`;
    const days = Math.floor(hours / 24); if (days < 60) return `${days}d ago`;
    const months = Math.floor(days / 30.44); if (months < 24) return `${Math.max(1, months)}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  async function json(path, options = {}) {
    const response = await fetch(path, {
      cache:'no-store',
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
      body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  async function local(path, options = {}) {
    return json(`${friendOrigin}${path}`, options);
  }

  function icon(type, small = false) {
    if (type === 'cloud') return `<span class="${small ? 'storage-location-inspect-icon' : 'managed-storage-icon'} mochimono"><span class="mini" aria-hidden="true"></span></span>`;
    const svg = type === 'backup'
      ? '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="7" width="22" height="18" rx="4"/><path d="M9 20h14M10 12h12"/><circle cx="11" cy="20" r="1"/></svg>'
      : type === 'friend'
        ? '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm12 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M3.5 26c.8-5 3-7.5 6.5-7.5s5.7 2.5 6.5 7.5M17 25c.5-3.8 2.2-5.8 5-5.8 2.7 0 4.6 2 5.3 5.8"/></svg>'
        : '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="5"/><path d="M9 21h14M10 10h12"/><circle cx="11" cy="21" r="1"/></svg>';
    return `<span class="${small ? 'storage-location-inspect-icon' : 'managed-storage-icon'}">${svg}</span>`;
  }

  function title(location) {
    if (location.type === 'cloud') return 'Cloud';
    if (location.type === 'local') return location.label || location.path || 'Local';
    return location.name || (location.type === 'backup' ? 'Backup' : 'Friend drive');
  }

  function secondary(location) {
    if (!location.online) return 'Offline';
    if (location.type === 'cloud') {
      try { return new URL(location.server || '').host || 'Connected'; } catch { return 'Connected'; }
    }
    if (location.type === 'local') return location.path || 'This PC';
    if (location.type === 'backup') return location.path || 'Backup';
    if (location.type === 'friend') {
      const link = location.connection === 'relayed' ? 'Relayed' : location.connection === 'direct' ? 'Direct' : '';
      return [location.peerName || 'Friend', link].filter(Boolean).join(' · ');
    }
    return '';
  }

  function usage(location) {
    const used = Math.max(0, Number(location.mochimonoBytes) || 0);
    const free = Math.max(0, Number(location.freeBytes) || 0);
    const basis = used + free;
    return { used, free, percent:basis ? Math.max(0, Math.min(100, used / basis * 100)) : 0 };
  }

  function card(location) {
    const u = usage(location);
    const left = u.used ? `${bytes(u.used)} used` : '';
    const right = location.online ? (u.free ? `${bytes(u.free)} free` : 'Online') : 'Offline';
    return `<button class="managed-storage-card ${location.online ? '' : 'offline'}" type="button" data-location-id="${esc(location.id)}" data-location-type="${esc(location.type)}">
      <div class="managed-storage-visual">${icon(location.type)}</div>
      <div class="managed-storage-copy">
        <div class="managed-storage-title"><i class="managed-storage-dot"></i><strong>${esc(title(location))}</strong></div>
        <span class="managed-storage-meta">${esc(secondary(location))}</span>
        <div class="managed-storage-space"><span>${esc(left)}</span><span class="free">${esc(right)}</span></div>
        ${u.used && u.free ? `<span class="managed-storage-meter"><i style="width:${u.percent}%"></i></span>` : ''}
      </div>
    </button>`;
  }

  function render() {
    grid.innerHTML = locations.map(card).join('') + `<button class="managed-storage-card managed-storage-add" type="button" data-add-storage><div class="managed-storage-visual"><span class="managed-storage-add-mark">＋</span></div><div class="managed-storage-copy"><div class="managed-storage-title"><strong>Add storage</strong></div></div></button>`;
    sharesBlock.hidden = !shares.length;
    shareList.innerHTML = shares.map(share => {
      const status = share.paired ? (share.peerName || 'Friend') : 'Not paired';
      const used = Number(share.storage?.usedBytes) || 0;
      return `<button class="managed-storage-share" type="button" data-share-id="${esc(share.id)}"><strong>${esc(share.name || 'Shared space')}</strong><span>${esc(status)}${used ? ` · ${bytes(used)}` : ''}</span></button>`;
    }).join('');
  }

  function row(label, value) {
    if (value == null || value === '') return '';
    return `<div class="storage-location-detail"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  }

  function hiddenBackupButton(location, selector) {
    return document.querySelector(`#backups [data-backup-index="${Number(location.backupIndex)}"] ${selector}`);
  }
  function hiddenFriendButton(location, selector) {
    const id = location.targetId || String(location.id || '').replace(/^friend:/, '');
    return document.querySelector(`#backups [data-friend-backup="${CSS.escape(id)}"] ${selector}`);
  }

  function openLocation(location) {
    const u = usage(location);
    const details = [];
    if (location.type === 'cloud') {
      details.push(row('Server', location.server || '—'), row('Status', location.online ? 'Online' : 'Offline'));
    } else if (location.type === 'local') {
      details.push(
        row('Path', location.path || '—'),
        row('Contains', location.contents || 'Index · thumbnails · local metadata'),
        row('Drive', location.root || ''),
        row('Status', location.online ? 'Online' : 'Offline')
      );
    } else if (location.type === 'backup') {
      const backup = location.backup || {};
      const policy = backup.meta?.policy || backup.remote?.policy || {};
      details.push(
        row('Path', backup.path || location.path),
        row('Files', policy.all === false ? policy.collectionName || 'Collection' : 'Everything'),
        row('Updated', backup.meta?.lastBackupAt ? age(backup.meta.lastBackupAt) : 'Never'),
        row('Verified', backup.meta?.lastVerifiedAt ? age(backup.meta.lastVerifiedAt) : 'Never')
      );
    } else if (location.type === 'friend') {
      const target = location.target || {};
      details.push(
        row('Friend', target.peerName || location.peerName || 'Friend'),
        row('Link', location.online ? (location.connection === 'relayed' ? 'Relayed' : 'Direct') : 'Offline'),
        row('Updated', target.lastBackupAt ? age(target.lastBackupAt) : 'Never'),
        row('Verified', target.lastVerifiedAt ? age(target.lastVerifiedAt) : 'Never')
      );
    }

    let actions = '';
    if (location.type === 'cloud') {
      actions = `<button class="primary" data-action="cloud">${location.online ? 'Manage' : 'Connect'}</button>`;
    } else if (location.type === 'backup') {
      const hasFiles = Number(location.backup?.local?.count || 0) > 0;
      actions = `<button class="primary" data-action="backup-update" ${location.online ? '' : 'disabled'}>Update</button><button class="secondary" data-action="backup-verify" ${hasFiles && location.online ? '' : 'disabled'}>Verify</button><button class="secondary" data-action="backup-restore" ${hasFiles ? '' : 'disabled'}>Restore</button><button class="secondary" data-action="backup-edit">Edit</button>`;
    } else if (location.type === 'friend') {
      const target = location.target || {};
      const hasFiles = Boolean(target.lastBackupAt || Number(target.coverage?.protectedBytes));
      actions = `<button class="primary" data-action="friend-update" ${location.online ? '' : 'disabled'}>Update</button><button class="secondary" data-action="friend-verify" ${hasFiles && location.online ? '' : 'disabled'}>Verify</button><button class="secondary" data-action="friend-restore" ${hasFiles ? '' : 'disabled'}>Restore</button><button class="secondary" data-action="friend-key">Key</button>`;
    }

    inspectDialog.dataset.locationId = location.id;
    delete inspectDialog.dataset.shareId;
    inspectDialog.querySelector('[data-inspect-title]').textContent = title(location);
    inspectDialog.querySelector('[data-inspect-body]').innerHTML = `<div class="storage-location-inspect">
      <div class="storage-location-inspect-head">${icon(location.type, true)}<div><strong>${esc(location.type === 'local' ? 'Local cache' : location.type === 'friend' ? 'Friend drive' : location.type === 'backup' ? 'Backup drive' : 'Mochimono Cloud')}</strong><span>${esc(secondary(location))}</span></div></div>
      ${(u.used || u.free) ? `<div class="storage-location-capacity"><div class="storage-location-capacity-head"><strong>${u.used ? `${bytes(u.used)} used` : ''}</strong><span>${u.free ? `${bytes(u.free)} free` : ''}</span></div>${u.used && u.free ? `<div class="storage-location-capacity-track"><i style="width:${u.percent}%"></i></div>` : ''}</div>` : ''}
      <dl class="storage-location-detail-list">${details.join('')}</dl>
      ${actions ? `<div class="storage-location-actions">${actions}</div>` : ''}
    </div>`;
    if (!inspectDialog.open) inspectDialog.showModal();
  }

  function openShare(share) {
    const storage = share.storage || {};
    inspectDialog.dataset.shareId = share.id;
    delete inspectDialog.dataset.locationId;
    inspectDialog.querySelector('[data-inspect-title]').textContent = share.name || 'Shared space';
    inspectDialog.querySelector('[data-inspect-body]').innerHTML = `<div class="storage-location-inspect">
      <div class="storage-location-inspect-head">${icon('friend', true)}<div><strong>Shared space</strong><span>${esc(share.paired ? share.peerName || 'Friend' : 'Not paired')}</span></div></div>
      <dl class="storage-location-detail-list">${row('Path', share.path || '')}${row('Used', bytes(storage.usedBytes || 0))}${row('Limit', Number(share.quotaBytes) ? bytes(share.quotaBytes) : 'No limit')}</dl>
      <div class="storage-location-actions"><button class="primary" data-action="share-invite">${share.paired ? 'Re-pair' : 'Invite'}</button><button class="secondary" data-action="share-remove">Stop</button></div>
    </div>`;
    if (!inspectDialog.open) inspectDialog.showModal();
  }

  async function chooseBackup() {
    try {
      const picked = await json('/api/pick-folder');
      const path = String(picked.path || '').trim();
      if (!path) return;
      const existingIndex = backups.findIndex(item => pathKey(item.path) === pathKey(path));
      if (existingIndex >= 0) {
        addDialog.close();
        const location = locations.find(item => item.type === 'backup' && item.backupIndex === existingIndex);
        if (location) openLocation(location);
        return;
      }
      pendingBackupPath = path;
      addBackupDialog.querySelector('[data-backup-path]').textContent = path;
      addBackupDialog.querySelector('[data-backup-name]').value = pathName(path) || 'Backup';
      const select = addBackupDialog.querySelector('[data-backup-scope]');
      select.innerHTML = '<option value="">Everything</option>';
      try {
        const collections = (await json('/api/backup-collections')).collections || [];
        if (collections.length) select.insertAdjacentHTML('beforeend', `<optgroup label="Collections">${collections.map(item => `<option value="${Number(item.id)}" data-name="${esc(item.name)}">${esc(item.name)}</option>`).join('')}</optgroup>`);
      } catch {}
      addDialog.close();
      if (!addBackupDialog.open) addBackupDialog.showModal();
    } catch (error) { toast(error.message); }
  }

  async function saveBackup() {
    if (!pendingBackupPath) return;
    const button = addBackupDialog.querySelector('[data-backup-save]');
    const select = addBackupDialog.querySelector('[data-backup-scope]');
    const collectionId = Number(select.value) || 0;
    button.disabled = true;
    try {
      await json('/api/backup/init', { method:'POST', body:{ path:pendingBackupPath, name:addBackupDialog.querySelector('[data-backup-name]').value.trim(), types:[], configure:false } });
      await json('/api/backup/policy', { method:'POST', body:{ path:pendingBackupPath, collectionId:collectionId || null, collectionName:collectionId ? select.selectedOptions[0]?.dataset.name || select.selectedOptions[0]?.textContent || '' : '' } });
      await json('/api/backup/update', { method:'POST', body:{ path:pendingBackupPath } });
      addBackupDialog.close();
      pendingBackupPath = '';
      toast('Backup added');
      schedule(200);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }

  function trigger(selector) {
    const button = document.querySelector(selector);
    if (!button) return toast('Still loading.');
    button.click();
  }

  function handleAction(action) {
    const location = locations.find(item => item.id === inspectDialog.dataset.locationId);
    const share = shares.find(item => item.id === inspectDialog.dataset.shareId);
    if (action === 'cloud') {
      inspectDialog.close();
      const dialog = document.querySelector('#connectionDialog');
      if (dialog && !dialog.open) dialog.showModal();
      return;
    }
    if (action?.startsWith('backup-') && location) {
      const selectors = { 'backup-update':'[data-update]', 'backup-verify':'[data-verify]', 'backup-restore':'[data-restore]', 'backup-edit':'[data-configure]' };
      const button = hiddenBackupButton(location, selectors[action]);
      if (!button) return toast('Still loading.');
      inspectDialog.close();
      button.click();
      return;
    }
    if (action?.startsWith('friend-') && location) {
      const selectors = { 'friend-update':'[data-friend-update]', 'friend-verify':'[data-friend-verify]', 'friend-restore':'[data-friend-restore]', 'friend-key':'[data-friend-key]' };
      const button = hiddenFriendButton(location, selectors[action]);
      if (!button) return toast('Still loading.');
      inspectDialog.close();
      button.click();
      return;
    }
    if (action === 'share-invite' && share) {
      inspectDialog.close();
      trigger(`.friend-share-list [data-friend-share="${CSS.escape(share.id)}"] [data-share-invite]`);
      return;
    }
    if (action === 'share-remove' && share) {
      inspectDialog.close();
      trigger(`.friend-share-list [data-friend-share="${CSS.escape(share.id)}"] [data-share-remove]`);
    }
  }

  function fallbackLocations(state, backupData) {
    const result = [];
    const stats = state?.server?.online ? state.server.stats : null;
    result.push(stats ? { id:'cloud', type:'cloud', name:'Cloud', online:true, server:state.settings?.server || '', capacityBytes:Number(stats.capacityBytes) || 0, freeBytes:Number(stats.freeBytes) || 0, mochimonoBytes:Number(stats.bytes) || 0 } : { id:'cloud', type:'cloud', name:'Cloud', online:false, server:state?.settings?.server || '' });
    for (let index = 0; index < backupData.length; index++) {
      const backup = backupData[index];
      result.push({ id:`backup:${index}:${pathKey(backup.path)}`, type:'backup', name:backup.meta?.name || pathName(backup.path) || 'Backup', path:backup.path, online:Number(backup.totalBytes) > 0, capacityBytes:Number(backup.totalBytes) || 0, freeBytes:Number(backup.freeBytes) || 0, mochimonoBytes:Number(backup.local?.bytes) || 0, backupIndex:index, backup });
    }
    return result;
  }

  function enrich(raw, state) {
    const output = [];
    const rawCloud = raw.find(item => item.type === 'cloud');
    const cloudStats = state?.server?.online ? state.server.stats : null;
    output.push(rawCloud ? { ...rawCloud, server:state?.settings?.server || '' } : cloudStats ? { id:'cloud', type:'cloud', name:'Cloud', online:true, server:state?.settings?.server || '', capacityBytes:Number(cloudStats.capacityBytes) || 0, freeBytes:Number(cloudStats.freeBytes) || 0, mochimonoBytes:Number(cloudStats.bytes) || 0 } : { id:'cloud', type:'cloud', name:'Cloud', online:false, server:state?.settings?.server || '' });

    for (const localLocation of raw.filter(item => item.type === 'local')) {
      const label = localLocation.name || 'Local cache';
      output.push({ ...localLocation, label });
    }

    for (let index = 0; index < backups.length; index++) {
      const backup = backups[index];
      const rawBackup = raw.find(item => item.type === 'backup' && pathKey(item.path) === pathKey(backup.path));
      output.push({
        ...(rawBackup || {}),
        id:`backup:${index}:${pathKey(backup.path)}`,
        type:'backup',
        name:backup.meta?.name || pathName(backup.path) || 'Backup',
        path:backup.path,
        online:rawBackup ? rawBackup.online : Number(backup.totalBytes) > 0,
        capacityBytes:Number(rawBackup?.capacityBytes) || Number(backup.totalBytes) || 0,
        freeBytes:Number(rawBackup?.freeBytes) || Number(backup.freeBytes) || 0,
        mochimonoBytes:Number(backup.local?.bytes) || 0,
        backupIndex:index,
        backup
      });
    }

    for (const rawFriend of raw.filter(item => item.type === 'friend')) {
      const targetId = String(rawFriend.id || '').replace(/^friend:/, '');
      const target = friendBackups.find(item => String(item.id) === targetId);
      output.push({ ...rawFriend, targetId, target, peerName:target?.peerName || '', name:target?.name || rawFriend.name || 'Friend drive' });
    }

    return output.sort((a, b) => ({ cloud:0, local:1, backup:2, friend:3 }[a.type] ?? 9) - ({ cloud:0, local:1, backup:2, friend:3 }[b.type] ?? 9) || title(a).localeCompare(title(b)));
  }

  async function refresh() {
    clearTimeout(timer);
    timer = 0;
    if (busy || storagePane.hidden || document.hidden) return schedule(1800);
    busy = true;
    try {
      const [stateResult, backupResult, rawResult, friendResult, shareResult] = await Promise.allSettled([
        json('/api/state'),
        json('/api/backups'),
        local('/local/storage-locations'),
        local('/local/friend-backups'),
        local('/local/friend-shares')
      ]);
      agentState = stateResult.status === 'fulfilled' ? stateResult.value : null;
      backups = backupResult.status === 'fulfilled' ? backupResult.value.backups || [] : [];
      friendBackups = friendResult.status === 'fulfilled' ? friendResult.value.backups || [] : [];
      shares = shareResult.status === 'fulfilled' ? shareResult.value.shares || [] : [];
      const raw = rawResult.status === 'fulfilled' ? rawResult.value.locations || [] : fallbackLocations(agentState, backups);
      locations = enrich(raw, agentState);
      render();
    } finally {
      busy = false;
      schedule(6000);
    }
  }

  function schedule(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(refresh, Math.max(0, delay));
  }

  addDialog.querySelector('[data-add-kind="backup"] .storage-add-option-icon').innerHTML = icon('backup').replace(/^<span[^>]*>|<\/span>$/g, '');
  addDialog.querySelector('[data-add-kind="friend"] .storage-add-option-icon').innerHTML = icon('friend').replace(/^<span[^>]*>|<\/span>$/g, '');
  addDialog.querySelector('[data-add-kind="offer"] .storage-add-option-icon').innerHTML = icon('friend').replace(/^<span[^>]*>|<\/span>$/g, '');

  grid.addEventListener('click', event => {
    if (event.target.closest('[data-add-storage]')) {
      if (!addDialog.open) addDialog.showModal();
      return;
    }
    const node = event.target.closest('[data-location-id]');
    const location = node && locations.find(item => item.id === node.dataset.locationId);
    if (location) openLocation(location);
  });

  shareList.addEventListener('click', event => {
    const node = event.target.closest('[data-share-id]');
    const share = node && shares.find(item => item.id === node.dataset.shareId);
    if (share) openShare(share);
  });

  addDialog.addEventListener('click', event => {
    const kind = event.target.closest('[data-add-kind]')?.dataset.addKind;
    if (!kind) return;
    if (kind === 'backup') chooseBackup();
    else if (kind === 'friend') { addDialog.close(); trigger('[data-add-friend-backup]'); }
    else if (kind === 'offer') { addDialog.close(); trigger('[data-offer-friend-storage]'); }
  });

  inspectDialog.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) handleAction(action);
  });

  inspectDialog.querySelector('[data-inspect-close]').onclick = () => inspectDialog.close();
  addDialog.querySelector('[data-add-close]').onclick = () => addDialog.close();
  addBackupDialog.querySelectorAll('[data-backup-close]').forEach(button => button.onclick = () => addBackupDialog.close());
  addBackupDialog.querySelector('[data-backup-choose]').onclick = () => { addBackupDialog.close(); chooseBackup(); };
  addBackupDialog.querySelector('[data-backup-save]').onclick = saveBackup;
  window.addEventListener('focus', () => schedule(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  schedule(80);
}
