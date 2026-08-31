const folders = document.querySelector('#folders');

function bytes(number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
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
  .sync-folder{min-height:82px;padding:9px 7px}
  .sync-folder-copy{padding-left:34px}
  .sync-folder-copy:before{left:6px}
  .sync-folder-copy:after{left:7px}
  .sync-folder-copy strong{font-size:13px;color:#eee7e3}
  .sync-folder-path{display:block!important;margin-top:1px!important;color:#777071!important;font-size:9px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sync-folder-meta{display:flex;align-items:center;gap:5px;margin-top:3px;color:#898180;font-size:10px;white-space:nowrap;overflow:hidden}
  .sync-folder-meta [data-folder-status]{display:inline;margin:0;color:#9a9290}
  .sync-folder-stats{display:inline!important;margin:0!important;color:#756e6e!important}
  .sync-folder-separator{color:#4f494a}
  .sync-folder-usage{width:min(320px,100%);margin-top:5px}
  .sync-folder-usage-copy{display:block!important;margin:0!important;color:#827a79!important;font-size:9px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sync-folder-usage i{display:block;height:4px;margin-top:4px;border-radius:999px;background:#292529;overflow:hidden}
  .sync-folder-usage b{display:block;height:100%;border-radius:inherit;background:var(--pink)}
  .sync-folder[data-syncing="true"] .sync-folder-copy:before,
  .sync-folder[data-syncing="true"] .sync-folder-copy:after{background:#a97872}
  @media(max-width:620px){.sync-folder{min-height:78px}.sync-folder-path{max-width:70vw}.sync-folder-usage{width:min(260px,70vw)}}
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

      const usage = document.createElement('div');
      usage.className = 'sync-folder-usage';
      usage.innerHTML = '<span class="sync-folder-usage-copy"></span><i><b></b></i>';
      meta.after(usage);
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
      if (!item) continue;

      const statsLabel = row.querySelector('.sync-folder-stats');
      const files = `${Number(item.files).toLocaleString()} files`;
      if (statsLabel && statsLabel.textContent !== files) statsLabel.textContent = files;

      const used = Number(item.bytes) || 0;
      const capacity = Number(item.capacityBytes) || 0;
      const percent = capacity ? Math.min(100, used / capacity * 100) : 0;
      const usage = row.querySelector('.sync-folder-usage');
      const usageCopy = row.querySelector('.sync-folder-usage-copy');
      const meter = row.querySelector('.sync-folder-usage b');
      if (usage) usage.hidden = !capacity;
      if (usageCopy && capacity) {
        const text = `${bytes(used)} of ${bytes(capacity)}`;
        if (usageCopy.textContent !== text) usageCopy.textContent = text;
        usageCopy.title = `${percent.toFixed(1)}%`;
      }
      if (meter && capacity) meter.style.width = used ? `max(2px, ${percent}%)` : '0';

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