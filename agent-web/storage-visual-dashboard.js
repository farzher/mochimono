const pane = document.querySelector('#storagePane');
const foldersRoot = document.querySelector('#folders');
const backupsRoot = document.querySelector('#backups');
const filesFrame = document.querySelector('#filesFrame');
const storageToggle = document.querySelector('[data-client-tab="storage"]');
const folderAdd = document.querySelector('#folderAdd');
const backupAdd = document.querySelector('#backupAdd');
const showFolderAdd = document.querySelector('#showFolderAdd');
const showBackupAdd = document.querySelector('#showBackupAdd');

if (pane) {
  pane.classList.add('storage-v2');

  const style = document.createElement('style');
  style.textContent = `
    #storagePane.storage-v2{
      width:min(1200px,calc(100% - 64px))!important;
      margin:0 auto!important;
      padding:34px 0 88px!important;
      gap:46px!important;
    }
    #storagePane.storage-v2 [data-storage-overview],
    #storagePane.storage-v2 [data-integrity-overview]{display:none!important}
    #storagePane.storage-v2 .storage-page-title{font-size:25px!important;color:#f2ebe7!important;font-weight:740!important;letter-spacing:-.04em!important}

    .storage-dashboard-hero{display:grid;grid-template-columns:minmax(250px,1.05fr) minmax(480px,1.95fr);gap:12px;margin-top:4px}
    .storage-status-card,.storage-metric{border:1px solid #302c31;border-radius:21px;background:#131214}
    .storage-status-card{min-height:190px;display:grid;grid-template-rows:1fr auto;align-items:center;padding:22px;overflow:hidden}
    .storage-status-main{display:flex;align-items:center;justify-content:center;gap:12px;min-height:90px}
    .storage-status-icon{width:58px;height:58px;display:grid;place-items:center;border:1px solid #35513d;border-radius:19px;background:#18251c;color:#93cea2;font-size:28px;font-weight:850}
    .storage-status-card.warn .storage-status-icon{border-color:#59492d;background:#241f16;color:#d9b776}
    .storage-status-card.bad .storage-status-icon{border-color:#5c3335;background:#2a181a;color:#e58f89}
    .storage-status-word{display:none;color:#d5cdca;font-size:18px;font-weight:700;letter-spacing:-.025em}
    .storage-status-card.warn .storage-status-word,.storage-status-card.bad .storage-status-word{display:block}
    .storage-route{display:grid;grid-template-columns:1fr 25px 1fr 25px 1fr;align-items:center}
    .storage-route-line{height:3px;border-radius:99px;background:#2b282c;overflow:hidden}
    .storage-route-line i{display:block;width:100%;height:100%;background:#79b78a;transform:scaleX(var(--p,0));transform-origin:left;transition:transform .2s ease}
    .storage-route-node{display:grid;justify-items:center;gap:6px;color:#77706d}
    .storage-route-node i{width:36px;height:36px;display:grid;place-items:center;border:1px solid #302c31;border-radius:11px;background:#171518;color:#777071;font-style:normal;font-size:15px;font-weight:800}
    .storage-route-node.on i{border-color:#35513d;background:#18251c;color:#8ec89d}
    .storage-route-node.partial i{border-color:#59492d;background:#241f16;color:#d9b776}
    .storage-route-node b{font-size:9px;font-weight:700;color:#918986}

    .storage-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .storage-metric{min-height:190px;display:grid;grid-template-rows:auto 1fr;justify-items:center;padding:17px;text-align:center}
    .storage-metric>span{justify-self:start;color:#817976;font-size:10px;font-weight:700}
    .storage-ring{--p:0;--ring:#80c895;position:relative;width:108px;height:108px;align-self:center;display:grid;place-items:center;border-radius:50%;background:conic-gradient(var(--ring) calc(var(--p) * 1%),#28252a 0)}
    .storage-ring::before{content:'';position:absolute;inset:9px;border-radius:50%;background:#131214;box-shadow:inset 0 0 0 1px #2a272c}
    .storage-ring>div{position:relative;z-index:1;max-width:90px}
    .storage-ring strong{display:block;color:#f0e9e5;font-size:21px;font-weight:730;letter-spacing:-.04em;line-height:1}
    .storage-ring small{display:block;margin-top:5px;color:#77706d;font-size:8px;font-weight:650;white-space:nowrap}
    .storage-ring.warn{--ring:#d7b06d}.storage-ring.bad{--ring:#dd817a}
    .storage-file-check{width:100px;height:100px;align-self:center;display:grid;place-items:center;border:1px solid #344b3a;border-radius:28px;background:#18231b;color:#91cc9f}
    .storage-file-check.warn{border-color:#58492f;background:#241f17;color:#d8b573}.storage-file-check.bad{border-color:#5c3335;background:#2a181a;color:#e58f89}
    .storage-file-check strong{display:block;font-size:30px;font-weight:850;line-height:1}
    .storage-file-check small{display:block;margin-top:6px;color:#77706d;font-size:8px;font-weight:650}

    #storagePane.storage-v2>.dashboard-section{gap:14px!important}
    #storagePane.storage-v2 .section-head{min-height:40px!important;padding:0 2px!important}
    #storagePane.storage-v2 .section-head h2{font-size:18px!important;color:#eee7e3!important;font-weight:720!important;letter-spacing:-.025em!important}
    #storagePane.storage-v2 #showFolderAdd,#storagePane.storage-v2 #showBackupAdd{display:none!important}

    #storagePane.storage-v2 #folders:has(.folder-mode-group){display:grid!important;gap:32px!important}
    #storagePane.storage-v2 .folder-mode-group{display:grid!important;gap:11px!important}
    #storagePane.storage-v2 .folder-group-head{padding:0 2px!important}
    #storagePane.storage-v2 .folder-group-head span{font-size:12px!important;color:#aaa19e!important;font-weight:700!important}
    #storagePane.storage-v2 .folder-group-head small{padding:2px 7px!important;border-radius:999px!important;background:#1e1b1f!important;color:#716a68!important;font-size:9px!important}
    #storagePane.storage-v2 .folder-mode-list{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:14px!important}

    #storagePane.storage-v2 .folder-item{position:relative!important;display:block!important;min-height:286px!important;padding:0!important;border:1px solid #302c31!important;border-radius:20px!important;background:#121113!important;overflow:hidden!important}
    #storagePane.storage-v2 .folder-item::before{display:none!important}
    #storagePane.storage-v2 .folder-item:hover{background:#151316!important;border-color:#403a41!important}
    #storagePane.storage-v2 .folder-item .storage-copy{display:block!important;padding:0 18px 17px!important;cursor:default!important}
    #storagePane.storage-v2 .folder-item .storage-title{display:block!important;margin-top:14px!important;padding:0!important}
    #storagePane.storage-v2 .folder-item .storage-title strong{display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:2!important;white-space:normal!important;overflow:hidden!important;overflow-wrap:anywhere!important;color:#d9d1cd!important;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace!important;font-size:11px!important;font-weight:590!important;line-height:1.35!important;cursor:pointer!important}
    #storagePane.storage-v2 .folder-item .storage-mode,#storagePane.storage-v2 .folder-item .item-state,#storagePane.storage-v2 .folder-item .storage-meta,#storagePane.storage-v2 .folder-item .storage-meter,#storagePane.storage-v2 .folder-item .material-row-stats,#storagePane.storage-v2 .folder-item .storage-events{display:none!important}
    #storagePane.storage-v2 .folder-item .item-actions{position:absolute!important;top:9px!important;right:9px!important;width:auto!important;z-index:4;display:flex!important;gap:2px!important;opacity:0!important}
    #storagePane.storage-v2 .folder-item:hover .item-actions,#storagePane.storage-v2 .folder-item:focus-within .item-actions{opacity:1!important}
    #storagePane.storage-v2 .folder-item .item-actions button{width:31px!important;height:31px!important;border-radius:9px!important}

    .storage-folder-samples{height:124px;display:grid;grid-template-columns:1.55fr 1fr 1fr;grid-template-rows:1fr 1fr;gap:3px;margin:0 -18px;overflow:hidden;background:#0b0a0c}
    .storage-folder-sample{position:relative;display:grid;place-items:center;overflow:hidden;background:#19171a;color:#716a69;font-size:19px;font-weight:750}
    .storage-folder-sample:first-child{grid-row:1 / 3}.storage-folder-sample img{width:100%;height:100%;display:block;object-fit:cover;background:#0b0a0c}.storage-folder-sample.video::after{content:'▶';position:absolute;left:8px;bottom:7px;width:23px;height:23px;display:grid;place-items:center;border-radius:50%;background:rgba(0,0,0,.62);color:#fff;font-size:8px;padding-left:1px}.storage-folder-sample small{max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6f6866;font-size:8px}
    .storage-folder-facts{display:flex;align-items:baseline;gap:20px;margin-top:16px}.storage-folder-facts strong{color:#eee7e3;font-size:21px;font-weight:720;letter-spacing:-.035em}.storage-folder-facts small{color:#77706d;font-size:9px;font-weight:650}
    .storage-folder-route{display:grid;grid-template-columns:1fr 26px 1fr;align-items:center;margin-top:14px}.storage-folder-route-line{height:3px;border-radius:99px;background:#2a272b;overflow:hidden}.storage-folder-route-line i{display:block;width:100%;height:100%;background:#7fb890;transform:scaleX(var(--p,0));transform-origin:left;transition:transform .2s ease}
    .storage-folder-node{display:flex;align-items:center;gap:8px;min-width:0}.storage-folder-node:last-child{justify-content:flex-end;text-align:right}.storage-folder-node>i{width:29px;height:29px;flex:0 0 auto;display:grid;place-items:center;border:1px solid #343038;border-radius:10px;background:#19171a;color:#777071;font-style:normal;font-size:12px;font-weight:800}.storage-folder-node.on>i{border-color:#35513d;background:#17221a;color:#8ec89d}.storage-folder-node.partial>i{border-color:#57472d;background:#241f16;color:#d4b171}.storage-folder-node b{display:block;color:#918986;font-size:9px;font-weight:700}.storage-folder-node small{display:block;margin-top:2px;color:#6e6765;font-size:8px;font-weight:620}

    #storagePane.storage-v2 #backups{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:14px!important;border:0!important;background:transparent!important;overflow:visible!important}
    #storagePane.storage-v2 #backups>.backup-item{position:relative;display:block!important;min-height:218px!important;padding:19px!important;border:1px solid #302c31!important;border-radius:20px!important;background:#121113!important;overflow:hidden!important}
    #storagePane.storage-v2 #backups>.backup-item:hover{background:#151316!important;border-color:#403a41!important}
    #storagePane.storage-v2 .backup-item .storage-title{display:block!important;padding:0!important}.storage-v2 .backup-item .storage-title strong{display:block!important;color:#eee7e3!important;font-size:15px!important;font-weight:720!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.storage-v2 .backup-item .storage-path{display:block!important;margin-top:5px!important;color:#706967!important;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:9px!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #storagePane.storage-v2 .backup-item .storage-meta,#storagePane.storage-v2 .backup-item .storage-meter,#storagePane.storage-v2 .backup-item .material-row-stats,#storagePane.storage-v2 .backup-item .item-state{display:none!important}
    #storagePane.storage-v2 .backup-item .item-actions{position:absolute!important;left:16px!important;right:16px!important;bottom:13px!important;top:auto!important;width:auto!important;display:flex!important;justify-content:flex-start!important;gap:4px!important;opacity:1!important}.storage-v2 .backup-item .item-actions button{width:auto!important;height:32px!important;padding:0 9px!important;border-radius:9px!important;background:#1b191c!important;color:#9f9794!important;font-size:9px!important;font-weight:700!important}.storage-v2 .backup-item .item-actions button::before{display:none!important;content:none!important}.storage-v2 .backup-item .item-actions .primary-action{background:#2a2022!important;color:#e6aca7!important}
    .storage-backup-visual{margin-top:18px}.storage-backup-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.storage-backup-head strong{color:#f1eae6;font-size:32px;font-weight:735;line-height:.95;letter-spacing:-.05em}.storage-backup-check{width:44px;height:44px;display:grid;place-items:center;border:1px solid #344b3a;border-radius:14px;background:#18231b;color:#8ac899;font-size:18px;font-weight:850}.storage-backup-check.warn{border-color:#58492f;background:#241f17;color:#d8b573}.storage-backup-check.bad{border-color:#5c3335;background:#2a181a;color:#e58f89}.storage-backup-bar{height:9px;margin-top:15px;overflow:hidden;border-radius:999px;background:#29262b}.storage-backup-bar i{display:block;height:100%;border-radius:inherit;background:#80b88e;transition:width .2s ease}.storage-backup-bar.warn i{background:#c99d58}.storage-backup-foot{display:flex;justify-content:space-between;gap:10px;margin-top:7px;color:#706967;font-size:8px;font-weight:650}.storage-backup-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    .storage-add-slot{width:calc(50% - 7px);min-height:126px;display:grid;place-items:center;gap:8px;margin-top:14px;padding:18px;border:1px dashed #39343a;border-radius:20px;background:#100f11;color:#716a68;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease}.storage-add-slot:hover,.storage-add-slot:focus-visible{background:#161417;border-color:#5a5057;color:#b8afab;outline:none}.storage-add-icon{position:relative;display:grid;place-items:center}.storage-add-slot svg{width:42px;height:42px;fill:none;stroke:currentColor;stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round}.storage-add-plus{position:absolute;width:19px;height:19px;display:grid;place-items:center;margin:23px 0 0 32px;border:2px solid #100f11;border-radius:50%;background:#2a262b;color:#b9b0ac;font-size:13px;line-height:1}.storage-add-slot strong{font-size:10px;font-weight:680;color:inherit}
    #storagePane.storage-v2 .folder-add,#storagePane.storage-v2 .inline-add{width:100%!important;margin-top:10px!important;padding:15px!important;border-radius:18px!important;background:#131114!important}.storage-v2 .folder-mode-note,.storage-v2 .folder-mode-option span{display:none!important}

    @media(max-width:980px){.storage-dashboard-hero{grid-template-columns:1fr}.storage-metrics{grid-template-columns:repeat(3,1fr)}#storagePane.storage-v2 .folder-mode-list,#storagePane.storage-v2 #backups{grid-template-columns:1fr!important}.storage-add-slot{width:100%}}
    @media(max-width:650px){#storagePane.storage-v2{width:min(100% - 20px,1200px)!important;padding-top:20px!important;gap:36px!important}.storage-metrics{grid-template-columns:1fr 1fr}.storage-metric{min-height:160px}.storage-metric:last-child{grid-column:1/-1;min-height:125px}.storage-status-card{min-height:160px}.storage-folder-samples{height:110px}.storage-add-slot{min-height:106px;border-radius:17px}}
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
  const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };

  async function request(path, options = {}) {
    const response = await fetch(path, { cache:'no-store', headers:{ 'content-type':'application/json' }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function ensureHero() {
    let hero = pane.querySelector('.storage-dashboard-hero');
    if (hero) return hero;
    hero = document.createElement('div');
    hero.className = 'storage-dashboard-hero';
    hero.innerHTML = `
      <section class="storage-status-card">
        <div class="storage-status-main"><span class="storage-status-icon">✓</span><strong class="storage-status-word"></strong></div>
        <div class="storage-route">
          <span class="storage-route-node" data-route="local"><i>▣</i><b>This PC</b></span><span class="storage-route-line"><i></i></span>
          <span class="storage-route-node" data-route="cloud"><i>☁</i><b>Mochimono</b></span><span class="storage-route-line"><i></i></span>
          <span class="storage-route-node" data-route="backup"><i>◆</i><b>Backup</b></span>
        </div>
      </section>
      <div class="storage-metrics">
        <article class="storage-metric" data-metric="server"><span>Server storage</span><div class="storage-ring"><div><strong>—</strong><small></small></div></div></article>
        <article class="storage-metric" data-metric="backup"><span>Backup</span><div class="storage-ring"><div><strong>—</strong><small></small></div></div></article>
        <article class="storage-metric" data-metric="files"><span>Mochimono files</span><div class="storage-file-check"><div><strong>—</strong><small></small></div></div></article>
      </div>`;
    pane.querySelector('.storage-overview')?.append(hero);
    return hero;
  }

  function setRoute(node, mode) {
    if (!node) return;
    node.classList.toggle('on', mode === 'on');
    node.classList.toggle('partial', mode === 'partial');
  }

  function verificationCurrent(location) {
    const desired = Number(location.remote?.desiredBytes) || 0;
    const protectedBytes = Number(location.remote?.protectedBytes) || 0;
    if (desired && protectedBytes / desired < .995) return false;
    if (Number(location.meta?.lastVerifyBad) > 0 || location.meta?.lastVerifyCatalogHealthy === false) return false;
    const verifiedAt = new Date(location.meta?.lastVerifiedAt || location.local?.oldestVerification || 0).getTime();
    if (!Number.isFinite(verifiedAt) || !verifiedAt || Date.now() - verifiedAt > 180 * 86400000) return false;
    const updatedAt = new Date(location.meta?.lastBackupAt || 0).getTime();
    return !(Number.isFinite(updatedAt) && updatedAt > verifiedAt);
  }

  function renderHero(state, folderStats, backupData, integrity) {
    const hero = ensureHero();
    const configured = state?.settings?.folders || [];
    const cloudFolders = configured.filter(item => item.protected !== false);
    const available = folderStats.filter(item => item.available !== false).length;
    const backups = backupData.backups || [];
    const desired = backups.reduce((sum, item) => sum + (Number(item.remote?.desiredBytes) || 0), 0);
    const backed = backups.reduce((sum, item) => sum + (Number(item.remote?.protectedBytes) || 0), 0);
    const backupRatio = desired ? percent(backed, desired) : 0;
    const integrityBad = Number(integrity?.bad) > 0 || integrity?.catalog?.status === 'corrupt';
    const integrityKnown = Boolean(integrity?.lastScrubAt);
    const verified = Boolean(backups.length && backups.every(verificationCurrent));

    let tone = '';
    let icon = '✓';
    let word = '';
    if (integrityBad) { tone = 'bad'; icon = '!'; word = 'Repair'; }
    else if (cloudFolders.length && !state?.server?.online) { tone = 'warn'; icon = '!'; word = 'Offline'; }
    else if (cloudFolders.length && !backups.length) { tone = 'warn'; icon = '+'; word = 'Backup'; }
    else if (desired && backupRatio < 99.5) { tone = 'warn'; icon = '↻'; word = 'Backup'; }
    else if (backups.length && !verified) { tone = 'warn'; icon = '✓'; word = 'Verify'; }
    else if (cloudFolders.length && !integrityKnown) { tone = 'warn'; icon = '↻'; word = 'Check'; }
    else if (!configured.length) { tone = 'warn'; icon = '+'; word = 'Add files'; }

    const status = hero.querySelector('.storage-status-card');
    status.className = `storage-status-card ${tone}`.trim();
    setText(status.querySelector('.storage-status-icon'), icon);
    setText(status.querySelector('.storage-status-word'), word);

    setRoute(hero.querySelector('[data-route="local"]'), available ? 'on' : '');
    setRoute(hero.querySelector('[data-route="cloud"]'), cloudFolders.length ? (state?.server?.online ? 'on' : 'partial') : '');
    setRoute(hero.querySelector('[data-route="backup"]'), desired ? (verified ? 'on' : backupRatio ? 'partial' : '') : '');
    const lines = hero.querySelectorAll('.storage-route-line i');
    lines[0]?.style.setProperty('--p', cloudFolders.length && state?.server?.online ? 1 : 0);
    lines[1]?.style.setProperty('--p', verified ? 1 : backupRatio / 100);

    const stats = state?.server?.online ? state.server.stats : null;
    const used = Number(stats?.bytes) || 0;
    const capacity = Number(stats?.capacityBytes) || 0;
    const usedRatio = capacity ? percent(used, capacity) : 0;
    const serverMetric = hero.querySelector('[data-metric="server"]');
    const serverRing = serverMetric.querySelector('.storage-ring');
    serverRing.style.setProperty('--p', usedRatio);
    serverRing.classList.toggle('warn', usedRatio > 90);
    setText(serverRing.querySelector('strong'), stats ? bytes(used) : '—');
    setText(serverRing.querySelector('small'), stats && capacity ? `/ ${bytes(capacity)}` : 'offline');

    const backupMetric = hero.querySelector('[data-metric="backup"]');
    const backupRing = backupMetric.querySelector('.storage-ring');
    backupRing.style.setProperty('--p', backupRatio);
    backupRing.classList.toggle('warn', Boolean(desired && backupRatio < 99.5));
    setText(backupRing.querySelector('strong'), desired ? `${Math.round(backupRatio)}%` : '—');
    setText(backupRing.querySelector('small'), desired ? `${bytes(backed)} / ${bytes(desired)}` : 'none');

    const fileMetric = hero.querySelector('[data-metric="files"]');
    const fileCheck = fileMetric.querySelector('.storage-file-check');
    const running = Boolean(integrity?.running);
    const checked = Number(integrity?.progress?.checked) || 0;
    const total = Number(integrity?.progress?.total) || Number(integrity?.total) || 0;
    const scanRatio = total ? percent(checked, total) : 0;
    fileCheck.classList.toggle('bad', integrityBad);
    fileCheck.classList.toggle('warn', !integrityBad && (running || !integrityKnown));
    setText(fileCheck.querySelector('strong'), running ? `${Math.round(scanRatio)}%` : integrityBad ? '!' : integrityKnown ? '✓' : '—');
    setText(fileCheck.querySelector('small'), running ? 'checking' : integrityBad ? 'problem' : integrityKnown ? age(integrity.lastScrubAt) : 'not checked');
  }

  function sampleGlyph(file) {
    const base = String(file?.mime || '').split('/')[0];
    return base === 'audio' ? '♪' : base === 'text' || base === 'application' ? '▤' : '·';
  }

  function renderSamples(row, sample, ready) {
    let strip = row.querySelector('.storage-folder-samples');
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'storage-folder-samples';
      row.querySelector('.storage-copy')?.prepend(strip);
    }
    const files = sample?.files || [];
    const key = JSON.stringify(files.slice(0,5).map(file => [file.hash, file.filename, file.mime, ready.has(file.hash)]));
    if (strip.dataset.key === key) return;
    strip.dataset.key = key;
    const cells = [];
    for (let index = 0; index < 5; index++) {
      const file = files[index];
      if (!file) { cells.push('<span class="storage-folder-sample"></span>'); continue; }
      const image = String(file.mime || '').startsWith('image/');
      const video = String(file.mime || '').startsWith('video/');
      const preview = image || (video && ready.has(file.hash));
      cells.push(preview
        ? `<span class="storage-folder-sample ${video ? 'video' : ''}" title="${esc(file.filename)}"><img src="/api/thumbs/${file.hash}?v=3" alt="" loading="lazy" decoding="async"></span>`
        : `<span class="storage-folder-sample ${video ? 'video' : ''}" title="${esc(file.filename)}"><b>${sampleGlyph(file)}</b><small>${esc(file.filename)}</small></span>`);
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

      let facts = row.querySelector('.storage-folder-facts');
      if (!facts) {
        facts = document.createElement('div');
        facts.className = 'storage-folder-facts';
        row.querySelector('.storage-title')?.after(facts);
        facts.innerHTML = '<strong data-folder-size></strong><strong data-folder-count></strong>';
      }
      setText(facts.querySelector('[data-folder-size]'), bytes(stats.bytes));
      setText(facts.querySelector('[data-folder-count]'), `${Number(stats.files || 0).toLocaleString()} files`);

      let route = row.querySelector('.storage-folder-route');
      if (!route) {
        route = document.createElement('div');
        route.className = 'storage-folder-route';
        route.innerHTML = '<span class="storage-folder-node" data-local><i>▣</i><span><b>This PC</b><small></small></span></span><span class="storage-folder-route-line"><i></i></span><span class="storage-folder-node" data-cloud><span><b>Mochimono</b><small></small></span><i>☁</i></span>';
        facts.after(route);
      }
      const cloud = config.protected !== false;
      const synced = cloud && Boolean(config.lastSynced);
      const localNode = route.querySelector('[data-local]');
      const cloudNode = route.querySelector('[data-cloud]');
      localNode.className = `storage-folder-node ${stats.available === false ? 'partial' : 'on'}`;
      cloudNode.className = `storage-folder-node ${synced ? 'on' : cloud ? 'partial' : ''}`;
      setText(localNode.querySelector('small'), stats.available === false ? 'unavailable' : stats.lastIndexed ? age(stats.lastIndexed) : '');
      setText(cloudNode.querySelector('small'), synced ? age(config.lastSynced) : cloud ? 'waiting' : '');
      route.querySelector('.storage-folder-route-line i').style.setProperty('--p', synced ? 1 : 0);
    }
  }

  function verificationState(location) {
    const bad = Number(location.meta?.lastVerifyBad) || 0;
    if (bad || location.meta?.lastVerifyCatalogHealthy === false) return { cls:'bad', icon:'!', text:bad ? `${bad} bad` : 'catalog' };
    const value = location.meta?.lastVerifiedAt || location.local?.oldestVerification;
    if (!value) return { cls:'warn', icon:'?', text:'not checked' };
    const stale = Date.now() - new Date(value).getTime() > 180 * 86400000;
    return { cls:stale ? 'warn' : '', icon:stale ? '↻' : '✓', text:age(value) };
  }

  function decorateBackups(backupData) {
    const locations = backupData.backups || [];
    for (const row of backupsRoot?.querySelectorAll('[data-backup-index]') || []) {
      const location = locations[Number(row.dataset.backupIndex)];
      if (!location) continue;
      let visual = row.querySelector('.storage-backup-visual');
      if (!visual) {
        visual = document.createElement('div');
        visual.className = 'storage-backup-visual';
        visual.innerHTML = '<div class="storage-backup-head"><strong></strong><span class="storage-backup-check"></span></div><div class="storage-backup-bar"><i></i></div><div class="storage-backup-foot"><span data-bytes></span><span data-check></span></div>';
        row.querySelector('.storage-path')?.after(visual);
      }
      const desired = Number(location.remote?.desiredBytes) || 0;
      const backed = Number(location.remote?.protectedBytes) || 0;
      const localBytes = Number(location.local?.bytes) || 0;
      const ratio = desired ? percent(backed, desired) : localBytes ? 100 : 0;
      const verify = verificationState(location);
      const key = JSON.stringify([desired,backed,localBytes,verify.cls,verify.icon,verify.text]);
      if (visual.dataset.key === key) continue;
      visual.dataset.key = key;
      setText(visual.querySelector('.storage-backup-head strong'), `${Math.round(ratio)}%`);
      const check = visual.querySelector('.storage-backup-check');
      check.className = `storage-backup-check ${verify.cls}`.trim();
      setText(check, verify.icon);
      const bar = visual.querySelector('.storage-backup-bar');
      bar.classList.toggle('warn', ratio < 99.5);
      bar.querySelector('i').style.width = `${Math.max(ratio ? 2 : 0, ratio)}%`;
      setText(visual.querySelector('[data-bytes]'), desired ? `${bytes(backed)} / ${bytes(desired)}` : `${bytes(localBytes)}`);
      setText(visual.querySelector('[data-check]'), verify.text);
    }
  }

  async function thumbnailReadiness(samples) {
    const hashes = [...new Set(samples.flatMap(item => item.files || []).filter(file => /^(image|video)\//.test(String(file.mime || ''))).map(file => file.hash))];
    if (!hashes.length) return new Set();
    try {
      const data = await request('/api/thumbs/check', { method:'POST', body:JSON.stringify({ hashes }) });
      return new Set((data.thumbnails || []).filter(item => Number(item.width) > 0 && Number(item.height) > 0).map(item => item.hash));
    } catch { return new Set(); }
  }

  function addSlot(kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `storage-add-slot storage-add-${kind}`;
    button.setAttribute('aria-label', kind === 'folder' ? 'Add folder' : 'Add backup');
    button.innerHTML = kind === 'folder'
      ? '<span class="storage-add-icon"><svg viewBox="0 0 48 48"><path d="M5.5 13.5h13l4-5h8l3.4 5h8.6v25H5.5z"/></svg><span class="storage-add-plus">+</span></span><strong>Add folder</strong>'
      : '<span class="storage-add-icon"><svg viewBox="0 0 48 48"><path d="M8 11.5h32v25H8z"/><path d="M8 29h32M33.5 33h.01M28.5 33h.01"/></svg><span class="storage-add-plus">+</span></span><strong>Add backup</strong>';
    return button;
  }

  if (foldersRoot && folderAdd && !pane.querySelector('.storage-add-folder')) {
    const slot = addSlot('folder');
    foldersRoot.after(slot);
    slot.after(folderAdd);
    slot.addEventListener('click', () => showFolderAdd?.click());
  }
  if (backupsRoot && backupAdd && !pane.querySelector('.storage-add-backup')) {
    const slot = addSlot('backup');
    backupsRoot.after(slot);
    slot.after(backupAdd);
    slot.addEventListener('click', () => showBackupAdd?.click());
  }

  let refreshing = false;
  let queued = false;
  let timer = 0;
  async function refresh() {
    clearTimeout(timer);
    if (refreshing || pane.hidden) { queued = true; return; }
    refreshing = true;
    queued = false;
    let active = false;
    try {
      const [stateResult, foldersResult, backupsResult, localResult, integrityResult] = await Promise.allSettled([
        request('/api/state'), request('/api/folder-stats'), request('/api/backups'), request('/api/client/local-catalog?limit=720'), request('/api/integrity')
      ]);
      const state = stateResult.status === 'fulfilled' ? stateResult.value : {};
      active = state?.job?.status === 'running';
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
      if (queued) queueMicrotask(refresh);
      else if (!pane.hidden) timer = setTimeout(refresh, active ? 1800 : 15000);
    }
  }

  pane.addEventListener('click', event => {
    const metric = event.target.closest('[data-metric]');
    if (!metric) return;
    const where = metric.dataset.metric === 'server' ? 'server' : metric.dataset.metric === 'backup' ? 'verified-backup' : '';
    if (!where) return;
    const locations = filesFrame?.contentWindow?.mochimonoLocations;
    if (!locations?.select) return;
    locations.select(where).then(() => {
      if (!pane.hidden) storageToggle?.click();
      filesFrame?.focus();
    }).catch(() => {});
  });

  let mutationTimer = 0;
  const changed = () => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => { if (!pane.hidden) refresh(); }, 80);
  };
  new MutationObserver(() => { if (!pane.hidden) refresh(); else clearTimeout(timer); }).observe(pane, { attributes:true, attributeFilter:['hidden'] });
  if (foldersRoot) new MutationObserver(changed).observe(foldersRoot, { childList:true });
  if (backupsRoot) new MutationObserver(changed).observe(backupsRoot, { childList:true });

  ensureHero();
  if (!pane.hidden) refresh();
}
