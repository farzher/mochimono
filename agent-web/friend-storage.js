const storagePane = document.querySelector('#storagePane');
const toastNode = document.querySelector('#toast');

if (storagePane) {
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const friendOrigin = `http://${host}:8644`;

  const style = document.createElement('style');
  style.textContent = `
    .friend-dialog{width:min(520px,calc(100vw - 28px))}
    .friend-dialog .field-stack{gap:10px}.friend-dialog input{width:100%}
    .friend-secret{display:block;max-width:100%;overflow:auto;padding:11px;border:1px solid #302b30;border-radius:9px;background:#100e11;color:#d9d0cd;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;user-select:all}
    .friend-note{color:#918783;font-size:12px;line-height:1.4}.friend-inline{display:flex;gap:7px}.friend-inline input{min-width:0;flex:1}
  `;
  document.head.append(style);

  const addDialog = document.createElement('dialog');
  addDialog.className = 'small-dialog friend-dialog';
  addDialog.innerHTML = `
    <div class="dialog-head"><h3>Friend backup</h3><button class="icon" data-friend-close>×</button></div>
    <div class="field-stack">
      <input data-friend-invite autocomplete="off" spellcheck="false" placeholder="Invite code">
      <input data-friend-name placeholder="Name (optional)">
      <input data-friend-recovery autocomplete="off" spellcheck="false" placeholder="Recovery key (only when reconnecting)">
    </div>
    <div class="dialog-actions"><div class="spacer"></div><button data-friend-close class="secondary">Cancel</button><button data-friend-save class="primary">Add</button></div>`;
  document.body.append(addDialog);

  const offerDialog = document.createElement('dialog');
  offerDialog.className = 'small-dialog friend-dialog';
  offerDialog.innerHTML = `
    <div class="dialog-head"><h3>Offer storage</h3><button class="icon" data-offer-close>×</button></div>
    <div class="field-stack">
      <input data-offer-name placeholder="Name">
      <div class="friend-inline"><input data-offer-path placeholder="Folder or drive"><button data-offer-choose class="secondary">Choose</button></div>
      <input data-offer-quota type="number" min="0" step="1" placeholder="Limit in GB · 0 = available space">
    </div>
    <div class="dialog-actions"><div class="spacer"></div><button data-offer-close class="secondary">Cancel</button><button data-offer-save class="primary">Create</button></div>`;
  document.body.append(offerDialog);

  const secretDialog = document.createElement('dialog');
  secretDialog.className = 'small-dialog friend-dialog';
  secretDialog.innerHTML = '<div class="dialog-head"><h3 data-secret-title>Friend storage</h3><button class="icon" data-secret-close>×</button></div><div class="field-stack"><div data-secret-copy></div></div><div class="dialog-actions"><div class="spacer"></div><button data-secret-close class="primary">Done</button></div>';
  document.body.append(secretDialog);

  const restoreDialog = document.createElement('dialog');
  restoreDialog.className = 'small-dialog friend-dialog';
  restoreDialog.innerHTML = '<div class="dialog-head"><h3>Restore friend backup</h3><button class="icon" data-friend-restore-close>×</button></div><div data-friend-restore-summary class="restore-summary">Loading…</div><div class="dialog-actions"><div class="spacer"></div><button data-friend-restore-close class="secondary">Cancel</button><button data-friend-restore-start class="primary">Restore</button></div>';
  document.body.append(restoreDialog);

  let friendBackups = [];
  let shares = [];
  let restoreId = '';
  let refreshPromise = null;

  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    clearTimeout(toastNode.timer);
    toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2400);
  }
  function bytes(number) {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Math.max(0, Number(number) || 0), unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }
  async function request(origin, path, options = {}) {
    const response = await fetch(`${origin}${path}`, {
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
      body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }
  const local = (path, options) => request(friendOrigin, path, options);
  const main = (path, options) => request('', path, options);
  const backupById = id => friendBackups.find(item => String(item.id) === String(id));
  const shareById = id => shares.find(item => String(item.id) === String(id));

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = Promise.all([
      local('/local/friend-backups').catch(() => ({ backups:[] })),
      local('/local/friend-shares').catch(() => ({ shares:[] }))
    ]).then(([backupData, shareData]) => {
      friendBackups = backupData.backups || [];
      shares = shareData.shares || [];
      dispatchEvent(new CustomEvent('mochimono:friend-storage-changed'));
      return { friendBackups, shares };
    }).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  function showRecovery(target) {
    secretDialog.querySelector('[data-secret-title]').textContent = `${target.name || 'Friend backup'} recovery key`;
    secretDialog.querySelector('[data-secret-copy]').innerHTML = `<code class="friend-secret">${esc(target.recoveryKey || '')}</code><button class="action-link" data-copy-secret="${esc(target.recoveryKey || '')}">Copy</button>`;
    secretDialog.showModal();
  }

  async function showShareInvite(share) {
    const invite = await local(`/local/friend-shares/${encodeURIComponent(share.id)}/invite`, { method:'POST' });
    secretDialog.querySelector('[data-secret-title]').textContent = 'Friend storage invite';
    secretDialog.querySelector('[data-secret-copy]').innerHTML = `<code class="friend-secret">${esc(invite.code)}</code><button class="action-link" data-copy-secret="${esc(invite.code)}">Copy</button>`;
    secretDialog.showModal();
  }

  async function action(id, verb) {
    try {
      await local(`/local/friend-backups/${encodeURIComponent(id)}/${verb}`, { method:'POST' });
      toast(verb === 'update' ? 'Backup started' : `${verb[0].toUpperCase()}${verb.slice(1)} started`);
      dispatchEvent(new CustomEvent('mochimono:friend-storage-changed'));
    } catch (error) { toast(error.message); }
  }

  async function backupAction(id, verb) {
    let target = backupById(id);
    if (!target) {
      await refresh();
      target = backupById(id);
    }
    if (!target) return false;
    if (verb === 'update' || verb === 'verify') {
      await action(target.id, verb);
      return true;
    }
    if (verb === 'key') {
      showRecovery(target);
      return true;
    }
    if (verb === 'restore') {
      restoreId = target.id;
      const summary = restoreDialog.querySelector('[data-friend-restore-summary]');
      const start = restoreDialog.querySelector('[data-friend-restore-start]');
      summary.textContent = 'Loading…';
      start.disabled = true;
      restoreDialog.showModal();
      try {
        const contents = await local(`/local/friend-backups/${encodeURIComponent(target.id)}/contents`);
        summary.innerHTML = `<strong>${Number(contents.count).toLocaleString()} files</strong><span>${bytes(contents.bytes)}</span>`;
        start.disabled = !Number(contents.count);
      } catch (error) { summary.textContent = error.message; }
      return true;
    }
    return false;
  }

  async function shareAction(id, verb) {
    let share = shareById(id);
    if (!share) {
      await refresh();
      share = shareById(id);
    }
    if (!share) return false;
    try {
      if (verb === 'invite') {
        await showShareInvite(share);
        return true;
      }
      if (verb === 'remove') {
        if (!confirm('Stop offering this storage? Existing encrypted files are left on disk.')) return true;
        await local(`/local/friend-shares/${encodeURIComponent(share.id)}`, { method:'DELETE' });
        await refresh();
        return true;
      }
    } catch (error) {
      toast(error.message);
      return true;
    }
    return false;
  }

  addDialog.querySelectorAll('[data-friend-close]').forEach(button => button.onclick = () => addDialog.close());
  offerDialog.querySelectorAll('[data-offer-close]').forEach(button => button.onclick = () => offerDialog.close());
  secretDialog.querySelectorAll('[data-secret-close]').forEach(button => button.onclick = () => secretDialog.close());
  restoreDialog.querySelectorAll('[data-friend-restore-close]').forEach(button => button.onclick = () => restoreDialog.close());

  addDialog.querySelector('[data-friend-save]').onclick = async () => {
    const button = addDialog.querySelector('[data-friend-save]');
    button.disabled = true;
    try {
      const target = await local('/local/friend-backups', {
        method:'POST',
        body:{
          inviteCode:addDialog.querySelector('[data-friend-invite]').value.trim(),
          name:addDialog.querySelector('[data-friend-name]').value.trim(),
          recoveryKey:addDialog.querySelector('[data-friend-recovery]').value.trim()
        }
      });
      addDialog.close();
      addDialog.querySelectorAll('input').forEach(input => { input.value = ''; });
      await refresh();
      showRecovery(backupById(target.id) || target);
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
      const share = await local('/local/friend-shares', {
        method:'POST',
        body:{
          name:offerDialog.querySelector('[data-offer-name]').value.trim(),
          path:offerDialog.querySelector('[data-offer-path]').value.trim(),
          quotaBytes:quotaGb > 0 ? Math.round(quotaGb * 1_000_000_000) : 0
        }
      });
      offerDialog.close();
      offerDialog.querySelectorAll('input').forEach(input => { input.value = ''; });
      await refresh();
      await showShareInvite(shareById(share.id) || share);
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
    const button = restoreDialog.querySelector('[data-friend-restore-start]');
    button.disabled = true;
    try { await action(restoreId, 'restore'); restoreDialog.close(); }
    finally { button.disabled = false; }
  };

  window.mochimonoFriendStorage = {
    refresh,
    openAdd:() => addDialog.showModal(),
    openOffer:() => offerDialog.showModal(),
    backup:backupAction,
    share:shareAction
  };
  refresh().catch(() => {});
  window.addEventListener('focus', () => { if (!storagePane.hidden) refresh().catch(() => {}); });
}
