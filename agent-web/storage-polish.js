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
    width:min(1220px,calc(100% - 48px));padding-top:22px;padding-bottom:72px;gap:34px
  }
  #storagePane .dashboard-section{padding:0}
  #storagePane #activityCard{display:none!important}
  #storagePane #protectionDashboard{display:none!important}
  #folderAdd{display:none!important}
  #folders>.empty-state,#folders>.muted,#backups>.empty-state,#backups>.muted{display:none!important}

  /* Folders are visual storage locations. Keep the cards large enough that the
     preview is useful instead of squeezing as many cards as possible on screen. */
  #storagePane .storage-folders-section{
    display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:20px;align-items:start
  }
  #storagePane .storage-folders-section>#folders{display:contents}

  #storagePane .folder-item{
    position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;padding:0;
    overflow:hidden;border:1px solid #292529;border-radius:16px;background:#121013;
    box-shadow:0 1px 0 rgba(255,255,255,.025) inset,0 8px 28px rgba(0,0,0,.09);
    transition:border-color .14s ease,background .14s ease,box-shadow .14s ease
  }
  #storagePane .folder-item:hover{
    z-index:2;border-color:#403940;background:#151316;
    box-shadow:0 1px 0 rgba(255,255,255,.035) inset,0 12px 34px rgba(0,0,0,.14)
  }

  /* The source thumbnails are 768px. Three substantial panes stay crisp and are
     much easier to read than five tiny panes inside a narrow card. */
  #storagePane .folder-item .storage-folder-samples{
    order:0;width:100%!important;height:auto!important;aspect-ratio:16/9;
    grid-template-columns:1.7fr 1fr!important;grid-template-rows:1fr 1fr!important;gap:4px!important;
    border-radius:0!important;background:#0a090b;cursor:pointer
  }
  #storagePane .folder-item .storage-folder-sample:nth-child(n+4){display:none!important}
  #storagePane .folder-item .storage-folder-sample:first-child{grid-row:1 / 3}
  #storagePane .folder-item .storage-folder-sample{background:#171518}
  #storagePane .folder-item .storage-folder-sample img{transition:opacity .16s ease!important;transform:none!important}
  #storagePane .folder-item .storage-folder-samples:hover{outline:0!important}

  #storagePane .folder-item .storage-copy{
    order:1;min-width:0;min-height:92px;align-self:stretch;padding:14px 15px 15px;
    display:flex;flex-direction:column;justify-content:center
  }
  #storagePane .folder-item .storage-title{
    display:flex;align-items:flex-start;gap:9px;min-width:0
  }
  #storagePane .folder-item .storage-title strong{
    min-width:0;flex:1;display:flex;flex-direction:column-reverse;align-items:flex-start;gap:4px;
    font-weight:400;letter-spacing:0;cursor:pointer;overflow:hidden
  }
  .storage-path-name{
    display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;color:#f0e9e5;
    font-size:16px;font-weight:740;letter-spacing:-.018em;line-height:1.2;white-space:nowrap
  }
  .storage-path-parent{
    display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#77706e;
    font:10px/1.25 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace
  }
  #storagePane .folder-item .item-state{display:none!important}
  #storagePane .folder-item .storage-meta{
    display:flex;align-items:center;min-width:0;margin-top:10px;gap:7px;
    color:#b2aaa6;font-size:12px;font-weight:600;line-height:1.2;letter-spacing:-.005em
  }
  #storagePane .folder-item .storage-meta span:nth-child(1),
  #storagePane .folder-item .storage-meta span:nth-child(3){color:#c8bfbb}
  #storagePane .folder-item .storage-meta span:nth-child(2){color:#5f595a;font-weight:400}
  #storagePane .folder-item .storage-meta span:nth-child(4),
  #storagePane .folder-item .storage-meta span:nth-child(5){display:none}
  #storagePane .folder-item .storage-meter{display:none!important}
  #storagePane .folder-item .storage-modes{
    flex:0 0 auto;margin-top:0;padding:3px 7px;border:1px solid rgba(224,159,151,.13);border-radius:999px;
    background:#2a2023;color:#dfaaa4;font-size:9px;font-weight:760;line-height:1.25
  }

  /* Desktop controls are not merely transparent: they do not render until the
     card is hovered. Touch devices get a persistent accessible control strip. */
  #storagePane .folder-item .item-actions{
    position:absolute;z-index:5;right:10px;top:10px;width:auto;min-width:0;padding:4px;
    display:none;gap:2px;align-items:center;border:1px solid rgba(255,255,255,.075);border-radius:10px;
    background:rgba(14,12,15,.88);box-shadow:0 6px 20px rgba(0,0,0,.3);backdrop-filter:blur(12px)
  }
  #storagePane .folder-item:hover .item-actions{display:flex}
  #storagePane .folder-item .item-actions .action-link,
  #storagePane .folder-item .item-actions .icon{
    min-height:29px;padding:5px 8px;border:0;border-radius:7px;background:transparent;
    color:#b6adaa;font-size:10px;font-weight:690
  }
  #storagePane .folder-item .item-actions .action-link:hover,
  #storagePane .folder-item .item-actions .icon:hover{background:rgba(255,255,255,.1);color:#fff}
  #storagePane .folder-item .item-actions .primary-action{color:#f0b2ab}
  #storagePane .folder-item .item-actions .icon.tiny{width:29px;padding:0;font-size:16px;font-weight:400}

  #storagePane .folder-item .item-progress{
    margin-top:10px;padding-top:10px;border-top:1px solid #292429
  }

  /* Add folder is a real peer of the folder cards: same preview ratio, same footer
     height, same outer geometry. */
  .storage-add-card{
    width:100%;min-width:0;border:1px solid #292529;border-radius:16px;background:#100f11;color:#847b79;
    text-align:left;font-weight:650;overflow:hidden;transition:border-color .14s ease,background .14s ease
  }
  .storage-add-card:hover{border-color:#403940;background:#141215;color:#d9d0cc}
  .storage-add-folder{
    min-height:0;padding:0!important;display:flex!important;flex-direction:column!important;gap:0!important;align-items:stretch!important
  }
  .storage-add-folder .storage-add-visual{
    width:100%!important;height:auto!important;aspect-ratio:16/9;display:grid;place-items:center;
    border:0!important;border-bottom:1px dashed #373238!important;border-radius:0!important;
    background:#111013;color:#625b5d;font-size:32px;font-weight:280;transition:.14s
  }
  .storage-add-folder:hover .storage-add-visual{border-color:#554b52!important;background:#161417;color:#b9aeab}
  .storage-add-folder .storage-add-copy{
    min-height:92px;box-sizing:border-box;display:flex;align-items:center;padding:14px 15px;
    color:#928987;font-size:13px;font-weight:690
  }
  .storage-add-folder:hover .storage-add-copy{color:#e0d7d3}

  .storage-backups-section{margin-top:12px;padding-top:24px!important;border-top:1px solid #211e21}
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
  #storagePane .backup-item .item-actions{display:none}
  #storagePane .backup-item:hover .item-actions{display:flex}

  .storage-add-backup{
    min-height:72px;padding:10px 4px;display:grid;grid-template-columns:48px minmax(0,1fr);gap:10px;
    align-items:center;border:0;border-bottom:1px solid #201e20;border-radius:0;background:transparent
  }
  .storage-add-backup:hover{background:rgba(255,255,255,.016)}
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
      display:flex;background:rgba(14,12,15,.82);backdrop-filter:blur(10px)
    }
  }

  @media(max-width:900px){
    #storagePane{width:min(100% - 28px,1220px);padding-top:14px;gap:26px}
    #storagePane .storage-folders-section{grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:15px}
  }

  @media(max-width:620px){
    #storagePane{width:calc(100% - 20px)}
    #storagePane .storage-folders-section{grid-template-columns:1fr;gap:13px}
    #storagePane .folder-item .storage-folder-samples,
    .storage-add-folder .storage-add-visual{aspect-ratio:16/9}
    #storagePane .folder-item .storage-copy{min-height:88px;padding:13px 14px 14px}
    .storage-add-folder .storage-add-copy{min-height:88px;padding:13px 14px}
    .storage-path-name{font-size:15px}
    .storage-path-parent{font-size:9.5px}
    #storagePane .folder-item .storage-meta{font-size:11.5px}
    #storagePane .folder-item .item-actions{right:8px;top:8px}
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
