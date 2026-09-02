const storage = document.querySelector('#storagePane');
const protectionMenu = document.querySelector('#clientProtection');
const serverStorage = document.querySelector('#serverStorage');
const serverStorageText = document.querySelector('#serverStorageText');

const style = document.createElement('style');
style.textContent = `
  .storage-visually-hidden{
    position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;
    overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important
  }

  #storagePane{
    width:min(980px,calc(100% - 36px));padding-top:12px;padding-bottom:64px;gap:26px
  }
  #storagePane .dashboard-section{padding:0}
  #storagePane #activityCard{display:none!important}
  #storagePane #protectionDashboard{display:none!important}
  #folderAdd{display:none!important}
  #folders>.empty-state,#folders>.muted,#backups>.empty-state,#backups>.muted{display:none!important}

  /* Folder rows: visual first, one path line, two useful numbers. */
  #storagePane .folder-item{
    position:relative;grid-template-columns:260px minmax(0,1fr);gap:18px;align-items:center;
    min-height:164px;padding:12px 4px;border-bottom:1px solid #201e20;background:transparent
  }
  #storagePane .folder-item:hover{background:rgba(255,255,255,.016)}
  #storagePane .folder-item .storage-copy{min-width:0;align-self:center}
  #storagePane .folder-item .storage-title{display:flex;align-items:center;gap:7px;min-width:0}
  #storagePane .folder-item .storage-title strong{
    min-width:0;display:flex;align-items:baseline;font-weight:400;letter-spacing:0;cursor:pointer;overflow:hidden
  }
  .storage-path-parent{
    min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#77706e;
    font:10px/1.35 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace
  }
  .storage-path-name{
    flex:0 0 auto;color:#e9e1dd;font-size:15px;font-weight:740;letter-spacing:-.015em;white-space:nowrap
  }
  #storagePane .folder-item .item-state{display:none!important}
  #storagePane .folder-item .storage-meta{margin-top:9px;gap:6px;color:#948b88;font-size:11px}
  #storagePane .folder-item .storage-meta span:nth-child(4),
  #storagePane .folder-item .storage-meta span:nth-child(5){display:none}
  #storagePane .folder-item .storage-meter{display:none!important}
  #storagePane .folder-item .storage-modes{display:inline-flex;flex:0 0 auto;margin:0}
  #storagePane .folder-item .storage-mode,
  #storagePane .folder-item .storage-modes{
    padding:2px 6px;border-radius:999px;background:#302427;color:#d9a49e;font-size:9px;font-weight:720
  }

  /* Actions exist, but they should not compete with the folder itself. */
  #storagePane .folder-item .item-actions{
    position:absolute;z-index:3;right:9px;top:50%;width:auto;min-width:0;padding:4px;
    display:flex;gap:1px;align-items:center;border-radius:9px;background:rgba(18,16,19,.88);
    backdrop-filter:blur(8px);opacity:0;transform:translateY(calc(-50% + 3px));pointer-events:none;
    transition:opacity .12s ease,transform .12s ease
  }
  #storagePane .folder-item:hover .item-actions,
  #storagePane .folder-item:focus-within .item-actions{
    opacity:1;transform:translateY(-50%);pointer-events:auto
  }
  #storagePane .folder-item .item-actions .action-link,
  #storagePane .folder-item .item-actions .icon{
    padding:6px 7px;border-radius:6px;background:transparent;color:#a79d9a;font-size:11px
  }
  #storagePane .folder-item .item-actions .action-link:hover,
  #storagePane .folder-item .item-actions .icon:hover{background:#2b272b;color:#fff}
  #storagePane .folder-item .item-actions .primary-action{color:#e2aaa4}

  /* Add folder is simply the next folder-sized row. */
  .storage-add-card{
    width:100%;border:0;border-radius:0;background:transparent;color:#847b79;text-align:left;font-weight:650
  }
  .storage-add-card:hover{background:rgba(255,255,255,.016);color:#d9d0cc}
  .storage-add-folder{
    min-height:164px;padding:12px 4px;display:grid;grid-template-columns:260px minmax(0,1fr);
    gap:18px;align-items:center;border-bottom:1px solid #201e20
  }
  .storage-add-folder .storage-add-visual{
    width:260px;height:140px;display:grid;place-items:center;border:1px dashed #353035;border-radius:13px;
    background:#111013;color:#655e60;font-size:32px;font-weight:300;transition:.12s
  }
  .storage-add-folder:hover .storage-add-visual{border-color:#5a5055;background:#161417;color:#b0a5a3}
  .storage-add-folder .storage-add-copy{font-size:14px;color:#817876}
  .storage-add-folder:hover .storage-add-copy{color:#d8cfcb}

  /* Backups: compact drive rows. No path/free-space prose. */
  .storage-backups-section{margin-top:12px;padding-top:18px!important;border-top:1px solid #211e21}
  #storagePane .backup-item{
    position:relative;min-height:78px;padding:13px 4px 13px 58px;border-bottom:1px solid #201e20;background:transparent
  }
  #storagePane .backup-item:before{
    content:'▱';position:absolute;left:6px;top:50%;transform:translateY(-50%);width:38px;height:38px;
    display:grid;place-items:center;border:1px solid #302c30;border-radius:9px;background:#151316;
    color:#7f7775;font-size:18px;font-weight:400
  }
  #storagePane .backup-item:hover{background:rgba(255,255,255,.016)}
  #storagePane .backup-item .storage-title strong{font-size:14px;color:#e6ddda}
  #storagePane .backup-item .storage-path{display:none!important}
  #storagePane .backup-item .storage-meta{margin-top:5px;font-size:10px;color:#8d8582}
  #storagePane .backup-item .storage-meta span:nth-child(1),
  #storagePane .backup-item .storage-meta span:nth-child(2),
  #storagePane .backup-item .storage-meta span:nth-child(6),
  #storagePane .backup-item .storage-meta span:nth-child(7){display:none}
  #storagePane .backup-item .storage-meter{height:3px;margin-top:8px;background:#262326}
  #storagePane .backup-item .item-actions{
    opacity:0;pointer-events:none;transition:opacity .12s ease
  }
  #storagePane .backup-item:hover .item-actions,
  #storagePane .backup-item:focus-within .item-actions{opacity:1;pointer-events:auto}

  .storage-add-backup{
    min-height:72px;padding:10px 4px;display:grid;grid-template-columns:48px minmax(0,1fr);gap:10px;
    align-items:center;border-bottom:1px solid #201e20
  }
  .storage-add-backup .storage-add-visual{
    width:38px;height:38px;display:grid;place-items:center;border:1px dashed #373137;border-radius:9px;
    background:#111013;color:#686062;font-size:20px;font-weight:300
  }
  .storage-add-backup .storage-add-copy{font-size:12px;color:#817876}
  .storage-add-backup:hover .storage-add-visual{border-color:#5a5055;color:#b0a5a3;background:#161417}
  .storage-add-backup:hover .storage-add-copy{color:#d8cfcb}
  .storage-backups-section .inline-add{margin-top:8px;border:0;padding:10px 4px;background:#121013;border-radius:10px}

  @media(hover:none){
    #storagePane .folder-item .item-actions,
    #storagePane .backup-item .item-actions{opacity:1;pointer-events:auto;background:transparent;backdrop-filter:none}
  }

  @media(max-width:700px){
    #storagePane{width:min(100% - 20px,980px);padding-top:7px;gap:20px}
    #storagePane .folder-item{
      grid-template-columns:126px minmax(0,1fr);gap:11px;min-height:126px;padding:10px 2px
    }
    .storage-path-parent{font-size:8px}
    .storage-path-name{font-size:13px}
    #storagePane .folder-item .storage-meta{font-size:9px;gap:4px}
    #storagePane .folder-item .item-actions{
      position:static;grid-column:2;padding:0;margin-top:5px;transform:none!important;justify-content:flex-start
    }
    .storage-add-folder{
      grid-template-columns:126px minmax(0,1fr);gap:11px;min-height:126px;padding:10px 2px
    }
    .storage-add-folder .storage-add-visual{width:126px;height:104px;border-radius:10px}
    .storage-add-folder .storage-add-copy{font-size:12px}
    #storagePane .backup-item{padding-left:52px}
  }
`;
document.head.append(style);

