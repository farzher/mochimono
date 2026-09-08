import './storage-locations-ui.js';

const backups = document.querySelector('#backups');
const actions = document.querySelector('.friend-storage-actions');
const sharesNode = document.querySelector('.friend-share-list');
const toastNode = document.querySelector('#toast');

if (backups && actions && sharesNode) {
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const origin = `http://${host}:8644`;
  let friendBackups = [];
  let shares = [];
  let indexedRoots = [];
  let syncing = false;

  const style = document.createElement('style');
  style.textContent = `
    .friend-preflight{margin:7px 0 0;padding:7px 9px;border:1px solid #3a292c;border-radius:8px;background:#1c1416;color:#c8a8a5;font-size:10px;line-height:1.35}
    .friend-preflight[hidden]{display:none!important}
    .friend-capacity-warning{color:#d8aaa5;font-weight:650}
  `;
  document.head.append(style);

  const notice = document.createElement('div');
  notice.className = 'friend-preflight';
  notice.hidden = true;
  sharesNode.before(notice);

  const inviteInput = document.querySelector('[data-friend-invite]');
  if (inviteInput) inviteInput.placeholder = 'Paste friend invite';

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

  function localPathKey(value) {
    let path = String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
    const windows = /^[a-z]:\//i.test(path) || path.startsWith('//');
    if (windows) path = path.toLowerCase();
    return path;
  }

  function insideIndexedRoot(value) {
    const candidate = localPathKey(value);
    if (!candidate) return false;
    return indexedRoots.some(root => {
      const base = localPathKey(root);
      return base && (candidate === base || candidate.startsWith(`${base}/`));
    });
  }

  async function local(path) {
    const response = await fetch(`${origin}${path}`, { cache:'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText || 'Friend Drive unavailable');
    return data;
  }

  async function agentState() {
    const response = await fetch('/api/state', { cache:'no-store' });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  function polishBackups() {
    for (const target of friendBackups) {
      const row = backups.querySelector(`[data-friend-backup="${CSS.escape(String(target.id))}"]`);
      if (!row) continue;
      const update = row.querySelector('[data-friend-update]');
      if (!update) continue;

      const storage = target.storage || {};
      const coverage = target.coverage || {};
      const missing = Math.max(0, (Number(coverage.desiredBytes) || 0) - (Number(coverage.protectedBytes) || 0));
      const free = Math.max(0, Number(storage.freeBytes) || 0);
      const shortfall = storage.online ? Math.max(0, missing - free) : 0;
      let warning = row.querySelector('[data-friend-capacity-warning]');

      if (shortfall > 0) {
        update.disabled = true;
        update.dataset.friendCapacityBlocked = '1';
        update.title = `Friend drive needs ${bytes(shortfall)} more free space before this backup can update`;
        if (!warning) {
          warning = document.createElement('span');
          warning.dataset.friendCapacityWarning = '1';
          warning.className = 'friend-capacity-warning';
          row.querySelector('.storage-meta')?.append(' · ', warning);
        }
        const text = `needs ${bytes(shortfall)} more space`;
        if (warning.textContent !== text) warning.textContent = text;
      } else {
        if (update.dataset.friendCapacityBlocked === '1') update.disabled = !storage.online;
        delete update.dataset.friendCapacityBlocked;
        update.removeAttribute('title');
        warning?.remove();
      }
    }
  }

  function polishShares() {
    for (const share of shares) {
      const row = sharesNode.querySelector(`[data-friend-share="${CSS.escape(String(share.id))}"]`);
      const invite = row?.querySelector('[data-share-invite]');
      if (!invite) continue;
      if (share.paired) {
        if (invite.textContent !== 'Re-pair') invite.textContent = 'Re-pair';
        invite.title = `Replace the paired identity for ${share.peerName || 'this friend'}`;
      } else {
        if (invite.textContent !== 'Invite') invite.textContent = 'Invite';
        invite.removeAttribute('title');
      }
    }
  }

  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const [backupData, shareData, state] = await Promise.all([
        local('/local/friend-backups'),
        local('/local/friend-shares'),
        agentState()
      ]);
      friendBackups = backupData.backups || [];
      shares = shareData.shares || [];
      indexedRoots = (state?.settings?.folders || []).map(folder => folder.path).filter(Boolean);
      notice.hidden = true;
      polishBackups();
      polishShares();
    } catch (error) {
      const text = error.message || 'Friend Drive is unavailable on this Agent.';
      if (notice.textContent !== text) notice.textContent = text;
      notice.hidden = false;
    } finally {
      syncing = false;
    }
  }

  backups.addEventListener('click', event => {
    const update = event.target.closest('[data-friend-update][data-friend-capacity-blocked="1"]');
    if (!update) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast(update.title || 'The friend drive does not have enough free space for this update.');
  }, true);

  sharesNode.addEventListener('click', event => {
    const invite = event.target.closest('[data-share-invite]');
    const row = invite?.closest('[data-friend-share]');
    if (!invite || !row) return;
    const share = shares.find(item => String(item.id) === String(row.dataset.friendShare));
    if (!share?.paired) return;
    const peer = share.peerName || 'the current friend';
    if (confirm(`Re-pair this storage?\n\nThis replaces ${peer} as the authorized peer. Existing encrypted files stay in place.`)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const offerSave = document.querySelector('[data-offer-save]');
  offerSave?.addEventListener('click', event => {
    const path = document.querySelector('[data-offer-path]')?.value || '';
    if (!insideIndexedRoot(path)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast('Choose storage outside folders Mochimono already indexes.');
  }, true);

  const secretDialog = [...document.querySelectorAll('dialog.friend-dialog')].find(dialog => dialog.querySelector('[data-secret-title]'));
  if (secretDialog) {
    new MutationObserver(() => {
      const note = secretDialog.querySelector('.friend-note');
      if (note?.textContent.includes('expires shortly')) {
        note.textContent = 'Send this invite to your friend. It is valid for 10 minutes and includes the rendezvous automatically.';
      }
    }).observe(secretDialog, { childList:true, subtree:true });
  }

  // The main Friend Drive UI already refreshes every three seconds. Re-apply our
  // cached polish whenever it redraws, but only hit the P2P-backed management API
  // occasionally so this layer does not double the normal polling traffic.
  new MutationObserver(() => {
    polishBackups();
    polishShares();
  }).observe(document.querySelector('#storagePane'), { childList:true, subtree:true });

  sync();
  setInterval(sync, 12000);
}
