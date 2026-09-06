const workButton = document.querySelector('.compression-work-button');

if (workButton) {
  const style = document.createElement('style');
  style.textContent = `
.compression-storage-button{display:inline-flex;align-items:center;min-height:32px;padding:0 9px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:#211f20;color:#c9c2be;font-size:11px;font-weight:700;white-space:nowrap}.compression-storage-button:hover{background:#2d2a2c;color:#fff}
.compression-storage-overlay[hidden]{display:none!important}.compression-storage-overlay{position:fixed;z-index:1601;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.compression-storage-dialog{width:min(680px,calc(100vw - 28px));max-height:min(760px,calc(100dvh - 28px));overflow:auto;border:1px solid rgba(255,255,255,.1);border-radius:15px;background:#151415;color:#eee;box-shadow:0 24px 80px rgba(0,0,0,.55)}
.compression-storage-head{position:sticky;z-index:2;top:0;display:flex;align-items:center;justify-content:space-between;padding:14px 15px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(21,20,21,.97)}.compression-storage-head strong{font-size:15px}.compression-storage-close{width:30px;height:30px;padding:0;border:0;border-radius:50%;background:transparent;color:#948c88;font-size:22px}.compression-storage-close:hover{background:#ffffff0d;color:#fff}
.compression-storage-body{padding:14px 15px}.compression-storage-grid{display:grid;grid-template-columns:minmax(150px,1fr) 118px 118px;gap:6px;align-items:center}.compression-storage-grid>div{min-width:0;padding:8px 9px;border-radius:8px;background:#ffffff07}.compression-storage-grid .compression-storage-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.compression-storage-grid .compression-storage-label strong{display:block;font-size:11px}.compression-storage-grid .compression-storage-label span{display:block;margin-top:2px;color:#817a77;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.compression-storage-grid select{width:100%;height:31px;border:1px solid rgba(255,255,255,.08);border-radius:7px;background:#242223;color:#ddd;padding:0 7px;font:700 10px/1 inherit}.compression-storage-column{padding:0 5px!important;background:transparent!important;color:#817a77;font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.06em}.compression-storage-summary{margin:0 0 11px;color:#918986;font-size:10.5px}.compression-storage-state{margin-top:12px;color:#827b78;font-size:9.5px}.compression-storage-loading{padding:24px;color:#817a77;text-align:center;font-size:11px}
@media(max-width:700px){.compression-storage-button{padding:0 7px}.compression-storage-overlay{padding:8px}.compression-storage-dialog{width:100%;max-height:calc(100dvh - 16px)}.compression-storage-grid{grid-template-columns:minmax(110px,1fr) 92px 92px}.compression-storage-grid>div{padding:7px 6px}.compression-storage-grid select{padding:0 4px;font-size:9.5px}}
`;
  document.head.append(style);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'compression-storage-button';
  button.textContent = 'Storage';
  button.title = 'Choose Original or Compact by location';
  workButton.after(button);

  const overlay = document.createElement('div');
  overlay.className = 'compression-storage-overlay';
  overlay.hidden = true;
  overlay.innerHTML = '<div class="compression-storage-dialog" role="dialog" aria-modal="true"></div>';
  document.body.append(overlay);
  const dialog = overlay.querySelector('.compression-storage-dialog');

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

  async function api(path, options = {}) {
    const response = await fetch(path, { headers:{ 'content-type':'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function close() { overlay.hidden = true; }
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) close(); });

  function policyMap(items) {
    return new Map((items || []).map(item => [`${item.locationId}\0${item.mediaType}`, item.representation]));
  }

  function select(locationId, mediaType, current, fallback = 'original') {
    const value = current.get(`${locationId}\0${mediaType}`) || fallback;
    return `<select data-location="${escapeHtml(locationId)}" data-media="${mediaType}"><option value="original"${value === 'original' ? ' selected' : ''}>Original</option><option value="compact"${value === 'compact' ? ' selected' : ''}>Compact</option></select>`;
  }

  async function load() {
    const [local, backups, policies] = await Promise.all([
      api('/api/client/locations').catch(() => ({ locations:[] })),
      api('/api/backups').catch(() => ({ backups:[] })),
      api('/api/compression/policies').catch(() => ({ policies:[] }))
    ]);
    const current = policyMap(policies.policies);
    const locations = [{ id:'server', name:'Mochimono Server', detail:'Primary server', kind:'server' }];
    for (const item of local.locations || []) locations.push({ id:item.id, name:item.name || item.rootPath || 'Local folder', detail:item.rootPath || item.deviceName || '', kind:'local' });
    for (const item of backups.backups || []) {
      const id = item.meta?.id ? `backup:${item.meta.id}` : `backup-path:${item.path}`;
      locations.push({ id, name:item.meta?.name || 'Backup', detail:item.path || '', kind:'backup' });
    }
    const unique = [...new Map(locations.map(item => [item.id, item])).values()];
    dialog.innerHTML = `
      <div class="compression-storage-head"><strong>Storage</strong><button class="compression-storage-close" data-close>×</button></div>
      <div class="compression-storage-body">
        <div class="compression-storage-summary">Choose which representation each location should keep.</div>
        <div class="compression-storage-grid">
          <div class="compression-storage-column">Location</div><div class="compression-storage-column">Images</div><div class="compression-storage-column">Video</div>
          ${unique.map(item => `<div class="compression-storage-label"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.detail)}</span></div><div>${select(item.id,'image',current)}</div><div>${select(item.id,'video',current)}</div>`).join('')}
        </div>
        <div class="compression-storage-state">Originals are never removed unless another Original is known to exist.</div>
      </div>`;
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.querySelectorAll('select[data-location]').forEach(control => control.addEventListener('change', async () => {
      control.disabled = true;
      try {
        await api('/api/compression/policies', { method:'POST', body:JSON.stringify({ locationId:control.dataset.location, mediaType:control.dataset.media, representation:control.value }) });
        window.dispatchEvent(new CustomEvent('mochimono:compression-policy-changed', { detail:{ locationId:control.dataset.location, mediaType:control.dataset.media, representation:control.value } }));
      } catch (error) {
        alert(error.message);
        await load();
      } finally { control.disabled = false; }
    }));
  }

  button.addEventListener('click', async () => {
    overlay.hidden = false;
    dialog.innerHTML = '<div class="compression-storage-loading">Loading…</div>';
    try { await load(); }
    catch (error) { dialog.innerHTML = `<div class="compression-storage-loading">${escapeHtml(error.message)}</div>`; }
  });
}