function openProtectionSettings() {
  const button = document.querySelector('#protectionSettings');
  if (button) {
    button.click();
    return;
  }
  // protection.js loads asynchronously with the rest of the Storage modules.
  setTimeout(() => document.querySelector('#protectionSettings')?.click(), 150);
}

function parseBytesLabel(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)$/i);
  if (!match) return NaN;
  const units = ['B','KB','MB','GB','TB','PB'];
  const power = units.indexOf(match[2].toUpperCase());
  return Number(match[1]) * (1000 ** Math.max(0, power));
}

function formatBytes(number) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Math.max(0, Number(number) || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function showUsedAndFree() {
  if (!serverStorageText) return;
  const match = serverStorageText.textContent.match(/^(.+?)\s*\/\s*(.+)$/);
  if (!match) return;
  const used = parseBytesLabel(match[1]);
  const capacity = parseBytesLabel(match[2]);
  if (!Number.isFinite(used) || !Number.isFinite(capacity)) return;
  const text = `${match[1].trim()} used · ${formatBytes(Math.max(0, capacity - used))} free`;
  serverStorageText.textContent = text;
  if (serverStorage) serverStorage.title = `${text} · Cloud`;
}

protectionMenu?.addEventListener('click', openProtectionSettings);
if (serverStorageText) {
  new MutationObserver(showUsedAndFree).observe(serverStorageText, { childList:true, characterData:true, subtree:true });
  queueMicrotask(showUsedAndFree);
}
