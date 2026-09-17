const frame = document.querySelector('#filesFrame');

const style = document.createElement('style');
style.dataset.mochimonoVisualPolish = '1';
style.textContent = `
  .client-storage span{font-size:12px!important;font-weight:720!important}
  .client-tabs button,.client-menu .device-button,.client-logout{font-size:13px!important;font-weight:680!important}
  .client-menu .menu-label{font-size:11px!important;font-weight:760!important;letter-spacing:.035em!important}
  .storage-path-parent{font-size:11px!important;font-weight:600!important;color:#8b8381!important}
  #storagePane .folder-item .storage-meta{font-size:13px!important;font-weight:650!important}
  #storagePane .folder-item .storage-modes{font-size:11px!important;font-weight:780!important;padding:4px 8px!important}
  #storagePane .backup-item .storage-meta{font-size:11px!important;font-weight:620!important}
  .folder-mode-option strong{font-size:13px!important;font-weight:760!important}
  .folder-mode-option span,.folder-mode-note{font-size:11px!important;font-weight:600!important;line-height:1.35!important}
  .field-label,.picker-path{font-size:12px!important;font-weight:680!important}

  .backup-center-dialog .backup-settings-section h4{font-size:14px!important;font-weight:800!important}
  .backup-center-dialog .backup-row-copy strong{font-size:13px!important;font-weight:740!important}
  .backup-center-dialog .backup-row-copy small,.backup-center-dialog .backup-destination-row .backup-row-copy small{font-size:11px!important;font-weight:600!important;line-height:1.35!important}
  .backup-center-dialog [data-folder-plan]{font-size:12px!important;font-weight:780!important}
`;
document.head.append(style);

const libraryCss = `
  .file-count,.select-toggle,.logout-button,.selection-bar,.selection-bar strong,.day-group-control{font-size:12px!important;font-weight:700!important}
  .grid-hover-meta,.grid-hover-source{font-size:11px!important;font-weight:650!important}
  .grid-hover-path{font-size:10.5px!important;font-weight:580!important;line-height:1.4!important}
  .library-filter-popover label{font-size:11px!important;font-weight:720!important}
  .library-filter-popover select{font-size:12px!important;font-weight:650!important}
  .library-filter-count{font-size:9px!important;font-weight:850!important}
  .date-heading{font-size:14px!important;font-weight:780!important}
  .year-heading{font-weight:800!important}
  .files .empty,.muted{font-size:13px!important;font-weight:650!important}
  .file-row,.folder-row{font-weight:560!important}
`;

function injectLibraryType() {
  try {
    const doc = frame?.contentDocument;
    if (!doc?.head || doc.head.querySelector('style[data-mochimono-visual-polish]')) return;
    const sheet = doc.createElement('style');
    sheet.dataset.mochimonoVisualPolish = '1';
    sheet.textContent = libraryCss;
    doc.head.append(sheet);
  } catch {}
}

frame?.addEventListener('load', () => requestAnimationFrame(injectLibraryType));
injectLibraryType();
