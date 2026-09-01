const pane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const backups = document.querySelector('#backups');
const folderAdd = document.querySelector('#folderAdd');
const backupAdd = document.querySelector('#backupAdd');
const showFolderAdd = document.querySelector('#showFolderAdd');
const showBackupAdd = document.querySelector('#showBackupAdd');
const serverStorageText = document.querySelector('#serverStorageText');

if (pane) {
  pane.classList.add('storage-v3-minimal');

  const style = document.createElement('style');
  style.textContent = `
    /* Visual first. Keep location and freshness; suppress routine prose. */
    #storagePane.storage-v3-minimal .storage-v2-kicker{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-state-copy span{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-safety.bad .storage-v2-state-copy span{display:block!important;max-width:310px;font-size:10px!important;line-height:1.35!important}
    #storagePane.storage-v3-minimal .storage-v2-state{margin-top:0!important}
    #storagePane.storage-v3-minimal .storage-v2-safety{min-height:184px!important;padding:23px!important}

    #storagePane.storage-v3-minimal .storage-v2-route-step small{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-route-step{gap:5px!important}
    #storagePane.storage-v3-minimal .storage-v2-route-step b{font-size:9px!important;color:#918986!important}

    #storagePane.storage-v3-minimal .storage-v2-metric{min-height:184px!important;padding:17px!important}
    #storagePane.storage-v3-minimal .storage-v2-metric>span{font-size:10px!important;color:#817976!important}
    #storagePane.storage-v3-minimal .storage-v2-ring small{font-size:8px!important;color:#77706d!important}
    #storagePane.storage-v3-minimal .storage-v3-storage-check .storage-v2-ring{
      width:100px!important;height:100px!important;
      border:1px solid #344b3a!important;
      border-radius:28px!important;
      background:#18231b!important;
      box-shadow:none!important;
    }
    #storagePane.storage-v3-minimal .storage-v3-storage-check .storage-v2-ring::before{display:none!important}
    #storagePane.storage-v3-minimal .storage-v3-storage-check .storage-v2-ring strong{font-size:30px!important;color:#91cc9f!important}
    #storagePane.storage-v3-minimal .storage-v3-storage-check.warn .storage-v2-ring{border-color:#58492f!important;background:#241f17!important}
    #storagePane.storage-v3-minimal .storage-v3-storage-check.warn .storage-v2-ring strong{color:#d8b573!important}
    #storagePane.storage-v3-minimal .storage-v3-storage-check.bad .storage-v2-ring{border-color:#5c3335!important;background:#2a181a!important}
    #storagePane.storage-v3-minimal .storage-v3-storage-check.bad .storage-v2-ring strong{color:#e58f89!important}

    #storagePane.storage-v3-minimal .storage-v2-folder-facts{gap:20px!important}
    #storagePane.storage-v3-minimal .storage-v2-folder-fact span{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-folder-fact:nth-child(2) strong::after{content:' files';font-size:10px;font-weight:650;color:#77706d;letter-spacing:0}
    #storagePane.storage-v3-minimal .storage-v2-folder-node small{display:block!important;margin-top:2px!important;color:#6e6765!important;font-size:8px!important}
    #storagePane.storage-v3-minimal .storage-v2-folder-node b{font-size:9px!important;color:#918986!important}
    #storagePane.storage-v3-minimal .folder-item{min-height:290px!important}

    #storagePane.storage-v3-minimal .storage-v2-backup-number span{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-backup-facts{margin-top:7px!important}
    #storagePane.storage-v3-minimal .storage-v2-backup-facts span:last-child{font-size:8px!important;color:#6e6765!important}
    #storagePane.storage-v3-minimal #backups>.backup-item{min-height:225px!important}

    /* Add is a visible empty slot in the content grid. */
    #storagePane.storage-v3-minimal #showFolderAdd,
    #storagePane.storage-v3-minimal #showBackupAdd{display:none!important}

    .storage-v3-add-slot{
      width:calc(50% - 7px);
      min-height:132px;
      display:grid;
      place-items:center;
      gap:9px;
      margin-top:14px;
      padding:20px;
      border:1px dashed #39343a;
      border-radius:20px;
      background:#100f11;
      color:#716a68;
      cursor:pointer;
      transition:background .14s ease,border-color .14s ease,color .14s ease,transform .14s ease;
    }
    .storage-v3-add-slot:hover,.storage-v3-add-slot:focus-visible{
      background:#161417;
      border-color:#5a5057;
      color:#b8afab;
      transform:translateY(-1px);
      outline:none;
    }
    .storage-v3-add-slot svg{
      width:44px;height:44px;
      fill:none;stroke:currentColor;stroke-width:1.25;
      stroke-linecap:round;stroke-linejoin:round;
      opacity:.8;
    }
    .storage-v3-add-slot strong{font-size:11px;font-weight:680;color:inherit;letter-spacing:-.01em}
    .storage-v3-add-slot .storage-v3-plus{
      position:absolute;
      width:20px;height:20px;
      display:grid;place-items:center;
      margin:23px 0 0 34px;
      border:2px solid #100f11;
      border-radius:50%;
      background:#2a262b;
      color:#b9b0ac;
      font-size:14px;font-weight:600;line-height:1;
    }
    .storage-v3-add-icon{position:relative;display:grid;place-items:center}

    #storagePane.storage-v3-minimal .folder-add,
    #storagePane.storage-v3-minimal .inline-add{
      width:100%!important;
      margin-top:10px!important;
      border-radius:18px!important;
      background:#131114!important;
    }
    #storagePane.storage-v3-minimal .folder-mode-note{display:none!important}
    #storagePane.storage-v3-minimal .folder-mode-option span{display:none!important}

    @media(max-width:980px){.storage-v3-add-slot{width:100%}}
    @media(max-width:650px){
      #storagePane.storage-v3-minimal .storage-v2-safety{min-height:164px!important}
      .storage-v3-add-slot{min-height:112px;border-radius:17px}
      .storage-v3-add-slot svg{width:38px;height:38px}
    }
  `;
  document.head.append(style);

  function addSlot(kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `storage-v3-add-slot storage-v3-add-${kind}`;
    if (kind === 'folder') {
      button.setAttribute('aria-label', 'Add folder');
      button.innerHTML = `<span class="storage-v3-add-icon"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5.5 13.5h13l4-5h8l3.4 5h8.6v25H5.5z"/></svg><span class="storage-v3-plus">+</span></span><strong>Add folder</strong>`;
    } else {
      button.setAttribute('aria-label', 'Add backup');
      button.innerHTML = `<span class="storage-v3-add-icon"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 11.5h32v25H8z"/><path d="M8 29h32M33.5 33h.01M28.5 33h.01"/></svg><span class="storage-v3-plus">+</span></span><strong>Add backup</strong>`;
    }
    return button;
  }

  if (folders && folderAdd) {
    const slot = addSlot('folder');
    folders.after(slot);
    slot.after(folderAdd);
    slot.addEventListener('click', () => showFolderAdd?.click());
  }

  if (backups && backupAdd) {
    const slot = addSlot('backup');
    backups.after(slot);
    slot.after(backupAdd);
    slot.addEventListener('click', () => showBackupAdd?.click());
  }

  function tidyHero() {
    const state = pane.querySelector('.storage-v2-state-copy strong');
    if (state?.textContent.trim() === 'Protected') state.textContent = 'All good';
    if (state?.textContent.trim() === 'Add a backup') state.textContent = 'Backup needed';

    const metrics = [...pane.querySelectorAll('.storage-v2-metric')];
    const cloud = metrics.find(item => item.querySelector(':scope > span')?.textContent === 'Cloud space' || item.querySelector(':scope > span')?.textContent === 'Server storage');
    if (cloud) {
      const label = cloud.querySelector(':scope > span');
      const value = cloud.querySelector('.storage-v2-ring strong');
      const sub = cloud.querySelector('.storage-v2-ring small');
      if (label) label.textContent = 'Server storage';
      const disk = serverStorageText?.textContent?.trim();
      if (disk) {
        const [used, total] = disk.split('/').map(part => part.trim());
        if (value && used) value.textContent = used;
        if (sub && total) sub.textContent = `/ ${total}`;
      }
    }

    const integrity = metrics.find(item => item.querySelector(':scope > span')?.textContent === 'Integrity' || item.querySelector(':scope > span')?.textContent === 'Mochimono files');
    if (integrity) {
      integrity.classList.add('storage-v3-storage-check');
      integrity.classList.toggle('warn', integrity.querySelector('.storage-v2-ring')?.classList.contains('warn'));
      integrity.classList.toggle('bad', integrity.querySelector('.storage-v2-ring')?.classList.contains('bad'));
      const label = integrity.querySelector(':scope > span');
      if (label) label.textContent = 'Mochimono files';
      const value = integrity.querySelector('.storage-v2-ring strong');
      if (value?.textContent.trim() === '100%') value.textContent = '✓';
    }
  }

  function tidyFolders() {
    for (const row of folders?.querySelectorAll('[data-folder-path]') || []) {
      const nodes = row.querySelectorAll('.storage-v2-folder-node');
      for (const node of nodes) {
        const small = node.querySelector('small');
        if (!small) continue;
        let text = small.textContent.trim();
        text = text.replace(/^(Indexed|Synced)\s+/i, '');
        if (/^(Available|Not uploaded)$/i.test(text)) text = '';
        small.textContent = text;
        small.hidden = !text;
      }
    }
  }

  function tidy() {
    tidyHero();
    tidyFolders();
  }

  let frame = 0;
  const scheduleTidy = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      tidy();
    });
  };
  new MutationObserver(scheduleTidy).observe(pane, { childList:true, subtree:true, characterData:true });
  if (serverStorageText) new MutationObserver(scheduleTidy).observe(serverStorageText, { childList:true, subtree:true, characterData:true });
  tidy();
}
