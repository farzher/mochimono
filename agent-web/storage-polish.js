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
    width:min(1180px,calc(100% - 40px));padding-top:18px;padding-bottom:72px;gap:30px
  }
  #storagePane .dashboard-section{padding:0}
  #storagePane #activityCard{display:none!important}
  #storagePane #protectionDashboard{display:none!important}
  #folderAdd{display:none!important}
  #folders>.empty-state,#folders>.muted,#backups>.empty-state,#backups>.muted{display:none!important}

  /* Folder storage is a visual library of locations, not a settings table. */
  #storagePane .storage-folders-section{
    display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;align-items:start
  }
  #storagePane .storage-folders-section>#folders{display:contents}

  #storagePane .folder-item{
    position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;padding:0;
    overflow:hidden;border:1px solid #272327;border-radius:14px;background:#121013;
    box-shadow:0 1px 0 rgba(255,255,255,.025) inset,0 8px 24px rgba(0,0,0,.08);
    transition:border-color .14s ease,background .14s ease,transform .14s ease,box-shadow .14s ease
  }
  #storagePane .folder-item:hover{
    z-index:2;border-color:#3b3439;background:#151216;transform:translateY(-1px);
    box-shadow:0 1px 0 rgba(255,255,255,.035) inset,0 12px 32px rgba(0,0,0,.14)
  }

  #storagePane .folder-item .storage-folder-samples{
    order:0;width:100%!important;height:auto!important;aspect-ratio:16/9;border-radius:0!important;
    background:#0a090b;cursor:pointer
  }
  #storagePane .folder-item .storage-folder-sample{background:#171518}
  #storagePane .folder-item .storage-folder-sample img{transition:opacity .16s ease,transform .28s ease}
  #storagePane .folder-item:hover .storage-folder-sample.thumb-ready img{transform:scale(1.012)}
  #storagePane .folder-item .storage-folder-samples:hover{outline:0!important}

  #storagePane .folder-item .storage-copy{
    order:1;min-width:0;align-self:stretch;padding:11px 12px 12px
  }
  #storagePane .folder-item .storage-title{
    display:flex;align-items:flex-start;gap:7px;min-width:0
  }
  #storagePane .folder-item .storage-title strong{
    min-width:0;flex:1;display:flex;flex-direction:column-reverse;align-items:flex-start;gap:2px;
    font-weight:400;letter-spacing:0;cursor:pointer;overflow:hidden
  }
  .storage-path-name{
    display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;color:#eee7e3;
    font-size:13.5px;font-weight:740;letter-spacing:-.015em;line-height:1.25;white-space:nowrap
  }
  .storage-path-parent{
    display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#716a69;
    font:8.5px/1.3 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace
  }
  #storagePane .folder-item .item-state{display:none!important}
  #storagePane .folder-item .storage-meta{
    display:flex;align-items:center;min-width:0;margin-top:7px;gap:5px;color:#968e8b;font-size:9.5px;line-height:1.25
  }
  #storagePane .folder-item .storage-meta span:nth-child(4),
  #storagePane .folder-item .storage-meta span:nth-child(5){display:none}
  #storagePane .folder-item .storage-meter{display:none!important}
  #storagePane .folder-item .storage-modes{
    flex:0 0 auto;margin-top:0;padding:2px 6px;border:1px solid rgba(224,159,151,.12);border-radius:999px;
    background:#2a2023;color:#dca8a2;font-size:8px;font-weight:760;line-height:1.3
  }

  /* Controls belong to the hover state, not the card's resting visual hierarchy. */
  #storagePane .folder-item .item-actions{
    position:absolute;z-index:5;right:8px;top:8px;width:auto;min-width:0;padding:4px;
    display:flex;gap:1px;align-items:center;border:1px solid rgba(255,255,255,.07);border-radius:9px;
    background:rgba(15,13,16,.82);box-shadow:0 5px 18px rgba(0,0,0,.24);backdrop-filter:blur(12px);
    opacity:0;transform:translateY(-3px);pointer-events:none;
    transition:opacity .12s ease,transform .12s ease
  }
  #storagePane .folder-item:hover .item-actions,
  #storagePane .folder-item:focus-within .item-actions{
    opacity:1;transform:translateY(0);pointer-events:auto
  }
  #storagePane .folder-item .item-actions .action-link,
  #storagePane .folder-item .item-actions .icon{
    min-height:27px;padding:5px 7px;border:0;border-radius:6px;background:transparent;color:#b0a6a3;font-size:9.5px;font-weight:680
  }
  #storagePane .folder-item .item-actions .action-link:hover,
  #storagePane .folder-item .item-actions .icon:hover{background:rgba(255,255,255,.095);color:#fff}
  #storagePane .folder-item .item-actions .primary-action{color:#efb1aa}
  #storagePane .folder-item .item-actions .icon.tiny{width:27px;padding:0;font-size:15px;font-weight:400}

  #storagePane .folder-item .item-progress{
    margin-top:9px;padding-top:9px;border-top:1px solid #282328
  }

  .storage-add-card{
    width:100%;min-width:0;border:1px solid #272327;border-radius:14px;background:#100f11;color:#847b79;
    text-align:left;font-weight:650;overflow:hidden;transition:border-color .14s ease,background .14s ease,transform .14s ease
  }
  .storage-add-card:hover{border-color:#3c353a;background:#141215;color:#d9d0cc;transform:translateY(-1px)}
  .storage-add-folder{
    min-height:0;padding:0!important;display:flex!important;flex-direction:column!important;gap:0!important;align-items:stretch!important
  }
  .storage-add-folder .storage-add-visual{
    width:100%!important;height:auto!important;aspect-ratio:16/9;display:grid;place-items:center;
    border:0!important;border-bottom:1px dashed #343035!important;border-radius:0!important;
    background:#111013;color:#615a5c;font-size:28px;font-weight:280;transition:.14s
  }
  .storage-add-folder:hover .storage-add-visual{border-color:#51484e!important;background:#161417;color:#b6aba8}
  .storage-add-folder .storage-add-copy{
    display:block;padding:12px;color:#817876;font-size:11px;font-weight:680
  }
  .storage-add-folder:hover .storage-add-copy{color:#ddd4d0}

  .storage-backups-section{margin-top:10px;padding-top:22px!important;border-top:1px solid #211e21}
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
  #storagePane .backup-item .item-state{display:none}
  #storagePane .backup-item .item-state.warning,
  #storagePane .backup-item .item-state.bad,
  #storagePane .backup-item .item-state.working{display:block}
  #storagePane .backup-item .storage-meta{margin-top:5px;font-size:10px;color:#8d8582}
  #storagePane .backup-item .storage-meta span:nth-child(1),
  #storagePane .backup-item .storage-meta span:nth-child(2),
  #storagePane .backup-item .storage-meta span:nth-child(6),
  #storagePane .backup-item .storage-meta span:nth-child(7),
  #storagePane .backup-item .storage-meta span:nth-child(8),
  #storagePane .backup-item .storage-meta span:nth-child(9){display:none}
  #storagePane .backup-item .storage-meter{height:3px;margin-top:8px;background:#262326}
  #storagePane .backup-item .item-actions{opacity:0;pointer-events:none;transition:opacity .12s ease}
  #storagePane .backup-item:hover .item-actions,
  #storagePane .backup-item:focus-within .item-actions{opacity:1;pointer-events:auto}

  .storage-add-backup{
    min-height:72px;padding:10px 4px;display:grid;grid-template-columns:48px minmax(0,1fr);gap:10px;
    align-items:center;border:0;border-bottom:1px solid #201e20;border-radius:0;background:transparent
  }
  .storage-add-backup:hover{transform:none;background:rgba(255,255,255,.016)}
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
    #storagePane .backup-item .item-actions{
      opacity:1;transform:none;pointer-events:auto;background:rgba(15,13,16,.72);backdrop-filter:blur(10px)
    }
  }

  @media(max-width:820px){
    #storagePane{width:min(100% - 24px,1180px);padding-top:10px;gap:22px}
    #storagePane .storage-folders-section{grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:11px}
  }

  @media(max-width:540px){
    #storagePane{width:calc(100% - 18px)}
    #storagePane .storage-folders-section{grid-template-columns:1fr;gap:10px}
    #storagePane .folder-item .storage-folder-samples,
    .storage-add-folder .storage-add-visual{aspect-ratio:2/1}
    #storagePane .folder-item .storage-copy{padding:10px 11px 11px}
    .storage-path-name{font-size:13px}
    #storagePane .folder-item .storage-meta{font-size:9px}
    #storagePane .folder-item .item-actions{right:7px;top:7px}
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
