const pane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const backups = document.querySelector('#backups');
const folderAdd = document.querySelector('#folderAdd');
const backupAdd = document.querySelector('#backupAdd');
const showFolderAdd = document.querySelector('#showFolderAdd');
const showBackupAdd = document.querySelector('#showBackupAdd');

if (pane) {
  pane.classList.add('storage-v3-minimal');

  const style = document.createElement('style');
  style.textContent = `
    /* Let the visuals carry the meaning. Routine explanatory copy stays quiet. */
    #storagePane.storage-v3-minimal .storage-v2-kicker{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-state-copy span{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-safety.warn .storage-v2-state-copy span,
    #storagePane.storage-v3-minimal .storage-v2-safety.bad .storage-v2-state-copy span{display:block!important;max-width:330px;font-size:10px!important;line-height:1.35!important}
    #storagePane.storage-v3-minimal .storage-v2-state{margin-top:0!important}
    #storagePane.storage-v3-minimal .storage-v2-safety{min-height:196px!important;padding:23px!important}

    #storagePane.storage-v3-minimal .storage-v2-route-step small{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-route-step{gap:5px!important}
    #storagePane.storage-v3-minimal .storage-v2-route-step b{font-size:9px!important;color:#918986!important}

    #storagePane.storage-v3-minimal .storage-v2-metric{min-height:196px!important;padding:17px!important}
    #storagePane.storage-v3-minimal .storage-v2-metric>span{font-size:10px!important;color:#817976!important}
    #storagePane.storage-v3-minimal .storage-v2-ring small{font-size:8px!important;color:#6d6664!important}

    #storagePane.storage-v3-minimal .storage-v2-folder-facts{gap:20px!important}
    #storagePane.storage-v3-minimal .storage-v2-folder-fact span{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-folder-fact:nth-child(2) strong::after{content:' files';font-size:10px;font-weight:650;color:#77706d;letter-spacing:0}
    #storagePane.storage-v3-minimal .storage-v2-folder-node small{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-folder-node b{font-size:9px!important;color:#918986!important}
    #storagePane.storage-v3-minimal .folder-item{min-height:290px!important}

    #storagePane.storage-v3-minimal .storage-v2-backup-number span{display:none!important}
    #storagePane.storage-v3-minimal .storage-v2-backup-facts{margin-top:7px!important}
    #storagePane.storage-v3-minimal .storage-v2-backup-facts span:last-child{display:none!important}
    #storagePane.storage-v3-minimal #backups>.backup-item{min-height:225px!important}

    /* The add affordance is an empty content slot, not a floating toolbar icon. */
    #storagePane.storage-v3-minimal #showFolderAdd,
    #storagePane.storage-v3-minimal #showBackupAdd{display:none!important}

    .storage-v3-add-slot{
      width:100%;
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
    .storage-v3-add-slot strong{font-size:12px;font-weight:680;color:inherit;letter-spacing:-.01em}
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
      margin-top:10px!important;
      border-radius:18px!important;
      background:#131114!important;
    }
    #storagePane.storage-v3-minimal .folder-mode-note{display:none!important}
    #storagePane.storage-v3-minimal .folder-mode-option span{display:none!important}

    @media(max-width:650px){
      #storagePane.storage-v3-minimal .storage-v2-safety{min-height:176px!important}
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
}
