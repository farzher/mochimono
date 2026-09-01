const pane = document.querySelector('#storagePane');
const foldersRoot = document.querySelector('#folders');
const backupsRoot = document.querySelector('#backups');
const filesFrame = document.querySelector('#filesFrame');
const storageToggle = document.querySelector('[data-client-tab="storage"]');

if (pane) {
  pane.classList.add('storage-v2');

  const style = document.createElement('style');
  style.textContent = `
    #storagePane.storage-v2{
      width:min(1220px,calc(100% - 64px))!important;
      gap:48px!important;
      padding-top:34px!important;
    }
    #storagePane.storage-v2 .storage-overview{gap:14px!important}
    #storagePane.storage-v2 .storage-page-title{font-size:25px!important;color:#f2ebe7!important;font-weight:740!important;letter-spacing:-.04em!important}
    #storagePane.storage-v2 [data-storage-overview],
    #storagePane.storage-v2 [data-integrity-overview]{display:none!important}

    .storage-v2-hero{
      display:grid;
      grid-template-columns:minmax(260px,1.15fr) minmax(450px,1.85fr);
      gap:12px;
      margin-top:4px;
    }
    .storage-v2-safety{
      position:relative;
      min-height:224px;
      display:flex;
      flex-direction:column;
      justify-content:space-between;
      padding:25px;
      overflow:hidden;
      border:1px solid #332e34;
      border-radius:22px;
      background:linear-gradient(145deg,#1b1619 0%,#121113 72%);
    }
    .storage-v2-safety::after{
      content:'';
      position:absolute;
      width:220px;height:220px;
      right:-74px;bottom:-104px;
      border-radius:50%;
      background:radial-gradient(circle,rgba(239,160,154,.13),transparent 67%);
      pointer-events:none;
    }
    .storage-v2-kicker{color:#908785;font-size:11px;font-weight:720;letter-spacing:.02em}
    .storage-v2-state{display:flex;align-items:center;gap:13px;margin-top:9px}
    .storage-v2-state-icon{
      width:48px;height:48px;flex:0 0 auto;
      display:grid;place-items:center;
      border-radius:16px;
      background:#203027;
      color:#9ed5ad;
      font-size:25px;font-weight:850;
      box-shadow:inset 0 0 0 1px rgba(128,200,149,.2);
    }
    .storage-v2-safety.warn .storage-v2-state-icon{background:#322a1c;color:#e0bd77;box-shadow:inset 0 0 0 1px rgba(215,176,109,.2)}
    .storage-v2-safety.bad .storage-v2-state-icon{background:#351d1f;color:#ec9a94;box-shadow:inset 0 0 0 1px rgba(221,129,122,.22)}
    .storage-v2-state-copy strong{display:block;color:#f3ece8;font-size:25px;font-weight:730;letter-spacing:-.035em;line-height:1.05}
    .storage-v2-state-copy span{display:block;margin-top:5px;color:#8f8784;font-size:11px;line-height:1.4}

    .storage-v2-route{display:grid;grid-template-columns:1fr 26px 1fr 26px 1fr;align-items:center;margin-top:22px}
    .storage-v2-route-line{height:3px;border-radius:99px;background:#2c282d;overflow:hidden}
    .storage-v2-route-line::after{content:'';display:block;width:100%;height:100%;background:#79b78a;transform-origin:left;transform:scaleX(var(--active,0))}
    .storage-v2-route-step{min-width:0;display:grid;justify-items:center;gap:6px;color:#756e6c}
    .storage-v2-route-step i{
      width:38px;height:38px;display:grid;place-items:center;
      border:1px solid #302c31;border-radius:12px;background:#151316;
      color:#777071;font-style:normal;font-size:17px;font-weight:800;
    }
    .storage-v2-route-step.active i{border-color:#35533e;background:#18251c;color:#8dca9d}
    .storage-v2-route-step.partial i{border-color:#59492d;background:#241f16;color:#d9b776}
    .storage-v2-route-step b{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aaa19e;font-size:10px;font-weight:720}
    .storage-v2-route-step small{color:#6f6866;font-size:9px;font-weight:650}

    .storage-v2-metrics{
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:12px;
    }
    .storage-v2-metric{
      min-height:224px;
      display:grid;
      grid-template-rows:auto 1fr auto;
      justify-items:center;
      padding:19px 18px 17px;
      border:1px solid #302c31;
      border-radius:22px;
      background:#131214;
      text-align:center;
    }
    .storage-v2-metric>span{justify-self:start;color:#8e8683;font-size:11px;font-weight:720}
    .storage-v2-ring{
      --p:0;
      --ring:#86b592;
      position:relative;
      width:112px;height:112px;
      align-self:center;
      display:grid;place-items:center;
      border-radius:50%;
      background:conic-gradient(var(--ring) calc(var(--p) * 1%),#28252a 0);
      box-shadow:0 10px 35px rgba(0,0,0,.15);
    }
    .storage-v2-ring::before{content:'';position:absolute;inset:9px;border-radius:50%;background:#131214;box-shadow:inset 0 0 0 1px #2a272c}
    .storage-v2-ring>div{position:relative;z-index:1}
    .storage-v2-ring strong{display:block;color:#f0e9e5;font-size:22px;font-weight:730;letter-spacing:-.04em;line-height:1}
    .storage-v2-ring small{display:block;margin-top:4px;color:#756e6c;font-size:9px;font-weight:680}
    .storage-v2-ring.good{--ring:#80c895}
    .storage-v2-ring.warn{--ring:#d7b06d}
    .storage-v2-ring.bad{--ring:#dd817a}
    .storage-v2-metric>strong{font-size:12px!important;color:#c6bdba!important;font-weight:680!important;letter-spacing:-.01em!important}

    #storagePane.storage-v2>.dashboard-section{gap:14px!important}
    #storagePane.storage-v2 .section-head{min-height:42px!important}
    #storagePane.storage-v2 .section-head h2{font-size:18px!important;color:#eee7e3!important;font-weight:720!important;letter-spacing:-.025em!important}
    #storagePane.storage-v2 .round-action{width:38px!important;height:38px!important;border-radius:12px!important;background:#1a181b!important;color:#aaa19e!important}
    #storagePane.storage-v2 .round-action:hover{background:#262228!important;color:#fff!important}

    #storagePane.storage-v2 #folders:has(.folder-mode-group){gap:34px!important}
    #storagePane.storage-v2 .folder-mode-group{gap:12px!important}
    #storagePane.storage-v2 .folder-group-head{padding:0 3px!important}
    #storagePane.storage-v2 .folder-group-head span{font-size:13px!important;color:#bbb2ae!important;font-weight:720!important}
    #storagePane.storage-v2 .folder-group-head small{min-width:24px;text-align:center;padding:3px 7px!important;border-radius:999px!important;background:#201d21!important;color:#817977!important;font-size:10px!important}
    #storagePane.storage-v2 .folder-mode-list{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:14px!important}

    #storagePane.storage-v2 .folder-item{
      min-height:318px!important;
      padding:0!important;
      border:1px solid #302c31!important;
      border-radius:20px!important;
      background:#121113!important;
      overflow:hidden!important;
    }
    #storagePane.storage-v2 .folder-item::before{display:none!important}
    #storagePane.storage-v2 .folder-item:hover{background:#151316!important;border-color:#403a41!important;transform:translateY(-1px)}
    #storagePane.storage-v2 .folder-item .storage-copy{display:block!important;padding:0 18px 18px!important}
    #storagePane.storage-v2 .folder-item .storage-title{
      display:grid!important;
      grid-template-columns:minmax(0,1fr) auto!important;
      align-items:center!important;
      gap:9px!important;
      margin-top:15px!important;
      padding:0!important;
    }
    #storagePane.storage-v2 .folder-item .storage-title strong{
      order:1!important;
      font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace!important;
      font-size:11px!important;
      font-weight:590!important;
      line-height:1.35!important;
      color:#d6cfcb!important;
      white-space:nowrap!important;
      overflow:hidden!important;
      text-overflow:ellipsis!important;
      overflow-wrap:normal!important;
    }
    #storagePane.storage-v2 .folder-item .storage-mode{
      order:2!important;
      width:auto!important;height:auto!important;
      padding:5px 8px!important;
      border:1px solid #343139!important;
      border-radius:999px!important;
      background:#1a181c!important;
      color:#9d9592!important;
      font-size:9px!important;
      line-height:1!important;
    }
    #storagePane.storage-v2 .folder-item .storage-mode.protected{border-color:#4a393b!important;background:#211719!important;color:#e0a6a1!important}
    #storagePane.storage-v2 .folder-item .storage-mode.local{border-color:#343a44!important;background:#171a1f!important;color:#a7afbc!important}
    #storagePane.storage-v2 .folder-item .material-row-stats,
    #storagePane.storage-v2 .folder-item .storage-events,
    #storagePane.storage-v2 .folder-item .storage-meta,
    #storagePane.storage-v2 .folder-item .storage-meter{display:none!important}
    #storagePane.storage-v2 .folder-item .item-actions{top:10px!important;right:10px!important;z-index:5;opacity:0!important}
    #storagePane.storage-v2 .folder-item:hover .item-actions,#storagePane.storage-v2 .folder-item:focus-within .item-actions{opacity:1!important}

    .storage-v2-samples{
      height:126px;
      display:grid;
      grid-template-columns:1.55fr 1fr 1fr;
      grid-template-rows:1fr 1fr;
      gap:3px;
      margin:0 -18px;
      overflow:hidden;
      background:#0b0a0c;
    }
    .storage-v2-sample{position:relative;display:grid;place-items:center;overflow:hidden;background:#19171a;color:#716a69;font-size:20px;font-weight:750}
    .storage-v2-sample:first-child{grid-row:1 / 3}
    .storage-v2-sample img{width:100%;height:100%;display:block;object-fit:cover;background:#0b0a0c}
    .storage-v2-sample.video::after{content:'▶';position:absolute;left:9px;bottom:7px;width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:rgba(0,0,0,.62);color:white;font-size:9px;padding-left:1px}
    .storage-v2-sample.empty{background:linear-gradient(135deg,#171519,#100f11)}
    .storage-v2-sample small{max-width:85%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;color:#6f6866}

    .storage-v2-folder-facts{display:flex;align-items:flex-end;gap:18px;margin-top:17px}
    .storage-v2-folder-fact strong{display:block;color:#eee7e3;font-size:22px;font-weight:720;letter-spacing:-.035em;line-height:1}
    .storage-v2-folder-fact span{display:block;margin-top:5px;color:#716a68;font-size:9px;font-weight:680}
    .storage-v2-folder-track{display:grid;grid-template-columns:1fr 26px 1fr;align-items:center;margin-top:17px}
    .storage-v2-folder-track-line{height:3px;border-radius:99px;background:#2a272b;overflow:hidden}
    .storage-v2-folder-track-line i{display:block;width:100%;height:100%;background:#7fb890;transform:scaleX(0);transform-origin:left;transition:transform .25s ease}
    .storage-v2-folder-track.cloud .storage-v2-folder-track-line i{transform:scaleX(1)}
    .storage-v2-folder-node{display:flex;align-items:center;gap:8px;min-width:0}
    .storage-v2-folder-node:last-child{justify-content:flex-end;text-align:right}
    .storage-v2-folder-node i{width:30px;height:30px;flex:0 0 auto;display:grid;place-items:center;border:1px solid #343038;border-radius:10px;background:#19171a;color:#777071;font-style:normal;font-size:13px;font-weight:800}
    .storage-v2-folder-node.active i{border-color:#35513d;background:#17221a;color:#8ec89d}
    .storage-v2-folder-node.pending i{border-color:#57472d;background:#241f16;color:#d4b171}
    .storage-v2-folder-node b{display:block;color:#aaa19e;font-size:9px;font-weight:720}
    .storage-v2-folder-node small{display:block;margin-top:2px;color:#696260;font-size:8px;font-weight:620}

    #storagePane.storage-v2 #backups{
      display:grid!important;
      grid-template-columns:repeat(2,minmax(0,1fr))!important;
      gap:14px!important;
      border:0!important;
      border-radius:0!important;
      background:transparent!important;
      overflow:visible!important;
    }
    #storagePane.storage-v2 #backups>.backup-item{
      position:relative;
      min-height:246px!important;
      display:block!important;
      padding:20px!important;
      border:1px solid #302c31!important;
      border-radius:20px!important;
      background:#121113!important;
      overflow:hidden!important;
    }
    #storagePane.storage-v2 #backups>.backup-item:hover{background:#151316!important;border-color:#403a41!important}
    #storagePane.storage-v2 .backup-item .storage-title{padding-right:0!important;display:block!important}
    #storagePane.storage-v2 .backup-item .storage-title strong{display:block!important;color:#eee7e3!important;font-size:16px!important;font-weight:720!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #storagePane.storage-v2 .backup-item .storage-path{display:block!important;margin-top:5px!important;color:#706967!important;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:9px!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #storagePane.storage-v2 .backup-item .storage-meta,
    #storagePane.storage-v2 .backup-item .storage-meter,
    #storagePane.storage-v2 .backup-item .material-row-stats,
    #storagePane.storage-v2 .backup-item .item-state{display:none!important}
    #storagePane.storage-v2 .backup-item .item-actions{
      position:absolute!important;
      left:17px!important;right:17px!important;bottom:14px!important;top:auto!important;
      width:auto!important;
      display:flex!important;
      justify-content:flex-start!important;
      gap:5px!important;
      opacity:1!important;
    }
    #storagePane.storage-v2 .backup-item .item-actions button{
      width:auto!important;height:34px!important;
      padding:0 10px!important;
      border-radius:10px!important;
      background:#1b191c!important;
      color:#9f9794!important;
      font-size:10px!important;
      font-weight:700!important;
    }
    #storagePane.storage-v2 .backup-item .item-actions button:hover{background:#282429!important;color:#fff!important}
    #storagePane.storage-v2 .backup-item .item-actions button::before{display:none!important;content:none!important}
    #storagePane.storage-v2 .backup-item .item-actions .primary-action{background:#2a2022!important;color:#e6aca7!important}

    .storage-v2-backup-visual{margin-top:20px}
    .storage-v2-backup-head{display:flex;align-items:center;justify-content:space-between;gap:18px}
    .storage-v2-backup-number strong{display:block;color:#f1eae6;font-size:34px;font-weight:735;line-height:.95;letter-spacing:-.05em}
    .storage-v2-backup-number span{display:block;margin-top:5px;color:#756e6c;font-size:9px;font-weight:700}
    .storage-v2-verify-orb{width:48px;height:48px;display:grid;place-items:center;border:1px solid #344b3a;border-radius:16px;background:#18231b;color:#8ac899;font-size:20px;font-weight:850}
    .storage-v2-verify-orb.warn{border-color:#58492f;background:#241f17;color:#d8b573}
    .storage-v2-verify-orb.bad{border-color:#5c3335;background:#2a181a;color:#e58f89}
    .storage-v2-backup-bar{height:10px;margin-top:17px;overflow:hidden;border-radius:999px;background:#29262b}
    .storage-v2-backup-bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#699f78,#8ac899);transition:width .25s ease}
    .storage-v2-backup-bar.warn i{background:linear-gradient(90deg,#9f7d3f,#d4ae68)}
    .storage-v2-backup-facts{display:flex;justify-content:space-between;gap:12px;margin-top:8px;color:#756e6c;font-size:9px;font-weight:650}
    .storage-v2-backup-facts span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    #storagePane.storage-v2 .folder-add,#storagePane.storage-v2 .inline-add{border-radius:18px!important;padding:16px!important}

    @media(max-width:980px){
      .storage-v2-hero{grid-template-columns:1fr}
      .storage-v2-safety{min-height:190px}
      .storage-v2-metrics{grid-template-columns:repeat(3,1fr)}
      .storage-v2-metric{min-height:190px}
      #storagePane.storage-v2 .folder-mode-list,#storagePane.storage-v2 #backups{grid-template-columns:1fr!important}
    }
    @media(max-width:650px){
      #storagePane.storage-v2{width:min(100% - 20px,1220px)!important;padding-top:20px!important;gap:36px!important}
      .storage-v2-metrics{grid-template-columns:1fr 1fr}
      .storage-v2-metric{min-height:164px;padding:15px}
      .storage-v2-metric:last-child{grid-column:1 / -1;min-height:132px;grid-template-columns:auto 1fr auto;grid-template-rows:1fr;align-items:center;justify-items:start;gap:18px;text-align:left}
      .storage-v2-metric:last-child>span{align-self:start}
      .storage-v2-ring{width:92px;height:92px}.storage-v2-ring strong{font-size:19px}
      .storage-v2-route{grid-template-columns:1fr 16px 1fr 16px 1fr}.storage-v2-route-line{height:2px}
      #storagePane.storage-v2 .folder-item{min-height:300px!important}
      .storage-v2-samples{height:112px}
      #storagePane.storage-v2 .backup-item .item-actions{overflow-x:auto}
    }
  `;
  document.head.append(style);

  const bytes = number => {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Number(number) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  };
  const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
  const percent = (value, total) => total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
  const age = value => {
    const time = new Date(value || 0).getTime();
    if (!Number.isFinite(time) || !time) return '';
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));

  async function request(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', headers: { 'content-type':'application/json' }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function ensureHero() {
    let hero = pane.querySelector('.storage-v2-hero');
    if (hero) return hero;
    hero = document.createElement('div');
    hero.className = 'storage-v2-hero';
    hero.innerHTML = '<section class="storage-v2-safety"><div><span class="storage-v2-kicker">PROTECTION</span><div class="storage-v2-state"><span class="storage-v2-state-icon">✓</span><div class="storage-v2-state-copy"><strong>Checking…</strong><span></span></div></div></div><div class="storage-v2-route"></div></section><div class="storage-v2-metrics"></div>';
    pane.querySelector('.storage-overview')?.append(hero);
    return hero;
  }

  function metric(label, value, sub, ratio, className = '') {
    return `<article class="storage-v2-metric"><span>${esc(label)}</span><div class="storage-v2-ring ${className}" style="--p:${ratio}"><div><strong>${esc(value)}</strong><small>${esc(sub)}</small></div></div><strong>${esc(label)}</strong></article>`;
  }

  function renderHero(state, folderStats, backupData, integrity) {
    const hero = ensureHero();
    const safety = hero.querySelector('.storage-v2-safety');
    const configured = state?.settings?.folders || [];
    const protectedFolders = configured.filter(item => item.protected !== false);
    const available = folderStats.filter(item => item.available !== false).length;
    const stats = state?.server?.online ? state.server.stats : null;
    const cloudUsed = Number(stats?.bytes) || 0;
    const cloudCapacity = Number(stats?.capacityBytes) || 0;
    const cloudRatio = cloudCapacity ? percent(cloudUsed, cloudCapacity) : 0;
    const backups = backupData.backups || [];
    const desired = backups.reduce((sum, item) => sum + (Number(item.remote?.desiredBytes) || 0), 0);
    const protectedBytes = backups.reduce((sum, item) => sum + (Number(item.remote?.protectedBytes) || 0), 0);
    const backupRatio = desired ? percent(protectedBytes, desired) : 0;
    const integrityBad = Number(integrity?.bad) > 0 || integrity?.catalog?.status === 'corrupt';
    const integrityRunning = Boolean(integrity?.running);
    const integrityKnown = Boolean(integrity?.lastScrubAt);

    let status = 'Protected';
    let detail = 'Local files, Mochimono, and backup are in good shape.';
    let className = '';
    let icon = '✓';
    if (integrityBad) {
      status = 'Needs attention'; detail = 'Storage integrity found a problem that should be repaired.'; className = 'bad'; icon = '!';
    } else if (protectedFolders.length && !state?.server?.online) {
      status = 'Cloud unavailable'; detail = 'Local files remain available, but Mochimono cannot currently confirm the cloud copy.'; className = 'warn'; icon = '!';
    } else if (protectedFolders.length && !backups.length) {
      status = 'Add a backup'; detail = 'Cloud-synced folders have no independent backup yet.'; className = 'warn'; icon = '+';
    } else if (desired && backupRatio < 99.5) {
      status = 'Backup in progress'; detail = `${Math.round(backupRatio)}% of configured backup data is currently covered.`; className = 'warn'; icon = '↻';
    } else if (!protectedFolders.length && configured.length) {
      status = 'Local library'; detail = 'These folders are being indexed here but are not copied to Mochimono.'; className = 'warn'; icon = '•';
    } else if (!configured.length) {
      status = 'Add your files'; detail = 'Choose folders to browse locally or protect with Mochimono.'; className = 'warn'; icon = '+';
    }

    safety.className = `storage-v2-safety ${className}`.trim();
    safety.querySelector('.storage-v2-state-icon').textContent = icon;
    safety.querySelector('.storage-v2-state-copy strong').textContent = status;
    safety.querySelector('.storage-v2-state-copy span').textContent = detail;

    const localActive = available > 0;
    const cloudActive = Boolean(protectedFolders.length && state?.server?.online);
    const backupActive = Boolean(desired && backupRatio >= 99.5);
    const backupPartial = Boolean(desired && backupRatio > 0 && backupRatio < 99.5);
    hero.querySelector('.storage-v2-route').innerHTML = `
      <span class="storage-v2-route-step ${localActive ? 'active' : ''}"><i>▣</i><b>This PC</b><small>${available} folder${available === 1 ? '' : 's'}</small></span>
      <span class="storage-v2-route-line" style="--active:${cloudActive ? 1 : 0}"></span>
      <span class="storage-v2-route-step ${cloudActive ? 'active' : protectedFolders.length ? 'partial' : ''}"><i>☁</i><b>Mochimono</b><small>${protectedFolders.length} synced</small></span>
      <span class="storage-v2-route-line" style="--active:${backupActive ? 1 : backupPartial ? backupRatio / 100 : 0}"></span>
      <span class="storage-v2-route-step ${backupActive ? 'active' : backupPartial ? 'partial' : ''}"><i>◆</i><b>Backup</b><small>${desired ? `${Math.round(backupRatio)}%` : 'none'}</small></span>`;

    const integrityRatio = integrityRunning
      ? percent(Number(integrity?.progress?.checked) || 0, Number(integrity?.progress?.total) || Number(integrity?.total) || 0)
      : integrityBad ? 100 : integrityKnown ? 100 : 0;
    const integrityValue = integrityRunning ? `${Math.round(integrityRatio)}%` : integrityBad ? '!' : integrityKnown ? '✓' : '—';
    const integritySub = integrityRunning ? 'checking' : integrityBad ? 'problem' : integrityKnown ? age(integrity.lastScrubAt) : 'not checked';
    hero.querySelector('.storage-v2-metrics').innerHTML = [
      metric('Cloud space', cloudCapacity ? `${Math.round(cloudRatio)}%` : bytes(cloudUsed), cloudCapacity ? `${bytes(cloudUsed)} used` : 'stored', cloudCapacity ? cloudRatio : Math.min(100, cloudUsed ? 100 : 0), cloudRatio > 90 ? 'warn' : 'good'),
      metric('Backup coverage', desired ? `${Math.round(backupRatio)}%` : '—', desired ? `${bytes(protectedBytes)} protected` : 'no backup', backupRatio, desired && backupRatio < 99.5 ? 'warn' : 'good'),
      metric('Integrity', integrityValue, integritySub, integrityRatio, integrityBad ? 'bad' : integrityRunning || !integrityKnown ? 'warn' : 'good')
    ].join('');
  }

  function sampleGlyph(file) {
    const base = String(file?.mime || '').split('/')[0];
    if (base === 'audio') return '♪';
    if (base === 'text' || base === 'application') return '▤';
    return '·';
  }

  function renderSamples(row, sample, ready) {
    let strip = row.querySelector('.storage-v2-samples');
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'storage-v2-samples';
      row.querySelector('.storage-copy')?.prepend(strip);
    }
    const files = sample?.files || [];
    const cells = [];
    for (let index = 0; index < 5; index++) {
      const file = files[index];
      if (!file) {
        cells.push('<span class="storage-v2-sample empty"></span>');
        continue;
      }
      const image = String(file.mime || '').startsWith('image/');
      const video = String(file.mime || '').startsWith('video/');
      const canPreview = image || (video && ready.has(file.hash));
      cells.push(canPreview
        ? `<span class="storage-v2-sample ${video ? 'video' : ''}" title="${esc(file.filename)}"><img src="/api/thumbs/${file.hash}?v=3" alt="" loading="lazy" decoding="async" onerror="this.remove()"></span>`
        : `<span class="storage-v2-sample ${video ? 'video' : ''}" title="${esc(file.filename)}"><b>${sampleGlyph(file)}</b><small>${esc(file.filename)}</small></span>`);
    }
    strip.innerHTML = cells.join('');
  }

  function decorateFolders(folderStats, state, samples, ready) {
    const configured = state?.settings?.folders || [];
    for (const row of foldersRoot?.querySelectorAll('[data-folder-path]') || []) {
      const path = row.dataset.folderPath || '';
      const stats = folderStats.find(item => samePath(item.path, path));
      const config = configured.find(item => samePath(item.path, path));
      if (!stats || !config) continue;
      renderSamples(row, samples.find(item => samePath(item.path, path)), ready);

      let facts = row.querySelector('.storage-v2-folder-facts');
      if (!facts) {
        facts = document.createElement('div');
        facts.className = 'storage-v2-folder-facts';
        row.querySelector('.storage-title')?.after(facts);
      }
      facts.innerHTML = `<div class="storage-v2-folder-fact"><strong>${esc(bytes(stats.bytes))}</strong><span>DATA</span></div><div class="storage-v2-folder-fact"><strong>${Number(stats.files || 0).toLocaleString()}</strong><span>FILES</span></div>`;

      let track = row.querySelector('.storage-v2-folder-track');
      if (!track) {
        track = document.createElement('div');
        track.className = 'storage-v2-folder-track';
        facts.after(track);
      }
      const protectedFolder = config.protected !== false;
      const synced = protectedFolder && Boolean(config.lastSynced);
      const localState = stats.available === false ? 'pending' : 'active';
      const cloudState = synced ? 'active' : protectedFolder ? 'pending' : '';
      const localMeta = stats.available === false ? 'Unavailable' : stats.lastIndexed ? `Indexed ${age(stats.lastIndexed)}` : 'Available';
      const cloudMeta = protectedFolder ? (config.lastSynced ? `Synced ${age(config.lastSynced)}` : 'Waiting') : 'Not uploaded';
      track.className = `storage-v2-folder-track ${synced ? 'cloud' : ''}`;
      track.innerHTML = `<span class="storage-v2-folder-node ${localState}"><i>▣</i><span><b>This PC</b><small>${esc(localMeta)}</small></span></span><span class="storage-v2-folder-track-line"><i></i></span><span class="storage-v2-folder-node ${cloudState}"><span><b>Mochimono</b><small>${esc(cloudMeta)}</small></span><i>☁</i></span>`;
    }
  }

  function verificationState(location) {
    const bad = Number(location.meta?.lastVerifyBad) || 0;
    const catalogBad = location.meta?.lastVerifyCatalogHealthy === false;
    if (bad || catalogBad) return { className:'bad', icon:'!', text:bad ? `${bad} damaged` : 'Catalog issue' };
    const value = location.meta?.lastVerifiedAt || location.local?.oldestVerification;
    if (!value) return { className:'warn', icon:'?', text:'Not verified' };
    const stale = Date.now() - new Date(value).getTime() > 180 * 24 * 60 * 60 * 1000;
    return { className:stale ? 'warn' : '', icon:stale ? '↻' : '✓', text:stale ? 'Verify due' : `Verified ${age(value)}` };
  }

  function decorateBackups(backupData) {
    const backups = backupData.backups || [];
    for (const row of backupsRoot?.querySelectorAll('[data-backup-index]') || []) {
      const location = backups[Number(row.dataset.backupIndex)];
      if (!location) continue;
      let visual = row.querySelector('.storage-v2-backup-visual');
      if (!visual) {
        visual = document.createElement('div');
        visual.className = 'storage-v2-backup-visual';
        row.querySelector('.storage-path')?.after(visual);
      }
      const desired = Number(location.remote?.desiredBytes) || 0;
      const protectedBytes = Number(location.remote?.protectedBytes) || 0;
      const localBytes = Number(location.local?.bytes) || 0;
      const ratio = desired ? percent(protectedBytes, desired) : localBytes ? 100 : 0;
      const verify = verificationState(location);
      const coverageText = desired ? `${Math.round(ratio)}%` : localBytes ? '100%' : '0%';
      const left = desired ? `${bytes(protectedBytes)} / ${bytes(desired)}` : `${bytes(localBytes)} stored`;
      visual.innerHTML = `<div class="storage-v2-backup-head"><div class="storage-v2-backup-number"><strong>${coverageText}</strong><span>BACKED UP</span></div><span class="storage-v2-verify-orb ${verify.className}" title="${esc(verify.text)}">${verify.icon}</span></div><div class="storage-v2-backup-bar ${ratio < 99.5 ? 'warn' : ''}"><i style="width:${Math.max(ratio ? 2 : 0,ratio)}%"></i></div><div class="storage-v2-backup-facts"><span>${esc(left)}</span><span>${esc(verify.text)}</span></div>`;
    }
  }

  async function thumbnailReadiness(samples) {
    const hashes = [...new Set(samples.flatMap(item => item.files || []).filter(file => /^(image|video)\//.test(String(file.mime || ''))).map(file => file.hash))];
    if (!hashes.length) return new Set();
    try {
      const response = await request('/api/thumbs/check', { method:'POST', body:JSON.stringify({ hashes }) });
      return new Set((response.thumbnails || []).map(item => item.hash));
    } catch { return new Set(); }
  }

  let refreshing = false;
  let timer = 0;
  async function refresh() {
    clearTimeout(timer);
    if (refreshing || pane.hidden) return;
    refreshing = true;
    try {
      const [stateResult, foldersResult, backupsResult, localResult, integrityResult] = await Promise.allSettled([
        request('/api/state'),
        request('/api/folder-stats'),
        request('/api/backups'),
        request('/api/client/local-catalog?limit=720'),
        request('/api/integrity')
      ]);
      const state = stateResult.status === 'fulfilled' ? stateResult.value : {};
      const folderStats = foldersResult.status === 'fulfilled' ? foldersResult.value.folders || [] : [];
      const backupData = backupsResult.status === 'fulfilled' ? backupsResult.value : { backups:[] };
      const samples = localResult.status === 'fulfilled' ? localResult.value.folderSamples || [] : [];
      const integrity = integrityResult.status === 'fulfilled' ? integrityResult.value : {};
      const ready = await thumbnailReadiness(samples);
      renderHero(state, folderStats, backupData, integrity);
      decorateFolders(folderStats, state, samples, ready);
      decorateBackups(backupData);
    } finally {
      refreshing = false;
      if (!pane.hidden) timer = setTimeout(refresh, 5000);
    }
  }

  pane.addEventListener('click', event => {
    const metric = event.target.closest('.storage-v2-metric');
    if (!metric) return;
    const label = metric.querySelector(':scope > span')?.textContent;
    const mode = label === 'Cloud space' ? 'server' : label === 'Backup coverage' ? 'verified-backup' : '';
    if (!mode) return;
    const locations = filesFrame?.contentWindow?.mochimonoLocations;
    if (!locations?.select) return;
    locations.select(mode).then(() => {
      if (!pane.hidden) storageToggle?.click();
      filesFrame?.focus();
    }).catch(() => {});
  });

  new MutationObserver(() => {
    if (!pane.hidden) refresh();
    else clearTimeout(timer);
  }).observe(pane, { attributes:true, attributeFilter:['hidden'] });
  new MutationObserver(() => { if (!pane.hidden) refresh(); }).observe(foldersRoot, { childList:true, subtree:true });
  new MutationObserver(() => { if (!pane.hidden) refresh(); }).observe(backupsRoot, { childList:true, subtree:true });

  ensureHero();
  if (!pane.hidden) refresh();
}
