const selectionBar = document.querySelector('#selectionBar');
const selectionSpacer = selectionBar?.querySelector('.selection-spacer');
const fileCount = document.querySelector('#fileCount');

if (selectionBar && fileCount) {
  const style = document.createElement('style');
  style.textContent = `
.compression-work-button{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 9px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:#211f20;color:#c9c2be;font-size:11px;font-weight:700;white-space:nowrap}
.compression-work-button:hover{background:#2d2a2c;color:#fff}.compression-work-button b{display:inline-flex;min-width:17px;height:17px;padding:0 5px;align-items:center;justify-content:center;border-radius:999px;background:#eee9e5;color:#171416;font-size:9px}
.selection-compress{min-width:auto!important;width:auto!important;padding:0 9px!important;font-size:11px!important;font-weight:750!important}
.compression-overlay[hidden]{display:none!important}.compression-overlay{position:fixed;z-index:1600;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.compression-dialog{width:min(540px,calc(100vw - 28px));max-height:min(720px,calc(100dvh - 28px));overflow:auto;border:1px solid rgba(255,255,255,.1);border-radius:15px;background:#151415;color:#eee;box-shadow:0 24px 80px rgba(0,0,0,.55)}
.compression-dialog-head{position:sticky;z-index:2;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 15px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(21,20,21,.97)}
.compression-dialog-head strong{font-size:15px}.compression-dialog-close{width:30px;height:30px;padding:0;border:0;border-radius:50%;background:transparent;color:#948c88;font-size:22px;line-height:1}.compression-dialog-close:hover{background:#ffffff0d;color:#fff}
.compression-dialog-body{padding:14px 15px}.compression-field{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;gap:10px;margin:8px 0}.compression-field>span{color:#a49c98;font-size:11px;font-weight:700}.compression-field select{width:100%;height:34px;border:1px solid rgba(255,255,255,.09);border-radius:8px;background:#242223;color:#eee;padding:0 9px;font:600 11px/1 inherit}
.compression-dialog-actions{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:14px}.compression-dialog-actions button{min-height:36px;padding:0 13px;border:0;border-radius:9px;font-size:11px;font-weight:750}.compression-primary{background:#eee9e5;color:#171416}.compression-secondary{background:#2a2829;color:#d2cbc7}
.compression-work-summary{color:#918986;font-size:11px;margin-bottom:10px}.compression-work-list{display:grid;gap:7px}.compression-work-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:9px 10px;border-radius:9px;background:#ffffff08}.compression-work-main{min-width:0}.compression-work-main strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}.compression-work-meta{margin-top:3px;color:#8e8783;font-size:9.5px;line-height:1.35}.compression-work-progress{height:3px;margin-top:7px;overflow:hidden;border-radius:99px;background:#ffffff12}.compression-work-progress i{display:block;height:100%;background:#ded8d4}.compression-work-item-actions{display:flex;gap:4px;align-self:center}.compression-work-cancel,.compression-work-retry{min-height:28px;padding:0 8px;border:0;border-radius:7px;background:#2a2829;color:#bbb3af;font-size:9.5px;font-weight:700}.compression-work-retry{background:#eee9e5;color:#171416}.compression-work-section{margin-top:15px}.compression-work-section:first-child{margin-top:0}.compression-work-section h3{margin:0 0 7px;color:#aaa29e;font-size:10px;text-transform:uppercase;letter-spacing:.07em}.compression-work-error .compression-work-meta{color:#c89491}.compression-empty{padding:20px 0;color:#77706d;text-align:center;font-size:11px}
@media(max-width:700px){.compression-overlay{padding:8px}.compression-dialog{width:100%;max-height:calc(100dvh - 16px)}.compression-field{grid-template-columns:1fr;gap:5px}.compression-work-button{padding:0 7px}.compression-work-button>span{display:none}}
`;
  document.head.append(style);

  const workButton = document.createElement('button');
  workButton.type = 'button';
  workButton.className = 'compression-work-button';
  workButton.innerHTML = '<span>Work</span><b data-work-count hidden>0</b>';
  fileCount.after(workButton);

  const selectionCompress = document.createElement('button');
  selectionCompress.type = 'button';
  selectionCompress.className = 'selection-compress';
  selectionCompress.textContent = 'Compress';
  selectionCompress.title = 'Compress selected files';
  selectionSpacer?.before(selectionCompress);

  const overlay = document.createElement('div');
  overlay.className = 'compression-overlay';
  overlay.hidden = true;
  overlay.innerHTML = '<div class="compression-dialog" role="dialog" aria-modal="true"></div>';
  document.body.append(overlay);
  const dialog = overlay.querySelector('.compression-dialog');
  const badge = workButton.querySelector('[data-work-count]');
  let mode = '';
  let poll = 0;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const bytes = value => {
    const units = ['B','KB','MB','GB','TB'];
    let amount = Math.max(0, Number(value) || 0);
    let unit = 0;
    while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
    return `${amount < 10 && unit ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
  };

  async function api(path, options = {}) {
    const response = await fetch(path, { headers:{ 'content-type':'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function close() {
    overlay.hidden = true;
    mode = '';
    if (poll) clearTimeout(poll);
    poll = 0;
  }

  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) close(); });

  async function presets() {
    return (await api('/api/compression/presets')).presets || [];
  }

  function presetOptions(items) {
    const groups = ['image','video'].map(type => {
      const list = items.filter(item => item.mediaType === type);
      if (!list.length) return '';
      return `<optgroup label="${type === 'image' ? 'Images' : 'Video'}">${list.map(item => `<option value="${escapeHtml(item.id)}">${item.isDefault ? '★ ' : ''}${escapeHtml(item.name)}</option>`).join('')}</optgroup>`;
    }).join('');
    return `<option value="">Default for each type</option>${groups}`;
  }

  async function openBulk() {
    const hashes = window.mochimonoSelection?.hashes?.() || [];
    if (!hashes.length) return;
    mode = 'bulk';
    const items = await presets();
    dialog.innerHTML = `
      <div class="compression-dialog-head"><strong>Compress ${hashes.length.toLocaleString()} file${hashes.length === 1 ? '' : 's'}</strong><button class="compression-dialog-close" data-close>×</button></div>
      <div class="compression-dialog-body">
        <div class="compression-field"><span>Preset</span><select data-bulk-preset>${presetOptions(items)}</select></div>
        <div class="compression-work-summary">Creates managed Compact renditions. Originals stay untouched.</div>
        <div class="compression-dialog-actions"><button class="compression-secondary" data-close>Cancel</button><button class="compression-primary" data-queue>Add to queue</button></div>
      </div>`;
    overlay.hidden = false;
    dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
    dialog.querySelector('[data-queue]').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Adding…';
      try {
        const result = await api('/api/work/enqueue', { method:'POST', body:JSON.stringify({ hashes, presetId:dialog.querySelector('[data-bulk-preset]').value }) });
        window.mochimonoSelection?.clear?.();
        close();
        window.dispatchEvent(new CustomEvent('mochimono:work-changed', { detail:result }));
        await refreshBadge();
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Add to queue';
        alert(error.message);
      }
    });
  }

  function section(title, jobs) {
    if (!jobs.length) return '';
    return `<section class="compression-work-section"><h3>${title}</h3><div class="compression-work-list">${jobs.map(job => {
      const managed = job.kind === 'placement';
      const active = job.status === 'running' || job.status === 'queued';
      const retryable = !managed && (job.status === 'error' || job.status === 'canceled');
      const result = job.result || {};
      const meta = job.status === 'done'
        ? `${job.presetName || (managed ? 'Storage' : 'Compact')}${result.sourceSize && result.size ? ` · ${bytes(result.sourceSize)} → ${bytes(result.size)}` : ''}`
        : job.message || job.presetName || '';
      return `<article class="compression-work-item ${job.status === 'error' ? 'compression-work-error' : ''}">
        <div class="compression-work-main"><strong>${escapeHtml(job.filename || job.originalHash.slice(0,12))}</strong><div class="compression-work-meta">${escapeHtml(meta)}</div>${active ? `<div class="compression-work-progress"><i style="width:${Math.max(2, Math.min(100, Number(job.progress) || 0))}%"></i></div>` : ''}</div>
        <div class="compression-work-item-actions">${active && !managed ? `<button class="compression-work-cancel" data-cancel="${escapeHtml(job.id)}">Cancel</button>` : ''}${retryable ? `<button class="compression-work-retry" data-retry="${escapeHtml(job.id)}">Retry</button>` : ''}</div>
      </article>`;
    }).join('')}</div></section>`;
  }

  async function retryJob(job) {
    return api('/api/work/enqueue', {
      method:'POST',
      body:JSON.stringify({ hashes:[job.originalHash], mediaType:job.mediaType, options:job.options || {}, presetId:job.presetId || '', presetName:job.presetName || 'Custom' })
    });
  }

  async function renderWork() {
    if (mode !== 'work') return;
    const data = await api('/api/work');
    const jobs = data.jobs || [];
    const running = jobs.filter(job => job.status === 'running');
    const queued = jobs.filter(job => job.status === 'queued');
    const completed = jobs.filter(job => job.status === 'done');
    const failed = jobs.filter(job => job.status === 'error' || job.status === 'canceled');
    const retryableFailed = failed.filter(job => job.kind !== 'placement');
    dialog.innerHTML = `
      <div class="compression-dialog-head"><strong>Work</strong><button class="compression-dialog-close" data-close>×</button></div>
      <div class="compression-dialog-body">
        <div class="compression-work-summary">${running.length ? `${running.length} processing · ` : ''}${queued.length} queued</div>
        ${section('Processing', running)}${section('Pending', queued)}${section('Completed', completed)}${section('Failed / canceled', failed)}
        ${jobs.length ? `<div class="compression-dialog-actions">${queued.length ? '<button class="compression-secondary" data-cancel-pending>Cancel pending</button>' : ''}${retryableFailed.length ? '<button class="compression-secondary" data-retry-failed>Retry failed</button>' : ''}<button class="compression-secondary" data-clear>Clear finished</button></div>` : '<div class="compression-empty">No work yet.</div>'}
      </div>`;
    dialog.querySelector('[data-close]')?.addEventListener('click', close);
    dialog.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      await api(`/api/work/${encodeURIComponent(button.dataset.cancel)}/cancel`, { method:'POST', body:'{}' }).catch(error => alert(error.message));
      window.dispatchEvent(new CustomEvent('mochimono:work-changed'));
      renderWork().catch(() => {});
    }));
    dialog.querySelectorAll('[data-retry]').forEach(button => button.addEventListener('click', async () => {
      const job = jobs.find(item => item.id === button.dataset.retry);
      if (!job) return;
      button.disabled = true;
      await retryJob(job).catch(error => alert(error.message));
      window.dispatchEvent(new CustomEvent('mochimono:work-changed'));
      renderWork().catch(() => {});
    }));
    dialog.querySelector('[data-cancel-pending]')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      await Promise.allSettled(queued.filter(job => job.kind !== 'placement').map(job => api(`/api/work/${encodeURIComponent(job.id)}/cancel`, { method:'POST', body:'{}' })));
      window.dispatchEvent(new CustomEvent('mochimono:work-changed'));
      renderWork().catch(() => {});
    });
    dialog.querySelector('[data-retry-failed]')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      for (const job of retryableFailed) await retryJob(job).catch(() => {});
      window.dispatchEvent(new CustomEvent('mochimono:work-changed'));
      renderWork().catch(() => {});
    });
    dialog.querySelector('[data-clear]')?.addEventListener('click', async () => {
      await api('/api/work/clear-completed', { method:'POST', body:'{}' });
      renderWork().catch(() => {});
    });
    await refreshBadge(data);
    if (running.length || queued.length) poll = setTimeout(() => renderWork().catch(() => {}), 800);
  }

  async function openWork() {
    mode = 'work';
    overlay.hidden = false;
    dialog.innerHTML = '<div class="compression-dialog-body"><div class="compression-empty">Loading…</div></div>';
    await renderWork();
  }

  async function refreshBadge(existing = null) {
    const data = existing || await api('/api/work').catch(() => null);
    if (!data) return;
    const count = Number(data.active || 0) + Number(data.queued || 0);
    badge.hidden = !count;
    badge.textContent = String(count);
  }

  selectionCompress.addEventListener('click', () => openBulk().catch(error => alert(error.message)));
  workButton.addEventListener('click', () => openWork().catch(error => alert(error.message)));
  window.addEventListener('mochimono:work-changed', () => refreshBadge().catch(() => {}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadge().catch(() => {}); });
  refreshBadge().catch(() => {});

  window.mochimonoCompressionWork = { open:openWork, refresh:refreshBadge };
}