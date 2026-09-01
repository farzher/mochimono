import './storage-minimal-actions.js';

const pane = document.querySelector('#storagePane');
const frame = document.querySelector('#filesFrame');
const headerActions = document.querySelector('.client-head-actions');
const menu = document.querySelector('.client-menu');
const storageTab = document.querySelector('[data-client-tab="storage"]');
const serverStorage = document.querySelector('#serverStorage');

if (pane) {
  const style = document.createElement('style');
  style.textContent = `
    :root{--storage-line:#29262b;--storage-surface:#141215;--storage-hover:#19171a;--storage-muted:#8f8784;--storage-track:#2a272c;--storage-accent:#efa09a;--storage-good:#80c895;--storage-warn:#d7b06d}
    #storagePane{width:min(1040px,calc(100% - 64px))!important;margin:0 auto!important;padding:42px 0 84px!important;gap:44px!important}
    #storagePane .storage-overview{gap:10px!important;margin:0!important}
    #storagePane [data-storage-overview]{display:grid;gap:8px}

    /* Only the two storage numbers that matter at a glance. */
    #storagePane .storage-glance-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:0!important;overflow:hidden;border:1px solid var(--storage-line);border-radius:12px;background:var(--storage-surface)}
    #storagePane .storage-glance-card{min-height:148px!important;padding:24px 26px!important;border:0!important;border-right:1px solid var(--storage-line)!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;text-align:left!important}
    #storagePane .storage-glance-card:last-child{border-right:0!important}
    #storagePane .storage-glance-card:hover{background:var(--storage-hover)!important}
    #storagePane .storage-glance-card>span:first-child{display:block;color:var(--storage-muted)!important;font-size:11px!important;font-weight:650!important;letter-spacing:0!important}
    #storagePane .storage-glance-card>strong{display:block;margin-top:15px!important;color:#eee8e4!important;font-size:32px!important;font-weight:650!important;letter-spacing:-.04em!important}
    #storagePane .storage-glance-card.backups>strong{color:#d5e0d7!important}
    #storagePane .storage-glance-card[data-open-where="local"]{display:none!important}
    .material-card-meta{display:block!important;margin-top:10px!important;color:#817a78!important;font-size:10px!important;font-weight:550!important}
    .material-card-meter{display:block!important;height:7px;margin-top:15px;border-radius:999px;background:var(--storage-track);overflow:hidden}
    .material-card-meter>i{display:block;height:100%;border-radius:inherit;background:var(--storage-accent);transition:width .22s ease}
    #storagePane .storage-glance-card.backups .material-card-meter>i{background:#86b592}

    /* Free-local-space/protection summaries are available elsewhere; don't crowd the overview. */
    #storagePane .storage-quick-row{display:none!important}
    #storagePane .storage-integrity{min-height:26px!important;padding:0 2px!important}
    #storagePane .storage-integrity button{width:28px!important;height:28px!important}

    #storagePane>.dashboard-section{display:grid!important;gap:10px!important}
    #storagePane .section-head{min-height:40px!important;padding:0 2px!important;border:0!important}
    #storagePane .section-head h2{color:#e6dfdc!important;font-size:16px!important;font-weight:650!important;letter-spacing:-.015em!important}
    #storagePane .round-action{width:34px!important;height:34px!important;border-radius:9px!important;background:transparent!important;color:#9a9290!important}
    #storagePane .round-action:hover{background:#201d21!important;color:#fff!important}

    /* Flat aligned Material-style lists. */
    #storagePane .item-list{display:grid!important;gap:0!important}
    #storagePane .storage-item{grid-template-columns:minmax(0,1fr) 72px!important;gap:18px!important;min-height:88px!important;margin:0!important;padding:16px 18px!important;border:1px solid var(--storage-line)!important;border-bottom:0!important;border-radius:0!important;background:var(--storage-surface)!important;box-shadow:none!important}
    #storagePane .storage-item:first-child{border-radius:12px 12px 0 0!important}
    #storagePane .storage-item:last-child{border-bottom:1px solid var(--storage-line)!important;border-radius:0 0 12px 12px!important}
    #storagePane .storage-item:only-child{border-radius:12px!important}
    #storagePane .storage-item:hover{background:var(--storage-hover)!important}
    #storagePane .storage-copy{min-width:0;cursor:pointer!important}
    #storagePane .storage-title{display:flex!important;align-items:center!important;gap:8px!important}
    #storagePane .storage-title strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5deda!important;font-size:14px!important;font-weight:650!important}
    #storagePane .storage-path{display:none!important}
    #storagePane .storage-meta,#storagePane .storage-meter{display:none!important}
    #storagePane .item-state{margin-left:auto;color:#857d7b!important;font-size:10px!important;font-weight:600!important}
    #storagePane .item-state.good{width:7px;height:7px;border-radius:50%;background:var(--storage-good);font-size:0!important;box-shadow:none!important}
    #storagePane .item-state.warning{color:#d8b879!important}

    .material-row-stats{margin-top:9px}
    .material-row-line{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#89817f;font-size:10px;font-weight:550}
    .material-row-line>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .material-row-line>strong{flex:0 0 auto;color:#aaa19e;font-size:10px;font-weight:650}
    .material-row-meter{height:7px;margin-top:9px;overflow:hidden;border-radius:999px;background:var(--storage-track)}
    .material-row-meter>i{display:block;height:100%;border-radius:inherit;background:#86b592;transition:width .22s ease}
    .folder-item .material-row-meter{display:none!important}
    .storage-risk .material-row-meter>i{background:var(--storage-warn)}

    #storagePane .storage-mode{width:7px!important;height:7px!important;padding:0!important;border-radius:50%!important;font-size:0!important;box-shadow:none!important}
    #storagePane .storage-mode.protected{background:#d99994!important}
    #storagePane .storage-mode.local{background:#7c8390!important}
    #storagePane .item-actions{width:72px!important;align-self:center;justify-content:flex-end!important;gap:3px!important;opacity:.72!important}
    #storagePane .storage-item:hover .item-actions,#storagePane .storage-item:focus-within .item-actions{opacity:1!important}
    #storagePane .item-actions .action-link,#storagePane .item-actions .icon{width:34px!important;height:34px!important;border-radius:9px!important;background:transparent!important}
    #storagePane .item-actions .action-link:hover,#storagePane .item-actions .icon:hover{background:#252226!important}

    #storagePane .folder-add,#storagePane .inline-add{padding:14px!important;border:1px solid var(--storage-line)!important;border-radius:12px!important;background:var(--storage-surface)!important}
    #storagePane .folder-add{border-bottom:1px solid var(--storage-line)!important}
    #storagePane .folder-path-row input,#storagePane .inline-add input{background:#0f0e10!important;border:1px solid #302d31!important}
    #storagePane .folder-mode-options{gap:8px!important;margin-top:10px!important}
    #storagePane .folder-mode-option{min-height:46px!important;padding:0 14px!important;border:1px solid #343036!important;border-radius:9px!important;background:transparent!important;text-align:center!important}
    #storagePane .folder-mode-option:hover,#storagePane .folder-mode-option.suggested{background:#201d21!important;border-color:#50444a!important}
    #storagePane .folder-mode-option strong{font-size:11px!important}
    #storagePane .folder-mode-option span,#storagePane .folder-mode-note{display:none!important}
    #storagePane .empty-state,#storagePane .muted{padding:28px 16px!important;border:1px solid var(--storage-line);border-radius:12px;color:#756e6c!important;background:var(--storage-surface);font-size:11px!important}

    .storage-shortcut{width:36px;height:36px;display:grid;place-items:center;padding:0;border:0;border-radius:9px;background:transparent;color:#928a88;cursor:pointer}
    .storage-shortcut:hover,.storage-shortcut.active{background:#211e22;color:#eee7e3}
    .storage-shortcut svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
    .client-storage{cursor:pointer;border-radius:8px;padding:4px 6px;margin:-4px -6px}
    .client-storage:hover{background:#171518}

    @media(max-width:760px){
      #storagePane{width:min(100% - 24px,1040px)!important;padding:24px 0 64px!important;gap:34px!important}
      #storagePane .storage-glance-grid{grid-template-columns:1fr!important}
      #storagePane .storage-glance-card{min-height:112px!important;padding:17px 18px!important;border-right:0!important;border-bottom:1px solid var(--storage-line)!important}
      #storagePane .storage-glance-card:last-child{border-bottom:0!important}
      #storagePane .storage-glance-card>strong{margin-top:9px!important;font-size:26px!important}
      #storagePane .storage-item{grid-template-columns:minmax(0,1fr) 72px!important;gap:8px!important;padding:15px 14px!important}
      #storagePane .item-actions{opacity:1!important}
      .material-row-line{gap:8px}
      .client-storage{display:none!important}
    }
  `;
  document.head.append(style);

  const shortcut = document.createElement('button');
  shortcut.type = 'button';
  shortcut.className = 'storage-shortcut';
  shortcut.title = 'Storage';
  shortcut.setAttribute('aria-label', 'Storage');
  shortcut.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/></svg>';
  headerActions?.insertBefore(shortcut, menu || null);

  function openStorage() {
    if (pane.hidden) storageTab?.click();
    shortcut.classList.toggle('active', !pane.hidden);
  }

  shortcut.addEventListener('click', openStorage);
  if (serverStorage) {
    serverStorage.tabIndex = 0;
    serverStorage.setAttribute('role', 'button');
    serverStorage.setAttribute('aria-label', 'Open Storage');
    serverStorage.addEventListener('click', openStorage);
    serverStorage.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.code !== 'Space') return;
      event.preventDefault();
      openStorage();
    });
  }

  document.addEventListener('pointerdown', () => {
    frame?.contentWindow?.postMessage({ type: 'mochimono-close-popovers' }, '*');
  }, true);

  const bytes = number => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = Number(number) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  };
  const pathKey = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  const percent = (value, total) => total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;

  function setRowStats(row, left, right, ratio = null, title = '') {
    let block = row.querySelector('.material-row-stats');
    if (!block) {
      block = document.createElement('div');
      block.className = 'material-row-stats';
      block.innerHTML = '<div class="material-row-line"><span></span><strong></strong></div><div class="material-row-meter"><i></i></div>';
      row.querySelector('.storage-copy')?.insertBefore(block, row.querySelector('[data-item-progress]') || null);
    }
    block.querySelector('span').textContent = left;
    block.querySelector('strong').textContent = right;
    const meter = block.querySelector('.material-row-meter');
    meter.title = title;
    meter.hidden = ratio == null;
    if (ratio != null) meter.querySelector('i').style.width = `${Math.max(ratio ? 2 : 0, ratio)}%`;
  }

  function setCard(card, label, value, meta, ratio = null) {
    if (!card) return;
    card.querySelector(':scope > span')?.replaceChildren(label);
    const strong = card.querySelector(':scope > strong');
    if (strong) strong.textContent = value;

    let detail = card.querySelector(':scope > .material-card-meta');
    if (!detail) {
      detail = document.createElement('span');
      detail.className = 'material-card-meta';
      card.append(detail);
    }
    detail.textContent = meta;

    let meter = card.querySelector(':scope > .material-card-meter');
    if (ratio == null) {
      meter?.remove();
      return;
    }
    if (!meter) {
      meter = document.createElement('span');
      meter.className = 'material-card-meter';
      meter.innerHTML = '<i></i>';
      card.append(meter);
    }
    meter.querySelector('i').style.width = `${ratio}%`;
  }

  function annotateSummary(state, backupData) {
    const cloud = pane.querySelector('.storage-glance-card[data-open-where="server"]');
    const backup = pane.querySelector('.storage-glance-card[data-open-where="verified-backup"]');
    const stats = state?.server?.online ? state.server.stats : null;

    if (cloud && stats) {
      const used = Number(stats.bytes) || 0;
      const capacity = Number(stats.capacityBytes) || 0;
      const ratio = percent(used, capacity);
      setCard(
        cloud,
        'Cloud usage',
        bytes(used),
        capacity ? `${Math.round(ratio)}% of ${bytes(capacity)}` : 'Stored in Mochimono',
        capacity ? ratio : null
      );
      cloud.title = capacity ? `${bytes(used)} of ${bytes(capacity)} used` : `${bytes(used)} stored in Mochimono`;
    }

    const backups = backupData.backups || [];
    const desired = backups.reduce((sum, item) => sum + (Number(item.remote?.desiredBytes) || 0), 0);
    const protectedBytes = backups.reduce((sum, item) => sum + (Number(item.remote?.protectedBytes) || 0), 0);
    const coverage = desired ? percent(protectedBytes, desired) : 0;
    if (backup) {
      const value = desired ? `${Math.round(coverage)}%` : '—';
      const meta = desired
        ? `${bytes(protectedBytes)} of ${bytes(desired)} backed up`
        : backups.length ? 'Coverage unavailable' : 'No backups configured';
      setCard(backup, 'Backup coverage', value, meta, desired ? coverage : null);
      backup.title = meta;
    }
  }

  async function refreshMaterial() {
    shortcut.classList.toggle('active', !pane.hidden);
    if (pane.hidden) return;

    const [folderData, backupData, state] = await Promise.all([
      fetch('/api/folder-stats', { cache: 'no-store' }).then(r => r.ok ? r.json() : { folders: [] }).catch(() => ({ folders: [] })),
      fetch('/api/backups', { cache: 'no-store' }).then(r => r.ok ? r.json() : { backups: [] }).catch(() => ({ backups: [] })),
      fetch('/api/state', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    annotateSummary(state, backupData);

    const folders = new Map((folderData.folders || []).map(item => [pathKey(item.path), item]));
    for (const row of pane.querySelectorAll('[data-folder-path]')) {
      const item = folders.get(pathKey(row.dataset.folderPath));
      if (!item) continue;
      setRowStats(
        row,
        `${Number(item.files || 0).toLocaleString()} files`,
        bytes(item.bytes),
        null
      );
    }

    for (const row of pane.querySelectorAll('[data-backup-index]')) {
      const item = (backupData.backups || [])[Number(row.dataset.backupIndex)];
      if (!item) continue;
      const localBytes = Number(item.local?.bytes) || 0;
      const count = Number(item.local?.count) || 0;
      const desired = Number(item.remote?.desiredBytes) || 0;
      const protectedBytes = Number(item.remote?.protectedBytes) || 0;
      const ratio = desired ? percent(protectedBytes, desired) : (localBytes ? 100 : 0);
      const right = desired ? `${Math.round(ratio)}%` : (localBytes ? 'Stored' : 'Empty');
      setRowStats(
        row,
        `${bytes(localBytes)} · ${count.toLocaleString()} files`,
        right,
        desired || localBytes ? ratio : null,
        desired ? `${bytes(protectedBytes)} of ${bytes(desired)} backed up` : `${bytes(localBytes)} stored`
      );
    }
  }

  let refreshTimer = 0;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshMaterial, 80);
  }

  const foldersList = pane.querySelector('#folders');
  const backupsList = pane.querySelector('#backups');
  const overview = pane.querySelector('[data-storage-overview]');
  if (foldersList) new MutationObserver(scheduleRefresh).observe(foldersList, { childList: true });
  if (backupsList) new MutationObserver(scheduleRefresh).observe(backupsList, { childList: true });
  if (overview) new MutationObserver(scheduleRefresh).observe(overview, { childList: true });
  new MutationObserver(scheduleRefresh).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('focus', scheduleRefresh, { passive: true });
  setInterval(() => { if (!pane.hidden) refreshMaterial(); }, 15000);
  scheduleRefresh();
}
