const CONTROL = 'http://127.0.0.1:8645';
const storagePane = document.querySelector('#storagePane');
const sourceSection = document.querySelector('.storage-folders-section');

if (storagePane && sourceSection) {
  const PLANS = {
    disposable: { name:'One copy', short:'1 copy', detail:'Keep one verified copy. Best for replaceable files.' },
    normal: { name:'Standard', short:'2 copies', detail:'2 verified copies on 2 devices.' },
    important: { name:'Important', short:'3 copies + remote', detail:'3 verified copies, including another site.' },
    critical: { name:'Critical', short:'3 devices · 2 places', detail:'3 verified copies on 3 devices across 2 sites.' }
  };
  const PLAN_ORDER = ['disposable','normal','important','critical'];
  let model = null;
  let dialog = null;
  let timer = 0;
  let busy = false;

  const style = document.createElement('style');
  style.textContent = `
    #protectionDashboard{display:none!important}
    .backup-center{margin-top:20px;padding-top:27px;border-top:1px solid #211e21}
    .backup-center-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
    .backup-center-head h2{margin:0;color:#eee6e2;font-size:19px;font-weight:760;letter-spacing:-.025em}
    .backup-center-manage{border:0;background:transparent;color:#9d9490;font-size:12px;font-weight:700;padding:6px 2px}.backup-center-manage:hover{color:#eee6e2}
    .backup-health{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:17px 18px;border:1px solid #2b282b;border-radius:15px;background:#121013}
    .backup-health-copy{min-width:0}.backup-health-title{display:flex;align-items:center;gap:9px;color:#eee6e2;font-size:17px;font-weight:760;letter-spacing:-.02em}.backup-health-dot{width:9px;height:9px;border-radius:50%;background:#7fbe90;box-shadow:0 0 0 3px rgba(127,190,144,.08)}.backup-health.needs .backup-health-dot{background:#d8a36c;box-shadow:0 0 0 3px rgba(216,163,108,.08)}
    .backup-health-sub{margin-top:5px;color:#918985;font-size:12px;line-height:1.45}.backup-health-sub strong{color:#cfc6c2;font-weight:680}
    .backup-health-actions{display:flex;align-items:center;gap:7px}.backup-health-actions button{white-space:nowrap}
    .backup-progress{height:5px;margin-top:12px;overflow:hidden;border-radius:99px;background:#292529}.backup-progress i{display:block;height:100%;border-radius:inherit;background:#83bb91;transition:width .2s ease}.backup-health.needs .backup-progress i{background:#cfa06f}
    .backup-job{margin-top:9px;padding:9px 11px;border:1px solid #282429;border-radius:9px;background:#0f0e10;color:#8e8582;font-size:11px}.backup-job strong{color:#d8cfcb}
    .backup-plans{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}.backup-plan{min-width:0;padding:10px 11px;border:1px solid #272428;border-radius:10px;background:#100f11}.backup-plan strong{display:block;color:#cfc6c2;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.backup-plan span{display:block;margin-top:3px;color:#7f7774;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.backup-plan b{font-weight:720;color:#aaa19d}
    .backup-attention{margin-top:10px;color:#9f928b;font-size:11px;line-height:1.5}.backup-attention strong{color:#d9c3ae}

    .backup-center-dialog{width:min(780px,calc(100vw - 28px));max-height:min(820px,calc(100dvh - 28px));overflow:auto}.backup-center-dialog .dialog-head{position:sticky;top:0;z-index:4;background:#151315}
    .backup-settings{display:grid;gap:23px}.backup-settings-section{display:grid;gap:9px}.backup-settings-section>header{display:flex;align-items:end;justify-content:space-between;gap:12px}.backup-settings-section h4{margin:0;color:#dcd3cf;font-size:13px}.backup-settings-section header span{color:#7f7774;font-size:10px;text-align:right}
    .backup-plan-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.backup-plan-row{padding:11px 12px;border:1px solid #292529;border-radius:10px;background:#111012}.backup-plan-row strong{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#d2c9c5;font-size:11px}.backup-plan-row strong b{color:#8d8581;font-size:10px;font-weight:680}.backup-plan-row p{margin:5px 0 0;color:#817976;font-size:10px;line-height:1.45}
    .backup-source-list,.backup-destination-list{display:grid;gap:6px}.backup-source-row,.backup-destination-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 11px;border:1px solid #292529;border-radius:10px;background:#111012}.backup-row-copy{min-width:0}.backup-row-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d6cdca;font-size:11px}.backup-row-copy small{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7f7774;font-size:9.5px}.backup-source-row select,.backup-destination-row select,.backup-background select{width:auto;min-width:132px;padding:6px 8px;font-size:10px}
    .backup-destination-controls{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}.backup-destination-controls label{display:flex;align-items:center;gap:5px;color:#817976;font-size:9px}.backup-destination-controls select{min-width:106px}.backup-rely{border:0;background:transparent;color:#a69c98;font-size:10px;font-weight:700;padding:5px}.backup-rely:hover{color:#eee}.backup-rely.off{color:#726a68}
    .backup-background{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 11px;border:1px solid #292529;border-radius:10px;background:#111012}.backup-background strong{display:block;color:#d6cdca;font-size:11px}.backup-background small{display:block;margin-top:3px;color:#7f7774;font-size:9.5px}
    .backup-safety-note{padding:10px 11px;border-radius:9px;background:#0e0d0f;color:#817976;font-size:10px;line-height:1.5}.backup-safety-note strong{color:#bdb3af}
    .backup-empty{padding:11px;color:#807875;font-size:10px}
    @media(max-width:760px){.backup-health{grid-template-columns:1fr}.backup-health-actions{justify-content:flex-start}.backup-plans{grid-template-columns:repeat(2,minmax(0,1fr))}.backup-plan-list{grid-template-columns:1fr}.backup-source-row,.backup-destination-row{grid-template-columns:1fr}.backup-destination-controls{justify-content:flex-start}.backup-settings-section>header{align-items:start;flex-direction:column}.backup-settings-section header span{text-align:left}}
  `;
  document.head.append(style);

  const section = document.createElement('section');
  section.id = 'backupCenter';
  section.className = 'backup-center';
  section.innerHTML = '<div class="backup-center-head"><h2>Backup</h2><button class="backup-center-manage" type="button" data-backup-manage>Manage</button></div><div data-backup-body class="muted">Loading…</div>';

  function placeSection() {
    const storage = document.querySelector('.managed-storage-section');
    if (storage) storage.before(section);
    else sourceSection.after(section);
  }
  placeSection();

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const baseName = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');

  function bytes(number) {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Math.max(0, Number(number) || 0), unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function age(value) {
    const time = new Date(value || 0).getTime();
    if (!time) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60); if (hours < 48) return `${hours}h ago`;
    const days = Math.floor(hours / 24); if (days < 60) return `${days}d ago`;
    const months = Math.floor(days / 30.44); if (months < 24) return `${Math.max(1, months)}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  async function request(base, path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      cache:'no-store',
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
      body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }
  const control = (path, options) => request(CONTROL, path, options);
  const server = (path, options) => request('', path, options);

  function toast(text) {
    const node = document.querySelector('#toast');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(node.timer);
    node.timer = setTimeout(() => node.classList.remove('show'), 2800);
  }

  function modeMap(snapshot) {
    const policies = new Map((snapshot?.policies || []).map(item => [`${item.locationId}\0${item.mediaType}`, item.representation]));
    const retention = new Map((snapshot?.retention || []).map(item => [`${item.locationId}\0${item.mediaType}`, item.allowOriginalRemoval === true]));
    return (locationId, mediaType) => {
      const key = `${locationId}\0${mediaType}`;
      return policies.get(key) === 'compact' ? (retention.get(key) ? 'compact-only' : 'compact') : 'original';
    };
  }

  function planCount(level) {
    const bucket = model?.state?.summary?.levels?.[level] || {};
    return Number(bucket.files) || 0;
  }

  function renderMain() {
    const body = section.querySelector('[data-backup-body]');
    const summary = model?.state?.summary;
    if (!summary) {
      body.className = 'error';
      body.textContent = 'Backup status unavailable';
      return;
    }
    body.className = '';
    const total = Number(summary.files) || 0;
    const protectedFiles = Number(summary.protectedFiles) || 0;
    const needs = Number(summary.needsProtection) || 0;
    const percent = total ? Math.round(protectedFiles / total * 100) : 100;
    const totalBytes = PLAN_ORDER.reduce((sum, level) => sum + (Number(summary.levels?.[level]?.bytes) || 0), 0);
    const protectedBytes = Number(summary.protectedBytes) || 0;
    const job = model.state.job?.status === 'running' && model.state.job?.type === 'protection' ? model.state.job : null;
    const progress = job?.progress || {};
    const title = needs ? `${needs.toLocaleString()} ${needs === 1 ? 'file needs' : 'files need'} another safe copy` : 'Everything is protected';
    const detail = needs
      ? `<strong>${protectedFiles.toLocaleString()} of ${total.toLocaleString()}</strong> files meet their protection target${totalBytes ? ` · ${bytes(protectedBytes)} protected` : ''}`
      : `${total.toLocaleString()} ${total === 1 ? 'file' : 'files'} · ${totalBytes ? `${bytes(totalBytes)} · ` : ''}all protection targets met`;
    body.innerHTML = `
      <div class="backup-health ${needs ? 'needs' : ''}">
        <div class="backup-health-copy">
          <div class="backup-health-title"><i class="backup-health-dot"></i>${esc(title)}</div>
          <div class="backup-health-sub">${detail}</div>
          <div class="backup-progress"><i style="width:${Math.max(0,Math.min(100,percent))}%"></i></div>
        </div>
        <div class="backup-health-actions"><button class="secondary" type="button" data-protect-now ${job ? 'disabled' : ''}>${job ? 'Protecting…' : 'Protect now'}</button></div>
      </div>
      ${job ? `<div class="backup-job"><strong>${esc(progress.phase || job.label || 'Protecting')}</strong>${progress.copied != null ? ` · ${Number(progress.copied).toLocaleString()} copied` : ''}${progress.copiedBytes ? ` · ${bytes(progress.copiedBytes)}` : ''}</div>` : ''}
      <div class="backup-plans">${PLAN_ORDER.map(level => `<div class="backup-plan" title="${esc(PLANS[level].detail)}"><strong>${esc(PLANS[level].name)}</strong><span><b>${planCount(level).toLocaleString()}</b> files · ${esc(PLANS[level].short)}</span></div>`).join('')}</div>
      ${needs ? `<div class="backup-attention">Mochimono will fill missing copies automatically using storage you allow it to rely on. <strong>Offline drives stay remembered, but are not treated as reachable when freeing local files.</strong></div>` : ''}`;
    body.querySelector('[data-protect-now]')?.addEventListener('click', protectNow);
  }

  function ruleFor(importId) {
    return (model?.state?.rules || []).find(rule => rule.scopeType === 'import' && String(rule.scopeId) === String(importId))?.level || 'normal';
  }

  function planOptions(selected) {
    return PLAN_ORDER.map(level => `<option value="${level}" ${level === selected ? 'selected' : ''}>${esc(PLANS[level].name)} · ${esc(PLANS[level].short)}</option>`).join('');
  }

  function backupFor(id) { return (model?.state?.backups || []).find(item => item.id === id); }
  function driveFor(id) { return (model?.drives || []).find(item => item.id === id); }
  function peerFor(id) { return (model?.state?.peers || []).find(item => item.id === id); }

  function destinationStatus(location) {
    if (location.kind === 'primary') return 'Cloud · original library';
    const drive = driveFor(location.id);
    const peer = peerFor(location.id);
    const backup = backupFor(location.id);
    const parts = [];
    if (location.kind === 'peer') parts.push(peer?.online ? 'Online' : 'Offline', 'encrypted remote');
    else if (location.kind === 'backup') parts.push(backup ? 'Connected' : 'Offline');
    if (drive) {
      if (drive.desiredCount) parts.push(`${Number(drive.protectedCount || 0).toLocaleString()}/${Number(drive.desiredCount).toLocaleString()} stored`);
      if (drive.verifiedCount) parts.push(`${Number(drive.verifiedCount).toLocaleString()} verified`);
      if (drive.lastVerifiedAt) parts.push(`verified ${age(drive.lastVerifiedAt)}`);
    }
    if (location.encrypted) parts.push('encrypted');
    if (location.reliability === 'low') parts.push('not counted toward protection');
    return parts.filter(Boolean).join(' · ') || 'Backup storage';
  }

  function representationSelect(location, mediaType, mode) {
    if (location.kind !== 'backup') return '';
    const locationId = `backup:${location.id}`;
    const current = mode(locationId, mediaType);
    // compact-only remains intentionally available because the existing storage
    // reconciler performs verified safe-removal checks before dropping Originals.
    return `<label>${mediaType === 'image' ? 'Images' : 'Video'}<select data-representation data-location-id="${esc(locationId)}" data-location-name="${esc(location.name)}" data-media="${mediaType}"><option value="original" ${current === 'original' ? 'selected' : ''}>Original</option><option value="compact" ${current === 'compact' ? 'selected' : ''}>Original + Squished</option><option value="compact-only" ${current === 'compact-only' ? 'selected' : ''}>Squished only</option></select></label>`;
  }

  function destinationRows() {
    const mode = modeMap(model?.storage);
    const locations = (model?.state?.locations || []).filter(location => ['primary','backup','peer'].includes(location.kind));
    if (!locations.length) return '<div class="backup-empty">No backup destinations yet.</div>';
    return locations.map(location => {
      const relied = location.reliability !== 'low';
      const controls = location.kind === 'primary'
        ? '<span></span>'
        : `<div class="backup-destination-controls">${representationSelect(location,'image',mode)}${representationSelect(location,'video',mode)}<button class="backup-rely ${relied ? '' : 'off'}" type="button" data-rely="${esc(location.id)}" data-relied="${relied ? '1' : '0'}">${relied ? 'Counts toward protection' : 'Do not rely on'}</button></div>`;
      return `<div class="backup-destination-row"><div class="backup-row-copy"><strong>${esc(location.kind === 'primary' ? 'Cloud' : location.name)}</strong><small>${esc(destinationStatus(location))}</small></div>${controls}</div>`;
    }).join('');
  }

  function sourceRows() {
    const folders = (model?.state?.folders || []).filter(folder => folder.protected !== false && Number(folder.importId) > 0);
    if (!folders.length) return '<div class="backup-empty">Cloud folders inherit Standard protection.</div>';
    return folders.map(folder => {
      const level = ruleFor(folder.importId);
      return `<div class="backup-source-row" data-import-id="${Number(folder.importId)}"><div class="backup-row-copy"><strong>${esc(baseName(folder.path) || folder.path || `Folder ${folder.importId}`)}</strong><small>${esc(folder.path || '')}</small></div><select data-folder-plan>${planOptions(level)}</select></div>`;
    }).join('');
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'small-dialog backup-center-dialog';
    document.body.append(dialog);
    return dialog;
  }

  function renderDialog() {
    const box = ensureDialog();
    const summary = model?.state?.summary;
    const background = model?.state?.config?.background || 'low';
    box.innerHTML = `
      <div class="dialog-head"><h3>Backup</h3><button class="icon" data-close>×</button></div>
      <div class="backup-settings">
        <section class="backup-settings-section">
          <header><h4>Protection</h4><span>Set intent. Mochimono decides which allowed destination should fill each missing copy.</span></header>
          <div class="backup-plan-list">${PLAN_ORDER.map(level => { const bucket = summary?.levels?.[level] || {}; return `<div class="backup-plan-row"><strong>${esc(PLANS[level].name)}<b>${Number(bucket.files || 0).toLocaleString()} files</b></strong><p>${esc(PLANS[level].detail)}</p></div>`; }).join('')}</div>
        </section>
        <section class="backup-settings-section">
          <header><h4>Folders</h4><span>Files can override this individually in Library details.</span></header>
          <div class="backup-source-list">${sourceRows()}</div>
        </section>
        <section class="backup-settings-section">
          <header><h4>Destinations</h4><span>Where Mochimono may place recovery copies.</span></header>
          <div class="backup-destination-list">${destinationRows()}</div>
          <div class="backup-safety-note"><strong>Cloud-only is an availability choice, not a protection level.</strong> Mochimono should remove a local source only when the copies that remain still satisfy that file's protection target. Squished-only storage is kept separate from this choice.</div>
        </section>
        <section class="backup-settings-section">
          <header><h4>Automatic work</h4></header>
          <div class="backup-background"><div><strong>Background protection</strong><small>Check for missing copies and fill them automatically.</small></div><select data-background><option value="low">Low impact</option><option value="normal">Normal</option><option value="paused">Paused</option></select></div>
        </section>
      </div>`;
    box.querySelector('[data-background]').value = background;
    box.querySelector('[data-close]').onclick = () => box.close();
    box.querySelectorAll('[data-folder-plan]').forEach(select => select.addEventListener('change', updateFolderPlan));
    box.querySelectorAll('[data-rely]').forEach(button => button.addEventListener('click', toggleReliance));
    box.querySelectorAll('[data-representation]').forEach(select => select.addEventListener('change', updateRepresentation));
    box.querySelector('[data-background]').addEventListener('change', updateBackground);
  }

  async function updateFolderPlan(event) {
    const select = event.currentTarget;
    const importId = Number(select.closest('[data-import-id]')?.dataset.importId) || 0;
    if (!importId) return;
    select.disabled = true;
    try {
      await control('/api/client/protection/folder-level', { method:'POST', body:{ importId, level:select.value } });
      toast('Protection updated');
      await refresh(true);
      renderDialog();
    } catch (error) { toast(error.message); }
    finally { select.disabled = false; }
  }

  async function toggleReliance(event) {
    const button = event.currentTarget;
    const id = button.dataset.rely;
    const relied = button.dataset.relied === '1';
    button.disabled = true;
    try {
      await control('/api/client/protection/location', { method:'POST', body:{ id, reliability:relied ? 'low' : 'normal' } });
      toast(relied ? 'Mochimono will not rely on this storage' : 'Storage can now protect files');
      await refresh(true);
      renderDialog();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }

  async function updateRepresentation(event) {
    const select = event.currentTarget;
    const next = select.value;
    const locationId = select.dataset.locationId;
    const mediaType = select.dataset.media;
    const previous = modeMap(model?.storage)(locationId, mediaType);
    if (next === 'compact-only') {
      const okay = confirm(`Use Squished only for ${mediaType === 'image' ? 'images' : 'video'} on ${select.dataset.locationName}?\n\nMochimono will create and verify the Squished copy first. It only removes an Original from this backup when another verified Original exists elsewhere.`);
      if (!okay) { select.value = previous; return; }
    }
    select.disabled = true;
    try {
      if (next === 'compact-only') {
        await server('/api/compression/storage-policy', { method:'POST', body:{ locationId, mediaType, representation:'compact' } });
        await server('/api/compression/retention', { method:'POST', body:{ locationId, mediaType, allowOriginalRemoval:true, confirmation:'compact-only' } });
      } else {
        await server('/api/compression/storage-policy', { method:'POST', body:{ locationId, mediaType, representation:next } });
        if (next === 'compact') await server('/api/compression/retention', { method:'POST', body:{ locationId, mediaType, allowOriginalRemoval:false } });
      }
      toast('Storage format updated');
      await refresh(true);
      renderDialog();
    } catch (error) {
      toast(error.message);
      select.value = previous;
    } finally { select.disabled = false; }
  }

  async function updateBackground(event) {
    const select = event.currentTarget;
    select.disabled = true;
    try {
      await control('/api/client/protection/settings', { method:'POST', body:{ background:select.value } });
      await refresh(true);
    } catch (error) { toast(error.message); }
    finally { select.disabled = false; }
  }

  async function protectNow() {
    const button = section.querySelector('[data-protect-now]');
    if (button) button.disabled = true;
    try {
      await control('/api/client/protection/run', { method:'POST', body:{} });
      toast('Protection started');
      setTimeout(() => refresh(true), 180);
    } catch (error) { toast(error.message); if (button) button.disabled = false; }
  }

  async function openManage() {
    if (!model) await refresh(true);
    renderDialog();
    if (!dialog.open) dialog.showModal();
  }

  async function refresh(force = false) {
    clearTimeout(timer);
    timer = 0;
    if (busy || (!force && (document.hidden || storagePane.hidden))) return schedule(2500);
    busy = true;
    try {
      const [stateResult, drivesResult, storageResult] = await Promise.allSettled([
        control('/api/client/protection/state'),
        server('/api/drives'),
        server('/api/compression/storage-snapshot')
      ]);
      if (stateResult.status !== 'fulfilled') throw stateResult.reason;
      model = {
        state:stateResult.value,
        drives:drivesResult.status === 'fulfilled' ? drivesResult.value.drives || [] : [],
        storage:storageResult.status === 'fulfilled' ? storageResult.value : { policies:[], retention:[] }
      };
      renderMain();
      if (dialog?.open) renderDialog();
      placeSection();
    } catch (error) {
      const body = section.querySelector('[data-backup-body]');
      body.className = 'error';
      body.textContent = error.message;
    } finally {
      busy = false;
      schedule(5000);
    }
  }

  function schedule(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(false), Math.max(0, delay));
  }

  section.querySelector('[data-backup-manage]').addEventListener('click', openManage);
  const menuButton = document.querySelector('#clientProtection');
  if (menuButton) {
    menuButton.querySelector('.menu-label')?.replaceChildren(document.createTextNode('Backup'));
    menuButton.onclick = event => { event.preventDefault(); openManage(); };
  }

  const observer = new MutationObserver(() => {
    document.querySelector('#protectionDashboard')?.setAttribute('hidden','');
    placeSection();
  });
  observer.observe(storagePane, { childList:true });
  window.addEventListener('mochimono:protection-changed', () => refresh(true));
  window.addEventListener('focus', () => schedule(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  schedule(100);
}