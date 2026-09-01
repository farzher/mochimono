const pane = document.querySelector('#storagePane');

if (pane) {
  const style = document.createElement('style');
  style.textContent = `
    #storagePane{
      width:min(1160px,calc(100% - 72px))!important;
      margin:0 auto!important;
      padding:44px 0 96px!important;
      gap:54px!important;
    }

    #storagePane .storage-overview{gap:16px!important}
    #storagePane .storage-glance-grid{
      display:grid!important;
      grid-template-columns:repeat(2,minmax(0,1fr))!important;
      gap:14px!important;
      overflow:visible!important;
      border:0!important;
      background:transparent!important;
    }
    #storagePane .storage-glance-card{
      min-height:132px!important;
      padding:22px 24px!important;
      border:1px solid #2b282d!important;
      border-radius:16px!important;
      background:#131114!important;
    }
    #storagePane .storage-glance-card:last-child{border-right:1px solid #2b282d!important}
    #storagePane .storage-glance-card:hover{background:#171518!important;border-color:#39343a!important}
    #storagePane .storage-glance-card>span:first-child{font-size:11px!important;color:#9a9290!important}
    #storagePane .storage-glance-card>strong{margin-top:12px!important;font-size:30px!important;font-weight:690!important}
    #storagePane .material-card-meta{margin-top:8px!important;font-size:10px!important}
    #storagePane .material-card-meter{height:5px!important;margin-top:16px!important;background:#27242a!important}

    #storagePane>.dashboard-section{gap:14px!important}
    #storagePane .section-head{min-height:38px!important;padding:0 1px 4px!important}
    #storagePane .section-head h2{font-size:15px!important;font-weight:700!important;color:#e7e0dc!important;letter-spacing:-.02em!important}
    #storagePane .round-action{width:34px!important;height:34px!important;border-radius:10px!important}

    #folders:has(.folder-mode-group){display:grid!important;gap:30px!important}
    #folders .folder-mode-group{gap:11px!important}
    #folders .folder-group-head{padding:0 2px!important}
    #folders .folder-group-head span{font-size:11px!important;text-transform:none!important;color:#9e9693!important}
    #folders .folder-group-head small{padding:2px 6px;border-radius:999px;background:#1c1a1d;color:#746e6c!important}
    #folders .folder-mode-list{
      display:grid!important;
      grid-template-columns:repeat(2,minmax(0,1fr))!important;
      gap:12px!important;
    }

    #storagePane .folder-item{
      position:relative!important;
      display:grid!important;
      grid-template-columns:minmax(0,1fr)!important;
      min-height:154px!important;
      gap:0!important;
      padding:18px 18px 15px!important;
      border:1px solid #29262b!important;
      border-radius:15px!important;
      background:#121013!important;
      overflow:hidden!important;
    }
    #storagePane .folder-item::before{
      content:'';
      position:absolute;
      left:0;top:0;bottom:0;
      width:3px;
      background:#747b89;
    }
    #storagePane .folder-item.protected-folder::before{background:#dc9b96}
    #storagePane .folder-item:hover{background:#171518!important;border-color:#38333a!important}
    #storagePane .folder-item:first-child,
    #storagePane .folder-item:last-child,
    #storagePane .folder-item:only-child{border-radius:15px!important;border-bottom:1px solid #29262b!important}

    #storagePane .folder-item .storage-copy{cursor:default!important;min-width:0!important}
    #storagePane .folder-item .storage-title{
      display:flex!important;
      align-items:flex-start!important;
      flex-wrap:wrap!important;
      gap:9px!important;
      padding-right:142px!important;
    }
    #storagePane .folder-item .storage-title strong{
      flex:1 0 100%!important;
      min-width:0!important;
      white-space:normal!important;
      overflow:visible!important;
      text-overflow:clip!important;
      overflow-wrap:anywhere!important;
      color:#ede6e2!important;
      font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace!important;
      font-size:12px!important;
      font-weight:590!important;
      line-height:1.5!important;
      cursor:pointer!important;
    }
    #storagePane .folder-item .storage-title strong:hover{color:#fff!important;text-decoration:underline;text-decoration-color:#5b5559;text-underline-offset:3px}
    #storagePane .folder-item .storage-mode{
      width:auto!important;
      height:auto!important;
      display:inline-flex!important;
      align-items:center!important;
      padding:4px 8px!important;
      border:1px solid #353138!important;
      border-radius:999px!important;
      background:#1a181c!important;
      color:#999294!important;
      font-size:9px!important;
      font-weight:700!important;
      line-height:1!important;
    }
    #storagePane .folder-item .storage-mode.protected{
      border-color:#543b3c!important;
      background:#211718!important;
      color:#d9a39f!important;
    }
    #storagePane .folder-item .storage-mode.local{
      border-color:#343942!important;
      background:#16191e!important;
      color:#a2a9b6!important;
    }
    #storagePane .folder-item .item-state{display:none!important}
    #storagePane .folder-item .material-row-stats{margin-top:22px!important}
    #storagePane .folder-item .material-row-line{
      justify-content:flex-start!important;
      gap:8px!important;
      color:#8f8885!important;
      font-size:10px!important;
    }
    #storagePane .folder-item .material-row-line>span::after{content:' ·'}
    #storagePane .folder-item .material-row-line>strong{color:#aaa29f!important;font-size:10px!important}
    #storagePane .folder-item .storage-events{
      margin-top:7px!important;
      color:#797270!important;
      font-size:9px!important;
    }
    #storagePane .folder-item .item-actions{
      position:absolute!important;
      top:13px!important;
      right:12px!important;
      width:auto!important;
      display:flex!important;
      gap:2px!important;
      opacity:.58!important;
    }
    #storagePane .folder-item:hover .item-actions,#storagePane .folder-item:focus-within .item-actions{opacity:1!important}
    #storagePane .folder-item .item-actions button{width:31px!important;height:31px!important;border-radius:9px!important}
    #storagePane .storage-open-folder svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round}
    #storagePane .folder-item [data-protect-folder]{color:#dba29d!important}

    #storagePane #backups{
      border:1px solid #29262b!important;
      border-radius:15px!important;
      overflow:hidden!important;
      background:#121013!important;
    }
    #storagePane #backups>.backup-item{
      min-height:92px!important;
      padding:16px 18px!important;
      border:0!important;
      border-bottom:1px solid #29262b!important;
      border-radius:0!important;
      background:transparent!important;
    }
    #storagePane #backups>.backup-item:last-child{border-bottom:0!important}
    #storagePane #backups>.backup-item:hover{background:#171518!important}
    #storagePane .backup-item .storage-title strong{font-size:13px!important}
    #storagePane .backup-item .material-row-meter{height:5px!important}

    #storagePane .folder-add,#storagePane .inline-add{
      border:1px solid #2c292e!important;
      border-radius:14px!important;
      background:#121013!important;
    }
    #storagePane .folder-mode-option{
      border:1px solid #343038!important;
      border-radius:10px!important;
      background:#151317!important;
    }

    @media(max-width:900px){
      #storagePane{width:min(100% - 32px,1160px)!important;padding-top:30px!important}
      #folders .folder-mode-list{grid-template-columns:1fr!important}
    }
    @media(max-width:620px){
      #storagePane{width:min(100% - 20px,1160px)!important;padding-top:20px!important;gap:38px!important}
      #storagePane .storage-glance-grid{grid-template-columns:1fr!important;gap:8px!important}
      #storagePane .storage-glance-card{min-height:105px!important;padding:17px 18px!important}
      #storagePane .storage-glance-card>strong{font-size:25px!important}
      #storagePane .folder-item{min-height:142px!important;padding:15px 14px 13px!important}
      #storagePane .folder-item .storage-title{padding-right:130px!important}
      #storagePane .folder-item .storage-title strong{font-size:11px!important}
      #storagePane .folder-item .item-actions{top:10px!important;right:9px!important}
    }
  `;
  document.head.append(style);
}
