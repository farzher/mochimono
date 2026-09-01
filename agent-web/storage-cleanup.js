const pane = document.querySelector('#storagePane');

if (pane) {
  const style = document.createElement('style');
  style.textContent = `
    #folders .empty-state,#backups .empty-state{display:none!important}
    #storagePane.storage-v2 .storage-status-card{grid-template-rows:1fr!important;align-items:center!important}
    #storagePane.storage-v2 .storage-status-main{display:none!important}
    #storagePane.storage-v2 .storage-route{grid-template-columns:repeat(3,minmax(0,1fr))!important}
    #storagePane.storage-v2 .storage-route-line{display:none!important}
    #storagePane.storage-v2 .storage-route-node b{display:none!important}
    #storagePane.storage-v2 .storage-file-check.empty{
      border-color:#343038!important;
      background:#19171a!important;
      color:#777071!important;
    }
    #storagePane.storage-v2 .storage-file-check.empty strong{font-size:18px!important;font-weight:700!important;color:#918986!important}
    #storagePane.storage-v2 .storage-file-check.empty small{display:none!important}
  `;
  document.head.append(style);

  let emptyCloudFiles = false;
  let checkingCloudFiles = false;
  let lastCloudCheck = 0;
  let frame = 0;

  function simplifyStatusCard() {
    pane.querySelector('.storage-status-main')?.remove();
    const names = { local: 'This PC', cloud: 'Cloud', backup: 'Local backup' };
    for (const [route, name] of Object.entries(names)) {
      const node = pane.querySelector(`[data-route="${route}"]`);
      if (!node) continue;
      node.querySelector('b')?.remove();
      node.title = name;
      node.setAttribute('aria-label', name);
    }
  }

  function renderCloudFiles() {
    const check = pane.querySelector('[data-metric="files"] .storage-file-check');
    if (!check) return;
    check.classList.toggle('empty', emptyCloudFiles);
    if (!emptyCloudFiles) return;
    check.classList.remove('warn', 'bad');
    const value = check.querySelector('strong');
    const detail = check.querySelector('small');
    if (value && value.textContent !== 'None') value.textContent = 'None';
    if (detail && detail.textContent) detail.textContent = '';
  }

  async function refreshCloudFiles(force = false) {
    if (checkingCloudFiles || (!force && Date.now() - lastCloudCheck < 2000)) return;
    checkingCloudFiles = true;
    try {
      const response = await fetch('/api/integrity', { cache: 'no-store' });
      if (!response.ok) return;
      const info = await response.json();
      emptyCloudFiles = (Number(info.total) || 0) === 0;
      lastCloudCheck = Date.now();
      renderCloudFiles();
    } catch {} finally {
      checkingCloudFiles = false;
    }
  }

  function sync() {
    simplifyStatusCard();
    renderCloudFiles();
    refreshCloudFiles();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  }

  new MutationObserver(schedule).observe(pane, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => refreshCloudFiles(true), { passive: true });
  sync();
}