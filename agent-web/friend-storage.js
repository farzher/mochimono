const serverStorage = document.querySelector('#serverStorage');
const headerActions = document.querySelector('.client-head-actions');
const backups = document.querySelector('#backups');
const backupSection = document.querySelector('.storage-backups-section');
const showBackupAdd = document.querySelector('#showBackupAdd');
const toastNode = document.querySelector('#toast');

if (headerActions && backups && backupSection) {
  if (serverStorage) serverStorage.style.display = 'none';

  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const friendOrigin = `http://${host}:8644`;
  const style = document.createElement('style');
  style.textContent = `
    .storage-location-overview{display:flex;align-items:center;gap:5px;max-width:min(70vw,980px);overflow:auto;scrollbar-width:none}
    .storage-location-overview::-webkit-scrollbar{display:none}
    .storage-location-chip{display:flex;align-items:center;gap:5px;flex:0 0 auto;padding:5px 7px;border:1px solid #2c282c;border-radius:8px;background:#151316;color:#9f9693;font-size:9px;line-height:1;white-space:nowrap}
    .storage-location-chip strong{color:#d9d1ce;font-size:9px}.storage-location-chip b{color:#b7adaa;font-weight:750}.storage-location-chip.offline{opacity:.48}
    .storage-location-chip.friend strong:after{content:' 🔒';font-size:8px}.friend-backup-item .storage-path{color:#817976}
    .friend-backup-item .friend-recovery{max-width:80px}.friend-backup-item .storage-meter i{background:linear-gradient(90deg,#8173bf,#a78ed6)}
    .friend-storage-actions{display:flex;gap:7px;margin-top:8px}.friend-storage-actions .storage-add-card{flex:1;min-height:54px}
    .friend-share-list{display:grid;gap:6px;margin-top:8px}.friend-share{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #262326;border-radius:9px;background:#121013;color:#8f8583;font-size:10px}
    .friend-share strong{color:#d8d0cd}.friend-share .spacer{flex:1}.friend-dialog{width:min(520px,calc(100vw - 28px))}.friend-dialog .field-stack{gap:8px}.friend-dialog input{width:100%}
    .friend-secret{display:block;max-width:100%;overflow:auto;padding:8px;border:1px solid #302b30;border-radius:8px;background:#100e11;color:#d9d0cd;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}
    .friend-note{color:#817976;font-size:10px;line-height:1.4}.friend-inline{display:flex;gap:6px}.friend-inline input{min-width:0;flex:1}
    @media(max-width:800px){.storage-location-overview{max-width:58vw}.storage-location-chip{padding:4px 6px}.friend-storage-actions{display:grid}}
  `;
  document.head.append(style);

  const overview = document.createElement('div');
  overview.className = 'storage-location-overview';
  overview.title = 'Storage locations';
  headerActions.prepend(overview);

  const friendActions = document.createElement('div');
  friendActions.className = 'friend-storage-actions';
  friendActions.innerHTML = `
    <button class="storage-add-card" data-add-friend-backup title="Use encrypted storage offered by a friend"><span class="storage-add-visual storage-add-drive" aria-hidden="true">＋</span><span class="storage-add-copy">Friend backup</span></button>
    <button class="storage-add-card" data-offer-friend-storage title="Offer part of this PC or an external drive to a friend"><span class="storage-add-visual storage-add-drive" aria-hidden="true">＋</span><span class="storage-add-copy">Offer storage</span></button>`;
  showBackupAdd?.after(friendActions);

  const shareList = document.createElement('div');
  shareList.className = 'friend-share-list';
  friendActions.after(shareList);

  const addDialog = document.createElement('dialog');
  addDialog.className = 'small-dialog friend-dialog';
  addDialog.innerHTML = `
    <div class="dialog-head"><h3>Friend backup</h3><button class="icon" data-friend-close>×</button></div>
    <div class="field-stack">
      <label class="field-label">Name</label><input data-friend-name placeholder="Joe's backup drive">
      <label class="field-label">Friend URL</label><input data-friend-url placeholder="https://friend.example.com/v1/…">
      <label class="field-label">Access token</label><input data-friend-token autocomplete="off" placeholder="Token from your friend">
      <label class="field-label">Recovery key <span class="friend-note">optional when reconnecting an existing encrypted backup</span></label><input data-friend-recovery autocomplete="off" placeholder="Leave blank for a new backup">
      <div class="friend-note">Files and the backup catalog are AES-256-GCM encrypted on this PC before they leave it. The friend never receives your recovery key or original filenames. Use HTTPS or a private tunnel such as Tailscale for the connection itself.</div>
    </div>
    <div class="dialog-actions"><div class="spacer"></div><button data-friend-close class="secondary">Cancel</button><button data-friend-save class="primary">Add</button></div>`;
  document.body.append(addDialog);

  const offerDialog = document.createElement('dialog');
  offerDialog.className = 'small-dialog friend-dialog';
  offerDialog.innerHTML = `
    <div class="dialog-head"><h3>Offer storage</h3><button class="icon" data-offer-close>×</button></div>
    <div class="field-stack">
      <label class="field-label">Name</label><input data-offer-name placeholder="Spare backup space">
      <label class="field-label">Folder or drive</label><div class="friend-inline"><input data-offer-path placeholder="D:\\Friend Backups"><button data-offer-choose class="secondary">Choose</button></div>
      <label class="field-label">Limit (GB)</label><input data-offer-quota type="number" min="0" step="1" placeholder="0 = use available free space">
      <div class="friend-note">Mochimono will only accept encrypted opaque objects into this location. Your friend’s filenames, catalog and file contents are never stored here in plaintext.</div>
    </div>
    <div class="dialog-actions"><div class="spacer"></div><button data-offer-close class="secondary">Cancel</button><button data-offer-save class="primary">Create</button></div>`;
  document.body.append(offerDialog);

  const secretDialog = document.createElement('dialog');
  secretDialog.className = 'small-dialog friend-dialog';
  secretDialog.innerHTML = `
    <div class="dialog-head"><h3 data-secret-title>Friend storage</h3><button class="icon" data-secret-close>×</button></div>
    <div class="field-stack"><div data-secret-copy></div></div>
    <div class="dialog-actions"><div class="spacer"></div><button data-secret-close class="primary">Done</button></div>`;
  document.body.append(secretDialog);

  const restoreDialog = document.createElement('dialog');
  restoreDialog.className = 'small-dialog friend-dialog';
  restoreDialog.innerHTML = `
    <div class="dialog-head"><h3>Restore friend backup</h3><button class="icon" data-friend-restore-close>×</button></div>
    <div data-friend-restore-summary class="restore-summary">Loading…</div>
    <div class="friend-note">Encrypted objects will be downloaded, authenticated, decrypted locally, and restored to Mochimono Cloud with their source metadata.</div>
    <div class="dialog-actions"><div class="spacer"></div><button data-friend-restore-close class="secondary">Cancel</button><button data-friend-restore-start class="primary">Restore</button></div>`;
  document.body.append(restoreDialog);

  let friendBackups = [];
  let shares = [];
  let restoreId = '';
  let refreshBusy = false;
  let lastJobId = '';

  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    clearTimeout(toastNode.timer);
    toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
  }

  function bytes(number) {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Math.max(0, Number(number) || 0);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }

  async function local(path, options = {}) {
    const response = await fetch(`${friendOrigin}${path}`, {
      ...options,
      headers: { 'content-type':'application/json', ...(options.headers || {}) },
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  async function main(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type':'application/json', ...(options.headers || {}) },
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function percent(location) {
    const total = Number(location.capacityBytes) || 0;
    const free = Math.max(0, Number(location.freeBytes) || 0);
    return total ? Math.max(0, Math.min(100, (total - free) / total * 100)) : 0;
  }

  function renderLocations(locations) {
    overview.innerHTML = (locations || []).map(location => {
      if (!location.online) return `<span class="storage-location-chip offline ${location.type === 'friend' ? 'friend' : ''}" title="${esc(location.error || 'Unavailable')}"><strong>${esc(location.name)}</strong><b>offline</b></span>`;
      const total = Number(location.capacityBytes) || 0;
      const free = Number(location.freeBytes) || 0;
      const used = Math.max(0, total - free);
      const owned = Number(location.mochimonoBytes) || 0;
      const p = percent(location);
      const detail = [
        `${p.toFixed(p < 10 ? 1 : 0)}% used`,
        total ? `${bytes(used)} used · ${bytes(free)} free` : '',
        owned ? `${bytes(owned)} Mochimono` : '',
        location.encrypted ? 'Encrypted friend backup' : '',
        location.path || ''
      ].filter(Boolean).join(' · ');
      return `<span class="storage-location-chip ${location.type === 'friend' ? 'friend' : ''}" title="${esc(detail)}"><strong>${esc(location.name)}</strong><b>${p.toFixed(p < 10 ? 1 : 0)}%</b></span>`;
    }).join('');
  }

  function backupCard(target, state) {
    const storage = target.storage || {};
    const coverage = target.coverage || {};
    const desired = Number(coverage.desiredBytes) || 0;
    const protectedBytes = Number(coverage.protectedBytes) || 0;
    const completion = desired ? Math.min(100, protectedBytes / desired * 100) : 0;
    const missing = Math.max(0, desired - protectedBytes);
    const activeJob = state?.job?.status === 'running' && String(state.job.label || '').endsWith(target.id) ? state.job : null;
    const phase = activeJob?.progress?.phase || '';
    const status = phase || (!storage.online ? 'Offline' : missing ? `${bytes(missing)} left` : protectedBytes ? 'Protected' : 'Ready');
    const used = Number(storage.usedBytes) || 0;
    const free = Number(storage.freeBytes) || 0;
    const bad = Number(target.lastVerifyBad) || 0;
    return `<article class="storage-item backup-item friend-backup-item" data-friend-backup="${esc(target.id)}">
      <div class="storage-copy">
        <div class="storage-title"><strong>${esc(target.name)}</strong><time class="item-state ${!storage.online || bad ? 'warning' : protectedBytes && !missing ? 'good' : ''}">${esc(status)}</time></div>
        <div class="storage-path" title="${esc(target.url)}">${esc(target.url)}</div>
        <div class="storage-meta"><span>Encrypted friend drive</span><span>·</span><span>${bytes(used)} stored</span><span>·</span><span>${storage.online ? `${bytes(free)} free` : 'offline'}</span>${target.lastVerifiedAt ? `<span>·</span><span>verified</span>` : ''}</div>
        <div class="storage-meter" title="${bytes(protectedBytes)} of ${bytes(desired)} protected"><i style="width:${protectedBytes ? `max(2px,${completion}%)` : '0'}"></i></div>
      </div>
      <div class="item-actions backup-actions">
        <button class="action-link primary-action" data-friend-update ${storage.online ? '' : 'disabled'}>Update</button>
        <button class="action-link" data-friend-restore ${protectedBytes ? '' : 'disabled'}>Restore</button>
        <button class="action-link" data-friend-verify ${protectedBytes && storage.online ? '' : 'disabled'}>Verify</button>
        <button class="action-link friend-recovery" data-friend-key title="Copy the encryption recovery key">Key</button>
        <button class="icon tiny" data-friend-remove title="Forget this friend backup" aria-label="Forget this friend backup">×</button>
      </div>
    </article>`;
  }

  function renderFriendBackups(state) {
    for (const row of backups.querySelectorAll(':scope > [data-friend-backup]')) row.remove();
    if (friendBackups.length) backups.querySelector(':scope > .empty-state')?.remove();
    const holder = document.createElement('div');
    holder.innerHTML = friendBackups.map(target => backupCard(target, state)).join('');
    backups.append(...holder.children);
  }

  function shareUrl(share) {
    const lan = share.lanUrl || '';
    return `${lan || `http://${host}:8644`}${share.urlPath}`;
  }

  function renderShares() {
    shareList.innerHTML = shares.map(share => {
      const storage = share.storage || {};
      const quota = Number(share.quotaBytes) || 0;
      return `<div class="friend-share" data-friend-share="${esc(share.id)}"><strong>${esc(share.name)}</strong><span>${storage.online ? `${bytes(storage.usedBytes)} used${quota ? ` / ${bytes(quota)}` : ''}` : 'offline'}</span><span class="spacer"></span><button class="action-link" data-share-invite>Invite</button><button class="icon tiny" data-share-remove title="Stop offering this storage">×</button></div>`;
    }).join('');
  }

  async function showShareInvite(share) {
    let state = null;
    try { state = await main('/api/state'); } catch {}
    const lan = state?.settings?.lanUrls?.[0] || '';
    const base = lan ? lan.replace(/:8643\/?$/, ':8644') : `http://${host}:8644`;
    const url = `${base}${share.urlPath}`;
    document.querySelector('[data-secret-title]').textContent = 'Friend storage invite';
    document.querySelector('[data-secret-copy]').innerHTML = `
      <div class="friend-note">Send both values to your friend. If they are outside your LAN, use a reachable HTTPS/Tailscale address for port 8644 instead of the address below.</div>
      <label class="field-label">Friend URL</label><code class="friend-secret">${esc(url)}</code><button class="action-link" data-copy-secret="${esc(url)}">Copy URL</button>
      <label class="field-label">Access token</label><code class="friend-secret">${esc(share.token)}</code><button class="action-link" data-copy-secret="${esc(share.token)}">Copy token</button>`;
    secretDialog.showModal();
  }

  async function showRecovery(target) {
    document.querySelector('[data-secret-title]').textContent = `${target.name} recovery key`;
    document.querySelector('[data-secret-copy]').innerHTML = `
      <div class="friend-note">Keep this somewhere outside this PC. The friend does not have it. Without this key, the encrypted backup cannot be restored after losing this Mochimono installation.</div>
      <code class="friend-secret">${esc(target.recoveryKey)}</code><button class="action-link" data-copy-secret="${esc(target.recoveryKey)}">Copy key</button>`;
    secretDialog.showModal();
  }

  async function refresh() {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      const [locations, friendData, shareData, state] = await Promise.all([
        local('/local/storage-locations').catch(() => ({ locations:[] })),
        local('/local/friend-backups').catch(() => ({ backups:[] })),
        local('/local/friend-shares').catch(() => ({ shares:[] })),
        main('/api/state').catch(() => null)
      ]);
      friendBackups = friendData.backups || [];
      shares = shareData.shares || [];
      renderLocations(locations.locations || []);
      renderFriendBackups(state);
      renderShares();
      if (state?.job && state.job.status !== 'running' && state.job.id !== lastJobId && /^Friend /.test(String(state.job.label || ''))) {
        lastJobId = state.job.id;
        toast(state.job.status === 'done' ? 'Friend backup finished' : state.job.error || state.job.status);
      }
    } finally { refreshBusy = false; }
  }

  async function action(id, verb) {
    try {
      await local(`/local/friend-backups/${encodeURIComponent(id)}/${verb}`, { method:'POST' });
      toast(verb === 'update' ? 'Encrypted backup started' : `${verb[0].toUpperCase()}${verb.slice(1)} started`);
      setTimeout(refresh, 150);
    } catch (error) { toast(error.message); }
  }

  backups.addEventListener('click', async event => {
    const row = event.target.closest('[data-friend-backup]');
    if (!row) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = friendBackups.find(item => item.id === row.dataset.friendBackup);
    if (!target) return;
    if (event.target.closest('[data-friend-update]')) return action(target.id, 'update');
    if (event.target.closest('[data-friend-verify]')) return action(target.id, 'verify');
    if (event.target.closest('[data-friend-key]')) return showRecovery(target);
    if (event.target.closest('[data-friend-restore]')) {
      restoreId = target.id;
      restoreDialog.querySelector('[data-friend-restore-summary]').textContent = 'Loading…';
      restoreDialog.querySelector('[data-friend-restore-start]').disabled = true;
      restoreDialog.showModal();
      try {
        const contents = await local(`/local/friend-backups/${encodeURIComponent(target.id)}/contents`);
        restoreDialog.querySelector('[data-friend-restore-summary]').innerHTML = `<strong>${Number(contents.count).toLocaleString()} files</strong><span>${bytes(contents.bytes)}</span><span>🔒 encrypted</span>`;
        restoreDialog.querySelector('[data-friend-restore-start]').disabled = !Number(contents.count);
      } catch (error) { restoreDialog.querySelector('[data-friend-restore-summary]').textContent = error.message; }
      return;
    }
    if (event.target.closest('[data-friend-remove]')) {
      if (!confirm('Forget this friend backup? The encrypted bytes already stored on your friend’s drive will be left untouched.')) return;
      await local(`/local/friend-backups/${encodeURIComponent(target.id)}`, { method:'DELETE' }).catch(error => toast(error.message));
      return refresh();
    }
  }, true);

  shareList.addEventListener('click', async event => {
    const row = event.target.closest('[data-friend-share]');
    if (!row) return;
    const share = shares.find(item => item.id === row.dataset.friendShare);
    if (!share) return;
    if (event.target.closest('[data-share-invite]')) return showShareInvite(share);
    if (event.target.closest('[data-share-remove]')) {
      if (!confirm('Stop offering this friend storage? Existing encrypted files are left on disk.')) return;
      await local(`/local/friend-shares/${encodeURIComponent(share.id)}`, { method:'DELETE' }).catch(error => toast(error.message));
      refresh();
    }
  });

  friendActions.querySelector('[data-add-friend-backup]').onclick = () => addDialog.showModal();
  friendActions.querySelector('[data-offer-friend-storage]').onclick = () => offerDialog.showModal();
  addDialog.querySelectorAll('[data-friend-close]').forEach(button => button.onclick = () => addDialog.close());
  offerDialog.querySelectorAll('[data-offer-close]').forEach(button => button.onclick = () => offerDialog.close());
  secretDialog.querySelectorAll('[data-secret-close]').forEach(button => button.onclick = () => secretDialog.close());
  restoreDialog.querySelectorAll('[data-friend-restore-close]').forEach(button => button.onclick = () => restoreDialog.close());

  addDialog.querySelector('[data-friend-save]').onclick = async () => {
    const button = addDialog.querySelector('[data-friend-save]');
    button.disabled = true;
    try {
      const target = await local('/local/friend-backups', { method:'POST', body:{
        name:addDialog.querySelector('[data-friend-name]').value.trim(),
        url:addDialog.querySelector('[data-friend-url]').value.trim(),
        token:addDialog.querySelector('[data-friend-token]').value.trim(),
        recoveryKey:addDialog.querySelector('[data-friend-recovery]').value.trim()
      }});
      addDialog.close();
      addDialog.querySelectorAll('input').forEach(input => { input.value = ''; });
      await refresh();
      const found = friendBackups.find(item => item.id === target.id) || target;
      await showRecovery(found);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  };

  offerDialog.querySelector('[data-offer-choose]').onclick = async () => {
    try {
      const picked = await main('/api/pick-folder');
      if (picked.path) offerDialog.querySelector('[data-offer-path]').value = picked.path;
    } catch (error) { toast(error.message); }
  };

  offerDialog.querySelector('[data-offer-save]').onclick = async () => {
    const button = offerDialog.querySelector('[data-offer-save]');
    button.disabled = true;
    try {
      const quotaGb = Number(offerDialog.querySelector('[data-offer-quota]').value) || 0;
      const share = await local('/local/friend-shares', { method:'POST', body:{
        name:offerDialog.querySelector('[data-offer-name]').value.trim(),
        path:offerDialog.querySelector('[data-offer-path]').value.trim(),
        quotaBytes:quotaGb > 0 ? Math.round(quotaGb * 1_000_000_000) : 0
      }});
      offerDialog.close();
      offerDialog.querySelectorAll('input').forEach(input => { input.value = ''; });
      await refresh();
      const found = shares.find(item => item.id === share.id) || share;
      await showShareInvite(found);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  };

  secretDialog.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-secret]');
    if (!button) return;
    try { await navigator.clipboard.writeText(button.dataset.copySecret); toast('Copied'); }
    catch { toast('Could not copy'); }
  });

  restoreDialog.querySelector('[data-friend-restore-start]').onclick = async () => {
    if (!restoreId) return;
    restoreDialog.querySelector('[data-friend-restore-start]').disabled = true;
    try { await action(restoreId, 'restore'); restoreDialog.close(); }
    finally { restoreDialog.querySelector('[data-friend-restore-start]').disabled = false; }
  };

  refresh();
  setInterval(refresh, 3000);
}
