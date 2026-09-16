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
  let stateCache = null;
  let syncing = false;

  const style = document.createElement('style');
  style.textContent = `
    .friend-preflight{margin:7px 0 0;padding:7px 9px;border:1px solid #3a292c;border-radius:8px;background:#1c1416;color:#c8a8a5;font-size:10px;line-height:1.35}.friend-preflight[hidden]{display:none!important}
    .friend-capacity-warning{color:#c6a980;font-weight:650}.friend-backup-item.capacity-limited{border-color:#3a3228}.friend-backup-item.capacity-limited .storage-meter i{background:linear-gradient(90deg,#8d7dba,#c29c6d)}
    .friend-drive-fact{color:#aaa09c}.friend-drive-fact.good{color:#89b996}.friend-drive-fact.capacity{color:#c6a980}
  `;
  document.head.append(style);

  const addButton = actions.querySelector('[data-add-friend-backup]');
  const offerButton = actions.querySelector('[data-offer-friend-storage]');
  const addCopy = addButton?.querySelector('.storage-add-copy');
  const offerCopy = offerButton?.querySelector('.storage-add-copy');
  if (addCopy) addCopy.textContent = 'Add Friend Drive';
  if (offerCopy) offerCopy.textContent = 'Share space';
  if (addButton) addButton.title = 'Use end-to-end encrypted storage on a friend’s device';
  if (offerButton) offerButton.title = 'Give a friend a private encrypted quota on this device or drive';

  for (const dialog of document.querySelectorAll('dialog.friend-dialog')) {
    const heading = dialog.querySelector('.dialog-head h3');
    if (heading?.textContent === 'Friend backup') heading.textContent = 'Add Friend Drive';
    if (heading?.textContent === 'Restore friend backup') heading.textContent = 'Restore Friend Drive';
  }

  const notice = document.createElement('div');
  notice.className = 'friend-preflight';
  notice.hidden = true;
  sharesNode.before(notice);

  const inviteInput = document.querySelector('[data-friend-invite]');
  if (inviteInput) inviteInput.placeholder = 'Paste Friend Drive invite';

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
    return `${Math.floor(hours / 24)}d ago`;
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
      const capacityLimited = shortfall > 0 || Number(target.lastCapacitySkippedBytes) > 0;
      row.classList.toggle('capacity-limited', capacityLimited);
      let warning = row.querySelector('[data-friend-capacity-warning]');

      update.disabled = !storage.online;
      delete update.dataset.friendCapacityBlocked;
      if (shortfall > 0) {
        update.title = `This Friend Drive does not need to fit everything. Mochimono will fill its ${bytes(free)} available space and leave the rest for other storage.`;
        if (!warning) {
          warning = document.createElement('span');
          warning.dataset.friendCapacityWarning = '1';
          warning.className = 'friend-capacity-warning';
          row.querySelector('.storage-meta')?.append(' · ', warning);
        }
        const text = `${bytes(free)} available · partial is okay`;
        if (warning.textContent !== text) warning.textContent = text;
      } else {
        update.removeAttribute('title');
        warning?.remove();
      }

      const running = stateCache?.job?.status === 'running' && String(stateCache.job.label || '').startsWith('Friend ') && (String(stateCache.job.label || '').includes(target.name) || String(stateCache.job.label || '').includes(target.id));
      if (running) {
        const status = row.querySelector('.item-state');
        if (status) {
          status.textContent = stateCache.job.progress?.phase || 'Working…';
          status.classList.remove('good','warning');
        }
      }

      const meta = row.querySelector('.storage-meta');
      if (meta) {
        meta.querySelectorAll('[data-friend-polish-fact]').forEach(node => node.remove());
        const facts = [];
        if (target.lastBackupAt) facts.push({ text:`updated ${age(target.lastBackupAt)}`, cls:'good' });
        if (storage.online && storage.connection) facts.push({ text:storage.connection === 'relayed' ? 'relay connected' : 'direct connected', cls:'good' });
        if (!storage.online && target.lastSeenAt) facts.push({ text:`last seen ${age(target.lastSeenAt)}`, cls:'' });
        if (target.lastCapacityLimitedAt && Number(target.lastCapacitySkippedBytes) > 0) facts.push({ text:`${bytes(target.lastCapacitySkippedBytes)} waiting for other storage`, cls:'capacity' });
        for (const fact of facts) {
          meta.append(' · ');
          const span = document.createElement('span');
          span.dataset.friendPolishFact = '1';
          span.className = `friend-drive-fact ${fact.cls}`;
          span.textContent = fact.text;
          meta.append(span);
        }
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
      row.title = share.paired
        ? `${share.peerName || 'Friend'} can store only encrypted opaque data here. ${share.quotaBytes ? `${bytes(share.quotaBytes)} limit.` : 'Uses available free space.'}`
        : 'Create an invite to pair this private storage with a friend.';
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
      stateCache = state;
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
      if (note?.textContent.includes('expires shortly')) note.textContent = 'Send this invite to your friend. It is valid for 10 minutes and includes the rendezvous automatically.';
    }).observe(secretDialog, { childList:true, subtree:true });
  }

  new MutationObserver(() => { polishBackups(); polishShares(); }).observe(document.querySelector('#storagePane'), { childList:true,subtree:true });
  sync();
  setInterval(sync, 3000);
}
