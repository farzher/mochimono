const CONTROL = 'http://127.0.0.1:8645';
const storagePane = document.querySelector('#storagePane');
const backupSection = [...document.querySelectorAll('#storagePane .dashboard-section')]
  .find(section => section.querySelector('h2')?.textContent === 'Backups');

let state = null;
let dialog = null;
let refreshing = false;
let mainRenderKey = '';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[char]));

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
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${Math.max(1, months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type':'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

const control = (path, options) => request(CONTROL, path, options);
const server = (path, options) => request('', path, options);

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
  .protection-compact{display:grid;gap:10px}
  .protection-main{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 2px}
  .protection-copy{min-width:0;display:grid;gap:3px}
  .protection-copy strong{font-size:16px;color:#e8e0dc}
  .protection-copy strong.good{color:#acd0b5}.protection-copy strong.warn{color:#d9b877}
  .protection-copy span{font-size:11px;color:#8f8784}
  .protection-actions{display:flex;align-items:center;gap:5px;flex:0 0 auto}
  .protection-job{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border-radius:8px;background:#151316;color:#99918e;font-size:10px}
  .protection-job strong{color:#d7cfcb}
  .protection-offline{font-size:10px;color:#a18f89;padding:0 2px}
  .protection-settings{display:grid;gap:18px}
  .protection-settings-group{display:grid;gap:7px}
  .protection-settings-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .protection-settings-head strong{font-size:12px}
  .protection-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid #282428}
  .protection-settings-row:first-of-type{border-top:0}
  .protection-settings-row>div{min-width:0}
  .protection-settings-row strong{display:block;font-size:11px}
  .protection-settings-row small{display:block;margin-top:2px;color:#817977;font-size:9px;line-height:1.4}
  .protection-settings-row select{width:auto;min-width:105px;padding:6px 8px;font-size:10px}
  .protection-settings-actions{display:flex;gap:6px;flex-wrap:wrap}
  .protection-peer-actions{display:flex;gap:4px}
  .protection-dialog textarea{min-height:76px;resize:vertical}
  .trash-list{max-height:50vh;overflow:auto;display:grid;gap:4px}
  .trash-file{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #282428}
  @media(max-width:700px){
    .protection-main{align-items:flex-start}.protection-actions{flex-direction:column;align-items:stretch}
    .protection-settings-row{align-items:flex-start}.protection-settings-row select{min-width:100px}
  }
`;
document.head.append(style);

function ensureSection() {
  let section = document.querySelector('#protectionDashboard');
  if (section) return section;
  section = document.createElement('section');
  section.id = 'protectionDashboard';
  section.className = 'dashboard-section protection-compact';
  section.innerHTML = `
    <div class="section-head">
      <h2>Protection</h2>
      <button id="protectionSettings" class="round-action subtle" title="Protection settings" aria-label="Protection settings">•••</button>
    </div>
    <div id="protectionBody" class="muted">Loading…</div>`;
  if (backupSection) storagePane.insertBefore(section, backupSection);
  else storagePane.append(section);
  section.querySelector('#protectionSettings').onclick = openSettings;
  return section;
}

function availability(location) {
  if (location.kind === 'primary') return { online:true, text:'Online' };
  if (location.kind === 'backup') {
    const online = (state?.backups || []).some(item => item.id === location.id);
    return { online, text:online ? 'Connected' : 'Offline' };
  }
  if (location.kind === 'peer') {
    const peer = (state?.peers || []).find(item => item.id === location.id);
    return { online:Boolean(peer?.online), text:peer?.online ? 'Online' : (peer?.error || 'Offline') };
  }
  const own = location.deviceName && location.deviceName.toLowerCase() === String(state?.config?.deviceName || '').toLowerCase();
  return { online:own, text:own ? 'This PC' : 'Offline' };
}

function trustedOfflineLocations() {
  return (state?.locations || []).filter(location =>
    location.reliability !== 'low' &&
    ['backup','peer'].includes(location.kind) &&
    !availability(location).online
  );
}

function renderMain() {
  ensureSection();
  const body = document.querySelector('#protectionBody');
  const summary = state?.summary;
  if (!summary) {
    mainRenderKey = '';
    body.innerHTML = '<div class="error">Protection unavailable</div>';
    return;
  }

  const percent = summary.files ? Math.round(summary.protectedFiles / summary.files * 100) : 100;
  const needs = Number(summary.needsProtection) || 0;
  const background = state.config?.background === 'paused' ? 'Paused' : state.config?.background === 'normal' ? 'Normal' : 'Low impact';
  const job = state.job?.status === 'running' && state.job.type === 'protection' ? state.job : null;
  const progress = job?.progress || {};
  const offline = trustedOfflineLocations();
  const renderKey = JSON.stringify([
    percent, needs, background,
    job?.id || '', job?.status || '', progress.phase || '',
    progress.copied ?? null, progress.copiedBytes ?? null, progress.checked ?? null,
    offline.map(location => location.id).sort()
  ]);
  if (renderKey === mainRenderKey) return;
  mainRenderKey = renderKey;

  const jobHtml = job ? `
    <div class="protection-job">
      <span><strong>${esc(progress.phase || job.label || 'Protecting')}</strong>${progress.copied != null ? ` · ${Number(progress.copied).toLocaleString()} copied` : ''}${progress.copiedBytes ? ` · ${bytes(progress.copiedBytes)}` : ''}${progress.checked != null ? ` · ${Number(progress.checked).toLocaleString()} checked` : ''}</span>
      <button class="action-link" id="pauseProtection">Pause</button>
    </div>` : '';

  body.className = '';
  body.innerHTML = `
    <div class="protection-main">
      <div class="protection-copy">
        <strong class="${needs ? 'warn' : 'good'}">${percent}% protected</strong>
        <span>${needs ? `${needs.toLocaleString()} ${needs === 1 ? 'file needs' : 'files need'} another copy` : 'Everything meets its protection target'} · Automatic: ${background}</span>
      </div>
      <div class="protection-actions">
        <button id="runProtection" class="secondary" ${job ? 'disabled' : ''}>Protect now</button>
      </div>
    </div>
    ${offline.length ? `<div class="protection-offline">${offline.length} trusted backup ${offline.length === 1 ? 'location is' : 'locations are'} offline. Last-known copies are remembered but not currently confirmed.</div>` : ''}
    ${jobHtml}`;

  body.querySelector('#runProtection').onclick = async () => {
    try {
      await control('/api/client/protection/run', { method:'POST', body:'{}' });
      toast('Protection started');
      setTimeout(() => refresh(true), 150);
    } catch (error) { toast(error.message); }
  };
  body.querySelector('#pauseProtection')?.addEventListener('click', async () => {
    try {
      await server('/api/job/cancel', { method:'POST', body:'{}' });
      toast('Pausing…');
    } catch (error) { toast(error.message); }
  });
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'small-dialog protection-dialog';
  document.body.append(dialog);
  return dialog;
}

function closeDialog() {
  if (dialog?.open) dialog.close();
}

async function refresh(force = false) {
  if (refreshing || (!force && (document.hidden || storagePane.hidden))) return;
  refreshing = true;
  try {
    await fetch('/api/state', { cache:'no-store' }).catch(() => null);
    state = await control('/api/client/protection/state');
    renderMain();
  } catch (error) {
    ensureSection();
    const body = document.querySelector('#protectionBody');
    body.className = 'error';
    body.textContent = error.message;
    mainRenderKey = '';
  } finally {
    refreshing = false;
  }
}

async function loadDriveMetadata() {
  try {
    state.drives = (await server('/api/drives')).drives || [];
  } catch {
    state.drives = [];
  }
}

function driveFor(id) {
  return (state?.drives || []).find(item => item.id === id);
}

function locationDetail(location) {
  const live = availability(location);
  const drive = driveFor(location.id);
  const parts = [live.text];
  if (drive?.lastVerifiedAt) parts.push(`verified ${age(drive.lastVerifiedAt)}`);
  else if (['backup','peer'].includes(location.kind) && drive?.protectedCount) parts.push('not fully verified');
  if (drive?.lastSeen) parts.push(`last contact ${age(drive.lastSeen)}`);
  if (location.site && location.site !== location.name && location.site !== location.deviceName) parts.push(location.site);
  return parts.join(' · ');
}

function settingsLocationRows() {
  return (state?.locations || [])
    .filter(location => location.kind !== 'primary')
    .map(location => {
      const relying = location.reliability !== 'low';
      return `<div class="protection-settings-row" data-location-id="${esc(location.id)}">
        <div><strong>${esc(location.name)}</strong><small>${esc(locationDetail(location))}</small></div>
        <button class="action-link" data-location-trust>${relying ? 'Do not rely' : 'Use for protection'}</button>
      </div>`;
    }).join('') || '<div class="muted">No other storage locations</div>';
}

function settingsPeerRows() {
  const configured = state?.config?.peers || [];
  const live = new Map((state?.peers || []).map(item => [item.id, item]));
  if (!configured.length) return '';
  return configured.map(peer => {
    const status = live.get(peer.id);
    const enabled = peer.enabled !== false;
    return `<div class="protection-settings-row" data-peer-id="${esc(peer.id)}">
      <div><strong>${esc(peer.name)}</strong><small>${esc(enabled ? (status?.online ? 'Online' : status?.error || 'Offline') : 'Paused')}</small></div>
      <div class="protection-peer-actions">
        <button class="action-link" data-peer-verify ${!enabled || !status?.online || state?.job?.status === 'running' ? 'disabled' : ''}>Verify</button>
        <button class="action-link" data-peer-toggle>${enabled ? 'Pause' : 'Resume'}</button>
      </div>
    </div>`;
  }).join('');
}

async function openSettings() {
  if (!state) await refresh(true);
  await loadDriveMetadata();
  const box = ensureDialog();
  const background = state?.config?.background || 'low';
  box.innerHTML = `
    <div class="dialog-head"><h3>Protection</h3><button class="icon" data-close>×</button></div>
    <div class="protection-settings">
      <div class="protection-settings-group">
        <div class="protection-settings-head"><strong>Background work</strong>
          <select id="protectionBackground">
            <option value="low">Low impact</option>
            <option value="normal">Normal</option>
            <option value="paused">Paused</option>
          </select>
        </div>
      </div>
      <div class="protection-settings-group">
        <div class="protection-settings-head"><strong>Storage</strong></div>
        <div id="protectionLocations">${settingsLocationRows()}</div>
      </div>
      ${state?.config?.peers?.length ? `<div class="protection-settings-group"><div class="protection-settings-head"><strong>Remote PCs</strong></div>${settingsPeerRows()}</div>` : ''}
      <div class="protection-settings-actions">
        <button class="secondary" id="addPeer">Add remote PC</button>
        <button class="secondary" id="shareSpace">Share space</button>
        <button class="secondary" id="backupKey">Recovery key</button>
        ${state?.summary?.trash ? `<button class="secondary" id="openTrash">Trash · ${Number(state.summary.trash).toLocaleString()}</button>` : ''}
      </div>
    </div>`;
  box.querySelector('[data-close]').onclick = closeDialog;
  box.querySelector('#protectionBackground').value = background;
  box.querySelector('#protectionBackground').onchange = async event => {
    try {
      await control('/api/client/protection/settings', { method:'POST', body:JSON.stringify({ background:event.target.value }) });
      await refresh(true);
    } catch (error) { toast(error.message); }
  };
  box.querySelectorAll('[data-location-trust]').forEach(button => button.onclick = async () => {
    const row = button.closest('[data-location-id]');
    const location = state.locations.find(item => item.id === row.dataset.locationId);
    if (!location) return;
    const reliability = location.reliability === 'low' ? 'normal' : 'low';
    button.disabled = true;
    try {
      await control('/api/client/protection/location', {
        method:'POST',
        body:JSON.stringify({
          id:location.id, name:location.name, kind:location.kind, deviceName:location.deviceName,
          remote:location.remote, encrypted:location.encrypted, reliability, site:location.site
        })
      });
      if (location.kind === 'peer') {
        await control('/api/client/protection/peers/toggle', {
          method:'POST', body:JSON.stringify({ id:location.id, enabled:reliability !== 'low' })
        });
      }
      await refresh(true);
      closeDialog();
      await openSettings();
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  });
  box.querySelectorAll('[data-peer-toggle]').forEach(button => button.onclick = async () => {
    const id = button.closest('[data-peer-id]').dataset.peerId;
    const peer = state.config.peers.find(item => item.id === id);
    try {
      await control('/api/client/protection/peers/toggle', {
        method:'POST', body:JSON.stringify({ id, enabled:peer?.enabled === false })
      });
      await refresh(true);
      closeDialog();
      await openSettings();
    } catch (error) { toast(error.message); }
  });
  box.querySelectorAll('[data-peer-verify]').forEach(button => button.onclick = async () => {
    const id = button.closest('[data-peer-id]').dataset.peerId;
    try {
      await control('/api/client/protection/peers/verify', { method:'POST', body:JSON.stringify({ id }) });
      toast('Verification started');
      closeDialog();
      setTimeout(() => refresh(true), 150);
    } catch (error) { toast(error.message); }
  });
  box.querySelector('#addPeer').onclick = openPeerDialog;
  box.querySelector('#shareSpace').onclick = openShareDialog;
  box.querySelector('#backupKey').onclick = openKeyDialog;
  box.querySelector('#openTrash')?.addEventListener('click', openTrashDialog);
  box.showModal();
}

function openPeerDialog() {
  const box = ensureDialog();
  if (box.open) box.close();
  box.innerHTML = `
    <div class="dialog-head"><h3>Add remote backup</h3><button class="icon" data-close>×</button></div>
    <div class="field-stack">
      <input id="peerName" placeholder="Name">
      <input id="peerUrl" placeholder="http://friend-pc:8644">
      <input id="peerToken" placeholder="Pairing token">
      <input id="peerSite" placeholder="Location (optional)">
    </div>
    <div class="dialog-actions"><button class="secondary" data-back>Back</button><div class="spacer"></div><button class="primary" id="savePeer">Add</button></div>`;
  box.querySelector('[data-close]').onclick = closeDialog;
  box.querySelector('[data-back]').onclick = () => { box.close(); openSettings(); };
  box.querySelector('#savePeer').onclick = async () => {
    const name = box.querySelector('#peerName').value.trim() || 'Remote PC';
    try {
      await control('/api/client/protection/peers', {
        method:'POST',
        body:JSON.stringify({
          name,
          url:box.querySelector('#peerUrl').value.trim(),
          token:box.querySelector('#peerToken').value.trim(),
          site:box.querySelector('#peerSite').value.trim() || name,
          reliability:'normal'
        })
      });
      box.close();
      await refresh(true);
      await openSettings();
      toast('Remote backup added');
    } catch (error) { toast(error.message); }
  };
  box.showModal();
}

function openShareDialog() {
  const box = ensureDialog();
  if (box.open) box.close();
  const share = state?.config?.share || {};
  const live = state?.share || {};
  const status = !live.enabled ? 'Off' : live.online ? `${bytes(live.bytes)} stored · ${bytes(live.freeBytes)} free` : `Offline · ${live.error || 'storage unavailable'}`;
  box.innerHTML = `
    <div class="dialog-head"><h3>Share backup space</h3><button class="icon" data-close>×</button></div>
    <div class="field-stack">
      <div class="muted" style="padding:0">${esc(status)}</div>
      <div class="folder-path-row"><input id="sharePath" value="${esc(share.path || '')}" placeholder="Folder"><button id="shareChoose" class="secondary">Choose</button></div>
      <label class="field-label">Space limit (GB, 0 = no limit)</label>
      <input id="shareLimit" type="number" min="0" step="1" value="${share.maxBytes ? Math.round(share.maxBytes / 1e9) : 0}">
      <label><input id="shareEnabled" type="checkbox" ${share.enabled ? 'checked' : ''}> Allow encrypted backups here</label>
      <button id="showPairing" class="secondary">Show pairing info</button>
      <textarea id="pairingInfo" hidden readonly></textarea>
    </div>
    <div class="dialog-actions"><button class="secondary" data-back>Back</button><div class="spacer"></div><button class="primary" id="saveShare">Save</button></div>`;
  box.querySelector('[data-close]').onclick = closeDialog;
  box.querySelector('[data-back]').onclick = () => { box.close(); openSettings(); };
  box.querySelector('#shareChoose').onclick = async () => {
    try {
      const result = await server('/api/pick-folder');
      if (result.path) box.querySelector('#sharePath').value = result.path;
    } catch (error) { toast(error.message); }
  };
  box.querySelector('#showPairing').onclick = async () => {
    try {
      const result = await control('/api/client/protection/share-token');
      const area = box.querySelector('#pairingInfo');
      area.hidden = false;
      area.value = `${(result.urls || []).join('\n')}\n\nToken: ${result.token}\nStorage: ${result.storageId || 'not configured'}`;
      area.select();
    } catch (error) { toast(error.message); }
  };
  box.querySelector('#saveShare').onclick = async () => {
    try {
      await control('/api/client/protection/share', {
        method:'POST',
        body:JSON.stringify({
          path:box.querySelector('#sharePath').value.trim(),
          enabled:box.querySelector('#shareEnabled').checked,
          maxBytes:Math.max(0, Number(box.querySelector('#shareLimit').value) || 0) * 1e9
        })
      });
      box.close();
      await refresh(true);
      await openSettings();
    } catch (error) { toast(error.message); }
  };
  box.showModal();
}

async function openKeyDialog() {
  const box = ensureDialog();
  if (box.open) box.close();
  box.innerHTML = `
    <div class="dialog-head"><h3>Recovery key</h3><button class="icon" data-close>×</button></div>
    <div class="field-stack">
      <textarea id="recoveryKey">Loading…</textarea>
      <small style="color:#817977">Keep this key somewhere separate. It decrypts remote backups.</small>
    </div>
    <div class="dialog-actions"><button class="secondary" data-back>Back</button><button class="secondary" id="useRecoveryKey">Use pasted key</button><div class="spacer"></div><button class="primary" id="copyRecoveryKey">Copy</button></div>`;
  box.querySelector('[data-close]').onclick = closeDialog;
  box.querySelector('[data-back]').onclick = () => { box.close(); openSettings(); };
  box.showModal();
  try {
    const result = await control('/api/client/protection/key');
    const area = box.querySelector('#recoveryKey');
    area.value = result.key;
    box.querySelector('#copyRecoveryKey').onclick = async () => {
      try { await navigator.clipboard.writeText(area.value.trim()); toast('Recovery key copied'); }
      catch { area.select(); }
    };
    box.querySelector('#useRecoveryKey').onclick = async () => {
      const key = area.value.trim();
      if (!key) return;
      try {
        await control('/api/client/protection/key', { method:'POST', body:JSON.stringify({ key }) });
        toast('Recovery key saved');
        box.close();
        openSettings();
      } catch (error) {
        if (!/Confirm REPLACE/i.test(error.message) || !confirm(`${error.message}\n\nUse this pasted key anyway?`)) return toast(error.message);
        try {
          await control('/api/client/protection/key', { method:'POST', body:JSON.stringify({ key, confirm:'REPLACE' }) });
          toast('Recovery key replaced');
          box.close();
          openSettings();
        } catch (again) { toast(again.message); }
      }
    };
  } catch (error) {
    box.querySelector('#recoveryKey').value = error.message;
  }
}

async function openTrashDialog() {
  const box = ensureDialog();
  if (box.open) box.close();
  box.innerHTML = `
    <div class="dialog-head"><h3>Trash</h3><button class="icon" data-close>×</button></div>
    <div id="trashBody" class="muted">Loading…</div>
    <div class="dialog-actions"><button class="secondary" data-back>Back</button><button class="secondary" id="trashEmpty">Delete permanently…</button><div class="spacer"></div><button class="primary" id="trashRestore">Restore all</button></div>`;
  box.querySelector('[data-close]').onclick = closeDialog;
  box.querySelector('[data-back]').onclick = () => { box.close(); openSettings(); };
  box.showModal();
  try {
    const files = (await server('/api/protection/trash')).files || [];
    box.querySelector('#trashBody').innerHTML = files.length
      ? `<div class="trash-list">${files.map(file => `<div class="trash-file"><span>${esc(file.filename)}</span><small>${bytes(file.size)}</small></div>`).join('')}</div>`
      : '<div class="muted">Trash is empty</div>';
    box.querySelector('#trashRestore').disabled = box.querySelector('#trashEmpty').disabled = !files.length;
    box.querySelector('#trashRestore').onclick = async () => {
      try {
        await server('/api/protection/restore', { method:'POST', body:JSON.stringify({ hashes:files.map(file => file.hash) }) });
        box.close();
        await refresh(true);
        location.reload();
      } catch (error) { toast(error.message); }
    };
    box.querySelector('#trashEmpty').onclick = async () => {
      const answer = prompt(`Permanently delete ${files.length.toLocaleString()} trashed file${files.length === 1 ? '' : 's'} from Mochimono and managed backups?\n\nType DELETE to continue.`);
      if (answer !== 'DELETE') return;
      try {
        await server('/api/protection/purge', { method:'POST', body:JSON.stringify({ hashes:files.map(file => file.hash), confirm:'DELETE' }) });
        box.close();
        await refresh(true);
        toast('Deleted permanently');
      } catch (error) { toast(error.message); }
    };
  } catch (error) {
    box.querySelector('#trashBody').className = 'error';
    box.querySelector('#trashBody').textContent = error.message;
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-remove-folder]');
  if (!button || !state) return;
  const path = button.dataset.removeFolder;
  const folder = (state.folders || []).find(item =>
    String(item.path).replace(/[\\/]+$/,'').toLowerCase() === String(path).replace(/[\\/]+$/,'').toLowerCase()
  );
  if (!folder?.importId) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  (async () => {
    try {
      const cleanup = await server(`/api/protection/imports/${folder.importId}/cleanup`);
      if (!confirm(`Stop protecting ${path}?\n\nThe original folder will not be deleted.`)) return;
      let trashExclusive = false;
      if (cleanup.exclusiveFiles) {
        trashExclusive = confirm(`${cleanup.exclusiveFiles.toLocaleString()} files (${bytes(cleanup.exclusiveBytes)}) are stored by Mochimono only because of this folder.\n\nMove those extra Mochimono copies to Trash?`);
      }
      await server(`/api/protection/imports/${folder.importId}/cleanup`, {
        method:'POST', body:JSON.stringify({ trashExclusive })
      });
      await server('/api/folders/remove', { method:'POST', body:JSON.stringify({ path }) });
      location.reload();
    } catch (error) { toast(error.message); }
  })();
}, true);

document.addEventListener('click', event => {
  const button = event.target.closest('#startImport');
  if (!button || button.dataset.protectionApproved === '1') {
    if (button) delete button.dataset.protectionApproved;
    return;
  }
  const path = document.querySelector('#importPath')?.value.trim();
  if (!path) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  (async () => {
    const previous = button.textContent;
    try {
      button.disabled = true;
      button.textContent = 'Checking…';
      const estimate = await control('/api/client/protection/estimate-folder', {
        method:'POST', body:JSON.stringify({ path })
      });
      const large = estimate.truncated || estimate.bytes >= 100e9 || estimate.files >= 100000;
      if (!large || confirm(`Protect ${estimate.truncated ? 'at least ' : ''}${estimate.files.toLocaleString()} files (${bytes(estimate.bytes)})?`)) {
        button.dataset.protectionApproved = '1';
        button.click();
      }
    } catch (error) { toast(error.message); }
    finally {
      button.disabled = false;
      button.textContent = previous;
    }
  })();
}, true);

new MutationObserver(() => {
  if (!storagePane.hidden) refresh();
}).observe(storagePane, { attributes:true, attributeFilter:['hidden'] });

window.addEventListener('focus', () => refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!storagePane.hidden) refresh(); }, 30000);

ensureSection();
refresh(true);
