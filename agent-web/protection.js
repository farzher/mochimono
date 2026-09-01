const CONTROL = 'http://127.0.0.1:8645';
const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const backupSection = [...document.querySelectorAll('#storagePane .dashboard-section')].find(section => section.querySelector('h2')?.textContent === 'Backups');
let state = null;
let refreshTimer = null;
let dialog = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
const LEVELS = [['disposable','Disposable'],['normal','Normal'],['important','Important'],['critical','Critical']];

function bytes(number) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function age(value) {
  const time = new Date(value || 0).getTime();
  if (!time) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

async function control(path, options = {}) {
  const response = await fetch(`${CONTROL}${path}`, { ...options, headers:{ 'content-type':'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function server(path, options = {}) {
  const response = await fetch(path, { ...options, headers:{ 'content-type':'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function toast(text) {
  const target = document.querySelector('#toast');
  if (!target) return;
  target.textContent = text;
  target.classList.add('show');
  clearTimeout(target.timer);
  target.timer = setTimeout(() => target.classList.remove('show'), 2800);
}

const style = document.createElement('style');
style.textContent = `
  .protection-dashboard{display:grid;gap:12px}.protection-summary{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
  .protection-summary strong{font-size:18px}.protection-summary .good{color:#a9c9ae}.protection-summary .warn{color:#d4b786}
  .protection-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.protection-controls select{width:auto;min-width:110px}
  .protection-meter{height:5px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden}.protection-meter i{display:block;height:100%;background:currentColor;border-radius:inherit}
  .protection-levels{display:flex;gap:8px;flex-wrap:wrap;color:#8f8784;font-size:11px}.protection-levels span{white-space:nowrap}.protection-levels b{color:#cfc8c5}
  .protection-note{font-size:10px;color:#827b78;line-height:1.5}.storage-locations{display:grid;gap:6px;margin-top:2px}
  .protection-location{display:grid;grid-template-columns:minmax(120px,1fr) auto auto;align-items:center;gap:8px;padding:8px 0;border-top:1px solid rgba(255,255,255,.055)}
  .protection-location:first-child{border-top:0}.protection-location strong{display:block;font-size:12px}.protection-location small{display:block;color:#77706e;margin-top:2px;line-height:1.45}
  .protection-location select{width:auto;min-width:82px;padding:5px 7px;font-size:10px}.protection-location input{width:120px;padding:5px 7px;font-size:10px}
  .location-online{color:#a9c9ae}.location-offline{color:#c19a8f}.location-unknown{color:#9d9693}
  .folder-protection-level{width:auto!important;min-width:86px;padding:4px 6px!important;font-size:9px!important;margin-right:2px}
  .protection-running{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:7px 9px;border-radius:7px;background:rgba(255,255,255,.035);font-size:10px;color:#9d9693}.protection-running strong{color:#d5cfcc}
  .protection-dialog .field-stack{gap:9px}.protection-dialog textarea{min-height:72px;resize:vertical}
  .peer-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid rgba(255,255,255,.055)}
  .peer-row small{display:block;color:#77706e;line-height:1.45}.peer-online{color:#a9c9ae}.peer-offline{color:#b99186}.peer-actions{display:flex;gap:7px;align-items:center}
  .trash-list{max-height:50vh;overflow:auto;display:grid;gap:5px}.trash-file{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid rgba(255,255,255,.055)}
  @media(max-width:700px){.protection-location{grid-template-columns:1fr auto}.protection-location input{grid-column:1/-1;width:100%}}
`;
document.head.append(style);

function section() {
  let element = document.querySelector('#protectionDashboard');
  if (element) return element;
  element = document.createElement('section');
  element.id = 'protectionDashboard';
  element.className = 'dashboard-section protection-dashboard';
  element.innerHTML = '<div class="section-head"><h2>Protection</h2><div class="section-actions"><button id="protectionRefresh" class="round-action subtle" title="Refresh" aria-label="Refresh">↻</button></div></div><div id="protectionBody" class="muted">Loading…</div>';
  if (backupSection) storagePane.insertBefore(element, backupSection); else storagePane.append(element);
  element.querySelector('#protectionRefresh').onclick = () => refresh(true);
  return element;
}

function ruleForImport(importId) {
  return state?.rules?.find(rule => rule.scopeType === 'import' && Number(rule.scopeId) === Number(importId))?.level || 'normal';
}

function decorateFolders() {
  if (!state) return;
  const byPath = new Map((state.folders || []).map(folder => [String(folder.path).replace(/[\\/]+$/,'').toLowerCase(), folder]));
  for (const row of folders?.querySelectorAll('[data-folder-path]') || []) {
    if (row.querySelector('.folder-protection-level')) continue;
    const folder = byPath.get(String(row.dataset.folderPath || '').replace(/[\\/]+$/,'').toLowerCase());
    if (!folder?.importId) continue;
    const select = document.createElement('select');
    select.className = 'folder-protection-level';
    select.title = 'Protection importance';
    select.innerHTML = LEVELS.map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
    select.value = ruleForImport(folder.importId);
    select.onchange = async () => {
      select.disabled = true;
      try { await control('/api/client/protection/folder-level', { method:'POST', body:JSON.stringify({ importId:folder.importId, level:select.value }) }); await refresh(true); }
      catch (error) { toast(error.message); }
      finally { select.disabled = false; }
    };
    row.querySelector('.item-actions')?.prepend(select);
  }
}

function locationLabel(location) {
  const bits = [location.remote ? 'remote' : 'local'];
  if (location.encrypted) bits.push('encrypted');
  if (location.kind === 'primary') bits.push('primary');
  return bits.join(' · ');
}

const driveFor = id => state?.drives?.find(drive => drive.id === id) || null;

function availabilityFor(location) {
  if (location.kind === 'primary') return { state:'online', text:'Online now' };
  if (location.kind === 'backup') {
    const online = (state?.backups || []).some(backup => backup.id === location.id);
    return { state:online ? 'online':'offline', text:online ? 'Connected now':'Offline / not connected to this PC' };
  }
  if (location.kind === 'peer') {
    const peer = state?.peers?.find(item => item.id === location.id);
    return { state:peer?.online ? 'online':'offline', text:peer?.online ? 'Expected backup drive reachable now':(peer?.error || 'Remote backup is unreachable now') };
  }
  const own = location.deviceName && location.deviceName === state?.config?.deviceName;
  return own ? { state:'online', text:'This PC is online now' } : { state:'unknown', text:'Current availability unknown' };
}

function verificationText(location) {
  const drive = driveFor(location.id);
  if (!drive || !drive.protectedCount) return '';
  const bits = [];
  if (drive.lastVerifiedAt) bits.push(`newest verified ${age(drive.lastVerifiedAt)}`);
  if (drive.oldestVerifiedAt && drive.oldestVerifiedAt !== drive.lastVerifiedAt) bits.push(`oldest verified ${age(drive.oldestVerifiedAt)}`);
  if (drive.verifiedCount < drive.protectedCount) bits.push(`${(drive.protectedCount - drive.verifiedCount).toLocaleString()} never verified`);
  return bits.join(' · ');
}

function renderLocations() {
  return (state?.locations || []).map(location => {
    const availability = availabilityFor(location);
    const drive = driveFor(location.id);
    const details = [availability.text, verificationText(location), drive?.lastSeen ? `last server contact ${age(drive.lastSeen)}`:''].filter(Boolean).join(' · ');
    return `<div class="protection-location" data-location-id="${esc(location.id)}"><div><strong>${esc(location.name)}</strong><small>${esc(locationLabel(location))}${location.deviceName ? ` · ${esc(location.deviceName)}`:''}<br><span class="location-${availability.state}">${esc(details)}</span></small></div><select data-location-reliability aria-label="Reliability"><option value="low" ${location.reliability === 'low' ? 'selected':''}>Less reliable</option><option value="normal" ${location.reliability === 'normal' ? 'selected':''}>Normal</option><option value="high" ${location.reliability === 'high' ? 'selected':''}>Reliable</option></select><input data-location-site value="${esc(location.site || '')}" placeholder="Location" title="Physical location / failure domain"></div>`;
  }).join('');
}

function renderPeers() {
  const peers = state?.config?.peers || [];
  const live = new Map((state?.peers || []).map(peer => [peer.id, peer]));
  if (!peers.length) return '<div class="muted">No remote PCs</div>';
  const busy = state?.job?.status === 'running';
  return peers.map(peer => {
    const status = live.get(peer.id);
    const drive = driveFor(peer.id);
    const current = status?.online ? `${bytes(status.bytes)} stored · expected drive reachable now` : (status?.error || 'offline / unreachable now');
    const verified = drive?.lastVerifiedAt ? ` · last verified ${age(drive.lastVerifiedAt)}` : '';
    return `<div class="peer-row" data-peer-id="${esc(peer.id)}"><div><strong>${esc(peer.name)}</strong><small>${esc(peer.site || 'Remote')} · encrypted · ${peer.enabled === false ? 'paused · ':''}<span class="${status?.online ? 'peer-online':'peer-offline'}">${esc(current)}</span>${esc(verified)}</small></div><div class="peer-actions"><button class="action-link" data-peer-verify ${!status?.online || busy ? 'disabled':''}>Verify</button><button class="action-link" data-peer-toggle>${peer.enabled === false ? 'Resume':'Pause'}</button></div></div>`;
  }).join('');
}

function render() {
  section();
  const summary = state?.summary;
  const body = document.querySelector('#protectionBody');
  if (!summary) { body.innerHTML = '<div class="error">Protection status unavailable</div>'; return; }
  const percent = summary.files ? Math.round(summary.protectedFiles / summary.files * 100) : 100;
  const status = summary.needsProtection ? `${summary.needsProtection.toLocaleString()} need another copy` : 'Everything meets its target';
  const job = state?.job?.status === 'running' && state.job.type === 'protection' ? state.job : null;
  const p = job?.progress || {};
  const jobText = job ? `<div class="protection-running"><span><strong>${esc(job.label || 'Protection')}</strong> · ${esc(p.phase || 'Working')}${p.copied != null ? ` · ${Number(p.copied).toLocaleString()} copied`:''}${p.copiedBytes ? ` · ${bytes(p.copiedBytes)}`:''}${p.checked != null ? ` · ${Number(p.checked).toLocaleString()} checked`:''}${p.bad ? ` · ${Number(p.bad).toLocaleString()} bad`:''}${p.current ? ` · ${esc(p.current)}`:''}</span><button id="cancelProtection" class="action-link">Pause</button></div>` : '';
  const uncertain = (state.locations || []).some(location => ['backup','peer'].includes(location.kind) && availabilityFor(location).state !== 'online');
  body.innerHTML = `<div class="protection-summary"><strong class="${summary.needsProtection ? 'warn':'good'}">${percent}% protected</strong><span>${esc(status)}</span></div><div class="protection-meter" title="${summary.protectedFiles.toLocaleString()} of ${summary.files.toLocaleString()} files"><i style="width:${percent}%"></i></div><div class="protection-levels">${LEVELS.map(([level,label]) => `<span>${label} <b>${Number(summary.levels?.[level]?.files || 0).toLocaleString()}</b>${summary.levels?.[level]?.needsProtection ? ` · ${Number(summary.levels[level].needsProtection).toLocaleString()} need protection`:''}</span>`).join('')}</div>${uncertain ? '<div class="protection-note">Offline backups are last-known copies. Mochimono remembers their last verification, but cannot know their current condition until the actual storage is reconnected.</div>':''}${jobText}<div class="protection-controls"><span>Automatic</span><select id="protectionBackground"><option value="low">Low impact</option><option value="normal">Normal</option><option value="paused">Paused</option></select><button id="runProtection" class="secondary" ${job ? 'disabled':''}>Protect now</button><button id="addPeer" class="secondary">Add remote PC</button><button id="shareSpace" class="secondary">Share space</button><button id="backupKey" class="secondary">Recovery key</button>${summary.trash ? `<button id="openTrash" class="secondary">Trash · ${summary.trash.toLocaleString()}</button>`:''}</div><div class="storage-locations">${renderLocations()}</div><div id="peerList">${renderPeers()}</div>`;
  body.querySelector('#protectionBackground').value = state.config.background;
  body.querySelector('#cancelProtection')?.addEventListener('click', async () => { try { await server('/api/job/cancel', { method:'POST', body:'{}' }); toast('Pausing operation…'); } catch (error) { toast(error.message); } });
  body.querySelector('#protectionBackground').onchange = async event => { try { await control('/api/client/protection/settings', { method:'POST', body:JSON.stringify({ background:event.target.value }) }); await refresh(true); } catch (error) { toast(error.message); } };
  body.querySelector('#runProtection').onclick = async () => { try { await control('/api/client/protection/run', { method:'POST', body:'{}' }); toast('Protection started'); } catch (error) { toast(error.message); } };
  body.querySelector('#addPeer').onclick = openPeerDialog;
  body.querySelector('#shareSpace').onclick = openShareDialog;
  body.querySelector('#backupKey').onclick = openKeyDialog;
  body.querySelector('#openTrash')?.addEventListener('click', openTrashDialog);
  body.querySelectorAll('[data-location-reliability]').forEach(select => select.onchange = saveLocation);
  body.querySelectorAll('[data-location-site]').forEach(input => input.onchange = saveLocation);
  body.querySelectorAll('[data-peer-toggle]').forEach(button => button.onclick = async () => {
    const id = button.closest('[data-peer-id]').dataset.peerId;
    const peer = state.config.peers.find(item => item.id === id);
    try { await control('/api/client/protection/peers/toggle', { method:'POST', body:JSON.stringify({ id, enabled:peer?.enabled === false }) }); await refresh(true); } catch (error) { toast(error.message); }
  });
  body.querySelectorAll('[data-peer-verify]').forEach(button => button.onclick = async () => {
    const id = button.closest('[data-peer-id]').dataset.peerId;
    try { await control('/api/client/protection/peers/verify', { method:'POST', body:JSON.stringify({ id }) }); toast('Remote verification started'); await refresh(true); } catch (error) { toast(error.message); }
  });
  decorateFolders();
}

async function saveLocation(event) {
  const row = event.target.closest('[data-location-id]');
  const id = row.dataset.locationId;
  const current = state.locations.find(location => location.id === id);
  try {
    await control('/api/client/protection/location', { method:'POST', body:JSON.stringify({ id, name:current.name, kind:current.kind, deviceName:current.deviceName, remote:current.remote, encrypted:current.encrypted, reliability:row.querySelector('[data-location-reliability]').value, site:row.querySelector('[data-location-site]').value.trim() }) });
    await refresh(true);
  } catch (error) { toast(error.message); }
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'small-dialog protection-dialog';
  document.body.append(dialog);
  return dialog;
}
function closeDialog() { if (dialog?.open) dialog.close(); }

function openPeerDialog() {
  const box = ensureDialog();
  box.innerHTML = `<div class="dialog-head"><h3>Add encrypted remote PC</h3><button class="icon" data-close>×</button></div><div class="field-stack"><div class="folder-mode-note">Pair while the actual backup drive is connected. Mochimono binds this target to that drive, not just the PC.</div><input id="peerName" placeholder="Name"><input id="peerUrl" placeholder="http://friend-pc:8644"><input id="peerToken" placeholder="Pairing token"><input id="peerSite" placeholder="Physical location (optional)"><label class="field-label">Reliability</label><select id="peerReliability"><option value="normal">Normal</option><option value="high">Reliable</option><option value="low">Less reliable</option></select></div><div class="dialog-actions"><div class="spacer"></div><button data-close class="secondary">Cancel</button><button id="savePeer" class="primary">Add</button></div>`;
  box.querySelectorAll('[data-close]').forEach(button => button.onclick = closeDialog);
  box.querySelector('#savePeer').onclick = async () => {
    const name = box.querySelector('#peerName').value.trim() || 'Remote PC';
    try {
      await control('/api/client/protection/peers', { method:'POST', body:JSON.stringify({ name, url:box.querySelector('#peerUrl').value.trim(), token:box.querySelector('#peerToken').value.trim(), site:box.querySelector('#peerSite').value.trim() || name, reliability:box.querySelector('#peerReliability').value }) });
      closeDialog(); await refresh(true); toast('Remote backup drive paired');
    } catch (error) { toast(error.message); }
  };
  box.showModal();
}

async function openKeyDialog() {
  const box = ensureDialog();
  box.innerHTML = `<div class="dialog-head"><h3>Remote backup recovery key</h3><button class="icon" data-close>×</button></div><div class="field-stack"><div class="folder-mode-note">This key decrypts backups stored on remote PCs. Keep a copy somewhere separate and private. To recover on a new PC, paste the same saved key here before restoring.</div><textarea id="recoveryKey">Loading…</textarea></div><div class="dialog-actions"><button id="useRecoveryKey" class="secondary">Use pasted key</button><div class="spacer"></div><button id="copyRecoveryKey" class="primary">Copy current key</button></div>`;
  box.querySelector('[data-close]').onclick = closeDialog;
  box.showModal();
  try {
    const result = await control('/api/client/protection/key');
    const area = box.querySelector('#recoveryKey');
    area.value = result.key;
    box.querySelector('#copyRecoveryKey').onclick = async () => { try { await navigator.clipboard.writeText(area.value.trim()); toast('Recovery key copied'); } catch { area.select(); } };
    box.querySelector('#useRecoveryKey').onclick = async () => {
      const key = area.value.trim(); if (!key) return;
      try { await control('/api/client/protection/key', { method:'POST', body:JSON.stringify({ key }) }); toast('Recovery key saved'); closeDialog(); await refresh(true); }
      catch (error) {
        if (!/Confirm REPLACE/i.test(error.message)) return toast(error.message);
        if (!confirm(`${error.message}\n\nUse this pasted key anyway?`)) return;
        try { await control('/api/client/protection/key', { method:'POST', body:JSON.stringify({ key, confirm:'REPLACE' }) }); toast('Recovery key replaced'); closeDialog(); await refresh(true); } catch (again) { toast(again.message); }
      }
    };
  } catch (error) { box.querySelector('#recoveryKey').value = error.message; }
}

function openShareDialog() {
  const box = ensureDialog();
  const share = state?.config?.share || {};
  const live = state?.share || {};
  const liveNote = !live.enabled ? '' : live.online ? `${bytes(live.bytes)} stored · ${bytes(live.freeBytes)} free · storage ${esc(String(live.storageId || '').slice(0, 8))}` : `Storage offline: ${esc(live.error || 'configured drive is unavailable')}`;
  box.innerHTML = `<div class="dialog-head"><h3>Share backup space</h3><button class="icon" data-close>×</button></div><div class="field-stack"><div class="folder-mode-note">For an external drive, Mochimono writes a storage identity to the drive. If that drive is unplugged or replaced, the share becomes offline instead of falling back to another disk.</div><label class="field-label">Folder</label><div class="folder-path-row"><input id="sharePath" value="${esc(share.path || '')}" placeholder="Folder"><button id="shareChoose" class="secondary">Choose</button></div><label class="field-label">Space limit (GB, 0 = no limit)</label><input id="shareLimit" type="number" min="0" step="1" value="${share.maxBytes ? Math.round(share.maxBytes / 1e9):0}"><label><input id="shareEnabled" type="checkbox" ${share.enabled ? 'checked':''}> Allow this storage to hold encrypted Mochimono backups</label>${liveNote ? `<div class="folder-mode-note">${liveNote}${live.online ? `<br>${(live.urls || []).map(esc).join('<br>')}`:''}</div>`:''}<button id="showPairing" class="secondary">Show pairing token</button><textarea id="pairingInfo" hidden readonly></textarea></div><div class="dialog-actions"><div class="spacer"></div><button data-close class="secondary">Cancel</button><button id="saveShare" class="primary">Save</button></div>`;
  box.querySelectorAll('[data-close]').forEach(button => button.onclick = closeDialog);
  box.querySelector('#shareChoose').onclick = async () => { try { const result = await fetch('/api/pick-folder').then(response => response.json()); if (result.path) box.querySelector('#sharePath').value = result.path; } catch (error) { toast(error.message); } };
  box.querySelector('#showPairing').onclick = async () => { try { const result = await control('/api/client/protection/share-token'); const area = box.querySelector('#pairingInfo'); area.hidden = false; area.value = `${(result.urls || []).join('\n')}\n\nToken: ${result.token}\nStorage: ${result.storageId || 'not configured'}`; area.select(); } catch (error) { toast(error.message); } };
  box.querySelector('#saveShare').onclick = async () => { try { await control('/api/client/protection/share', { method:'POST', body:JSON.stringify({ path:box.querySelector('#sharePath').value.trim(), enabled:box.querySelector('#shareEnabled').checked, maxBytes:Math.max(0, Number(box.querySelector('#shareLimit').value) || 0) * 1e9 }) }); closeDialog(); await refresh(true); } catch (error) { toast(error.message); } };
  box.showModal();
}

async function openTrashDialog() {
  const box = ensureDialog();
  box.innerHTML = '<div class="dialog-head"><h3>Trash</h3><button class="icon" data-close>×</button></div><div id="trashBody" class="muted">Loading…</div><div class="dialog-actions"><button id="trashEmpty" class="secondary">Delete permanently…</button><div class="spacer"></div><button id="trashRestore" class="primary">Restore all</button></div>';
  box.querySelector('[data-close]').onclick = closeDialog;
  box.showModal();
  try {
    const files = (await server('/api/protection/trash')).files || [];
    box.querySelector('#trashBody').innerHTML = files.length ? `<div class="trash-list">${files.map(file => `<div class="trash-file"><span>${esc(file.filename)}</span><small>${bytes(file.size)}</small></div>`).join('')}</div>` : '<div class="muted">Trash is empty</div>';
    box.querySelector('#trashRestore').disabled = box.querySelector('#trashEmpty').disabled = !files.length;
    box.querySelector('#trashRestore').onclick = async () => { try { await server('/api/protection/restore', { method:'POST', body:JSON.stringify({ hashes:files.map(file => file.hash) }) }); closeDialog(); await refresh(true); location.reload(); } catch (error) { toast(error.message); } };
    box.querySelector('#trashEmpty').onclick = async () => { const answer = prompt(`Permanently delete ${files.length.toLocaleString()} trashed file${files.length === 1 ? '':'s'} from Mochimono and managed backups?\n\nType DELETE to continue.`); if (answer !== 'DELETE') return; try { await server('/api/protection/purge', { method:'POST', body:JSON.stringify({ hashes:files.map(file => file.hash), confirm:'DELETE' }) }); closeDialog(); await refresh(true); } catch (error) { toast(error.message); } };
  } catch (error) { box.querySelector('#trashBody').innerHTML = `<div class="error">${esc(error.message)}</div>`; }
}

async function refresh(force = false) {
  if (!force && (document.hidden || storagePane.hidden)) return;
  try {
    const [client, drives] = await Promise.all([control('/api/client/protection/state'), server('/api/drives').catch(() => ({ drives:[] }))]);
    state = { ...client, drives:drives.drives || [] };
    render();
  } catch (error) { section(); document.querySelector('#protectionBody').innerHTML = `<div class="error">${esc(error.message)}</div>`; }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-remove-folder]'); if (!button) return;
  const path = button.dataset.removeFolder;
  const folder = (state?.folders || []).find(item => String(item.path).replace(/[\\/]+$/,'').toLowerCase() === String(path).replace(/[\\/]+$/,'').toLowerCase());
  if (!folder?.importId) return;
  event.preventDefault(); event.stopImmediatePropagation();
  (async () => { try { const cleanup = await server(`/api/protection/imports/${folder.importId}/cleanup`); if (!confirm(`Stop protecting ${path}?\n\nThe original folder will not be deleted.`)) return; let trashExclusive = false; if (cleanup.exclusiveFiles) trashExclusive = confirm(`${cleanup.exclusiveFiles.toLocaleString()} files (${bytes(cleanup.exclusiveBytes)}) are stored by Mochimono only because of this folder.\n\nMove those extra Mochimono copies to Trash too?\n\nOK = clean them up\nCancel = keep them in Mochimono`); await server(`/api/protection/imports/${folder.importId}/cleanup`, { method:'POST', body:JSON.stringify({ trashExclusive }) }); await server('/api/folders/remove', { method:'POST', body:JSON.stringify({ path }) }); location.reload(); } catch (error) { toast(error.message); } })();
}, true);

document.addEventListener('click', event => {
  const button = event.target.closest('#startImport');
  if (!button || button.dataset.protectionApproved === '1') { if (button) delete button.dataset.protectionApproved; return; }
  const path = document.querySelector('#importPath')?.value.trim(); if (!path) return;
  event.preventDefault(); event.stopImmediatePropagation();
  (async () => { try { button.disabled = true; button.textContent = 'Checking…'; const estimate = await control('/api/client/protection/estimate-folder', { method:'POST', body:JSON.stringify({ path }) }); const large = estimate.truncated || estimate.bytes >= 100e9 || estimate.files >= 100000; if (!large || confirm(`Protect ${estimate.truncated ? 'at least ':''}${estimate.files.toLocaleString()} files (${bytes(estimate.bytes)})?\n\nThis will create a Mochimono copy. You can stop protecting it later without deleting the original folder.`)) { button.dataset.protectionApproved = '1'; button.click(); } } catch (error) { toast(error.message); } finally { button.disabled = false; button.textContent = 'Protect'; } })();
}, true);

new MutationObserver(decorateFolders).observe(folders, { childList:true, subtree:true });
window.addEventListener('focus', () => refresh(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
section(); refresh(true); refreshTimer = setInterval(() => refresh(false), 12_000);
