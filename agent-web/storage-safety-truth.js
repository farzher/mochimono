const pane = document.querySelector('#storagePane');

if (pane) {
  const style = document.createElement('style');
  style.textContent = `
    #storagePane.storage-v2 .storage-v2-metric{grid-template-rows:auto 1fr!important}
    #storagePane.storage-v2 .storage-v2-metric>strong{display:none!important}
    #storagePane.storage-v2 .folder-item .storage-title strong{
      white-space:normal!important;
      overflow:hidden!important;
      display:-webkit-box!important;
      -webkit-box-orient:vertical!important;
      -webkit-line-clamp:2!important;
      overflow-wrap:anywhere!important;
    }
  `;
  document.head.append(style);

  const request = async path => {
    const response = await fetch(path, { cache:'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  };
  const percent = (value, total) => total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;

  function setState(status, detail, className, icon) {
    const safety = pane.querySelector('.storage-v2-safety');
    if (!safety) return;
    safety.className = `storage-v2-safety ${className || ''}`.trim();
    const stateIcon = safety.querySelector('.storage-v2-state-icon');
    const strong = safety.querySelector('.storage-v2-state-copy strong');
    const span = safety.querySelector('.storage-v2-state-copy span');
    if (stateIcon) stateIcon.textContent = icon;
    if (strong) strong.textContent = status;
    if (span) span.textContent = detail;
  }

  function setBackupRoute(mode, coverage) {
    const steps = pane.querySelectorAll('.storage-v2-route-step');
    const lines = pane.querySelectorAll('.storage-v2-route-line');
    const backup = steps[2];
    if (!backup) return;
    backup.classList.remove('active','partial');
    if (mode === 'active') backup.classList.add('active');
    if (mode === 'partial') backup.classList.add('partial');
    const small = backup.querySelector('small');
    if (small) small.textContent = coverage == null ? 'none' : `${Math.round(coverage)}%`;
    if (lines[1]) lines[1].style.setProperty('--active', mode === 'active' ? 1 : coverage ? coverage / 100 : 0);
  }

  function verificationCurrent(location) {
    const desired = Number(location.remote?.desiredBytes) || 0;
    const protectedBytes = Number(location.remote?.protectedBytes) || 0;
    if (desired && protectedBytes / desired < .995) return false;
    if (Number(location.meta?.lastVerifyBad) > 0 || location.meta?.lastVerifyCatalogHealthy === false) return false;
    const verifiedAt = new Date(location.meta?.lastVerifiedAt || location.local?.oldestVerification || 0).getTime();
    if (!Number.isFinite(verifiedAt) || !verifiedAt) return false;
    if (Date.now() - verifiedAt > 180 * 24 * 60 * 60 * 1000) return false;
    const updatedAt = new Date(location.meta?.lastBackupAt || 0).getTime();
    if (Number.isFinite(updatedAt) && updatedAt > verifiedAt) return false;
    return true;
  }

  let running = false;
  async function syncTruth() {
    if (running || pane.hidden) return;
    running = true;
    try {
      const [state, backupData, integrity] = await Promise.all([
        request('/api/state'),
        request('/api/backups'),
        request('/api/integrity')
      ]);
      const protectedFolders = (state.settings?.folders || []).filter(item => item.protected !== false);
      if (!protectedFolders.length) return;

      const backups = backupData.backups || [];
      const desired = backups.reduce((sum, item) => sum + (Number(item.remote?.desiredBytes) || 0), 0);
      const protectedBytes = backups.reduce((sum, item) => sum + (Number(item.remote?.protectedBytes) || 0), 0);
      const coverage = desired ? percent(protectedBytes, desired) : 0;
      const integrityBad = Number(integrity.bad) > 0 || integrity.catalog?.status === 'corrupt';
      const integrityKnown = Boolean(integrity.lastScrubAt);
      const currentVerified = Boolean(backups.length && backups.every(verificationCurrent));

      if (integrityBad) {
        setState('Needs attention','Primary storage integrity found a problem. Repair this before treating the cloud copy as healthy.','bad','!');
        setBackupRoute(currentVerified ? 'active' : coverage ? 'partial' : '', desired ? coverage : null);
      } else if (!state.server?.online) {
        setState('Cloud unavailable','Local files remain available, but Mochimono cannot currently confirm the cloud copy.','warn','!');
        setBackupRoute(currentVerified ? 'active' : coverage ? 'partial' : '', desired ? coverage : null);
      } else if (!backups.length) {
        setState('Add a backup','Your protected folders have a Mochimono copy, but no independent backup is configured yet.','warn','+');
        setBackupRoute('', null);
      } else if (desired && coverage < 99.5) {
        setState('Backup in progress',`${Math.round(coverage)}% of configured backup data is currently covered.`,'warn','↻');
        setBackupRoute(coverage ? 'partial' : '', coverage);
      } else if (!currentVerified) {
        setState('Verify backup','Backup coverage is complete, but the current backup contents have not all been freshly verified.','warn','✓');
        setBackupRoute('partial', desired ? coverage : 100);
      } else if (!integrityKnown) {
        setState('Check integrity','Backups are current and verified. Run the primary integrity check to complete the safety check.','warn','↻');
        setBackupRoute('active', desired ? coverage : 100);
      } else {
        setState('Protected','Cloud-synced data is covered by current verified backups and primary storage is healthy.','','✓');
        setBackupRoute('active', desired ? coverage : 100);
      }
    } catch {}
    finally { running = false; }
  }

  new MutationObserver(() => { if (!pane.hidden) setTimeout(syncTruth, 80); }).observe(pane, { attributes:true, attributeFilter:['hidden'] });
  setInterval(() => { if (!pane.hidden) syncTruth(); }, 6000);
  if (!pane.hidden) setTimeout(syncTruth, 120);
}
