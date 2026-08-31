const folders = document.querySelector('#folders');

function bytes(number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function parts(path) {
  const raw = String(path || '');
  const clean = raw.replace(/[\\/]+$/, '') || raw;
  const index = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return {
    name: index >= 0 ? clean.slice(index + 1) || clean : clean,
    parent: index >= 0 ? clean.slice(0, index) : ''
  };
}

const style = document.createElement('style');
style.textContent = `
  .sync-folder{min-height:68px;padding:9px 7px}
  .sync-folder-copy{padding-left:34px}
  .sync-folder-copy:before{left:6px}
  .sync-folder-copy:after{left:7px}
  .sync-folder-copy strong{font-size:13px;color:#eee7e3}
  .sync-folder-path{display:block!important;margin-top:1px!important;color:#777071!important;font-size:9px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sync-folder-meta{display:flex;align-items:center;gap:5px;margin-top:3px;color:#898180;font-size:10px;white-space:nowrap;overflow:hidden}
  .sync-folder-meta [data-folder-status]{display:inline;margin:0;color:#9a9290}
  .sync-folder-stats{display:inline!important;margin:0!important;color:#756e6e!important}
  .sync-folder-separator{color:#4f494a}
  .sync-folder[data-syncing="true"] .sync-folder-copy:before,
  .sync-folder[data-syncing="true"] .sync-folder-copy:after{background:#a97872}
  @media(max-width:620px){.sync-folder{min-height:64px}.sync-folder-path{max-width:70vw}}
`;
document.head.append(style);

function enhanceRows() {
  if (!folders) return;
  for (const row of folders.querySelectorAll('.sync-folder[data-folder-path]')) {
    const path = row.dataset.folderPath || '';
    const copy = row.querySelector('.sync-folder-copy');
    const name = copy?.querySelector('strong');
    const status = copy?.querySelector('[data-folder-status]');
    if (!copy || !name || !status) continue;

    if (!row.dataset.folderDetailsReady) {
      row.dataset.folderDetailsReady = '1';
      row.title = path;
      const label = parts(path);
      name.textContent = label.name || path;

      if (label.parent) {
        const parent = document.createElement('span');
        parent.className = 'sync-folder-path';
        parent.textContent = label.parent;
        name.after(parent);
      }

      const meta = document.createElement('div');
      meta.className = 'sync-folder-meta';
      const separator = document.createElement('span');
      separator.className = 'sync-folder-separator';
      separator.textContent = '·';
      const stats = document.createElement('span');
      stats.className = 'sync-folder-stats';
      status.replaceWith(meta);
      meta.append(status, separator, stats);
    }
    row.dataset.syncing = status.textContent.startsWith('Syncing') ? 'true' : 'false';
  }
}

async function refreshStats() {
  enhanceRows();
  try {
    const response = await fetch('/api/folder-stats', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const stats = new Map((data.folders || []).map(folder => [String(folder.path), folder]));
    for (const row of folders.querySelectorAll('.sync-folder[data-folder-path]')) {
      const item = stats.get(row.dataset.folderPath);
      const label = row.querySelector('.sync-folder-stats');
      if (!item || !label) continue;
      const next = `${Number(item.files).toLocaleString()} files · ${bytes(item.bytes)}`;
      if (label.textContent !== next) label.textContent = next;
      const status = row.querySelector('[data-folder-status]');
      row.dataset.syncing = status?.textContent.startsWith('Syncing') ? 'true' : 'false';
    }
  } catch {}
}

if (folders) {
  new MutationObserver(enhanceRows).observe(folders, { childList: true, subtree: true, characterData: true });
  refreshStats();
  setInterval(refreshStats, 2500);
}
