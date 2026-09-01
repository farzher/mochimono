const pane = document.querySelector('#storagePane');
const backups = document.querySelector('#backups');

if (pane && backups) {
  const style = document.createElement('style');
  style.textContent = `
    #refreshBackups{display:none!important}
    .storage-page-title{display:none!important}
    .storage-overview{gap:7px!important}
    .storage-quick-row:has(.storage-quick-card.good){grid-template-columns:1fr}
    .storage-quick-card.good{display:none!important}
    .storage-integrity:not(.warn):not(.bad){min-height:28px!important;justify-content:flex-end;padding:0!important}
    .storage-integrity:not(.warn):not(.bad)>.storage-integrity-dot{margin-right:auto}
    .storage-integrity:not(.warn):not(.bad)>strong,.storage-integrity:not(.warn):not(.bad)>span:not(.storage-integrity-dot){display:none!important}
    .storage-integrity:not(.warn):not(.bad)>button{margin-left:0!important;width:27px!important;height:27px!important;opacity:.45}
    .storage-integrity:not(.warn):not(.bad)>button:hover{opacity:1}
    .storage-secondary-menu{position:relative;flex:0 0 auto}
    .storage-secondary-menu>summary{width:30px;height:30px;display:grid;place-items:center;border-radius:8px;color:#8e8582;cursor:pointer;list-style:none;font-size:17px;font-weight:750;letter-spacing:1px}
    .storage-secondary-menu>summary::-webkit-details-marker{display:none}
    .storage-secondary-menu>summary:hover,.storage-secondary-menu[open]>summary{background:#252126;color:#fff}
    .storage-secondary-popover{position:absolute;z-index:40;right:0;top:34px;width:126px;padding:5px;border:1px solid #302b30;border-radius:10px;background:#171518;box-shadow:0 14px 40px rgba(0,0,0,.48)}
    #storagePane .storage-secondary-popover .action-link{width:100%!important;height:32px!important;display:flex!important;align-items:center!important;justify-content:flex-start!important;padding:0 9px!important;border-radius:7px!important;font-size:11px!important;color:#b8afac!important;text-align:left!important}
    #storagePane .storage-secondary-popover .action-link:hover{background:#252126!important;color:#fff!important}
    #storagePane .storage-secondary-popover .action-link.primary-action{color:#e0b7b1!important}
    #storagePane .storage-secondary-popover .action-link::before{display:none!important;content:none!important}
    #storagePane .backup-actions{opacity:.5}
    #storagePane .backup-item:hover .backup-actions,#storagePane .backup-item:focus-within .backup-actions{opacity:1}
    @media(max-width:700px){.storage-secondary-popover{width:150px}.storage-secondary-menu>summary{width:32px}.storage-integrity:not(.warn):not(.bad){min-height:22px!important}}
  `;
  document.head.append(style);

  function compactBackupActions() {
    for (const row of backups.querySelectorAll('.backup-item')) {
      const actions = row.querySelector('.backup-actions');
      if (!actions || actions.querySelector('.storage-secondary-menu')) continue;
      const secondary = [
        actions.querySelector('[data-restore]'),
        actions.querySelector('[data-verify]'),
        actions.querySelector('[data-configure]')
      ].filter(Boolean);
      if (!secondary.length) continue;

      const menu = document.createElement('details');
      menu.className = 'storage-secondary-menu';
      menu.innerHTML = '<summary aria-label="More backup actions" title="More">•••</summary><div class="storage-secondary-popover"></div>';
      const popover = menu.querySelector('.storage-secondary-popover');
      for (const button of secondary) popover.append(button);
      actions.append(menu);

      popover.addEventListener('click', event => {
        if (event.target.closest('button')) menu.open = false;
      });
    }
  }

  new MutationObserver(compactBackupActions).observe(backups, { childList: true, subtree: true });
  compactBackupActions();

  document.addEventListener('pointerdown', event => {
    for (const menu of pane.querySelectorAll('.storage-secondary-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
}
