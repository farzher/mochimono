const RECENT_OPEN_KEY = 'mochimono.activity.recent.open';
const frame = document.querySelector('#filesFrame');
let recentOpen = sessionStorage.getItem(RECENT_OPEN_KEY) === '1';
let polishFrame = 0;

const style = document.createElement('style');
style.dataset.mochimonoVisualPolish = '1';
style.textContent = `
  /* Stronger, more legible shell hierarchy. */
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

  /* Activity should read like a dashboard, not tiny telemetry. */
  .activity-button{font-size:12px!important;font-weight:760!important;gap:8px!important}
  .activity-button .activity-count{font-size:11px!important}
  .activity-dialog .dialog-head{padding:16px 18px 13px!important}
  .activity-dialog .dialog-head h3{font-size:16px!important;font-weight:800!important;letter-spacing:-.015em!important}
  .activity-dialog .activity-body{padding:14px 16px 18px!important}
  .activity-mode{margin-bottom:13px!important}
  .activity-mode-buttons{gap:4px!important;padding:4px!important;border-radius:12px!important}
  .activity-mode-buttons button{height:38px!important;font-size:12px!important;font-weight:780!important;border-radius:8px!important}
  .activity-summary{min-height:36px!important;margin:0 0 11px!important;gap:8px!important}
  .activity-summary:has(.activity-stat.done){display:none!important}
  .activity-stat{min-height:29px!important;padding:6px 11px!important;font-size:11px!important;font-weight:680!important}
  .activity-stat b{font-size:13px!important;font-weight:800!important}
  .activity-section{margin-top:14px!important}
  .activity-section-head{align-items:center!important;min-height:26px!important;margin-bottom:8px!important;color:#918884!important;font-size:11px!important;font-weight:800!important;letter-spacing:.035em!important}
  .activity-section-head b{min-width:21px;height:20px;display:inline-grid!important;place-items:center;padding:0 6px;border-radius:999px;background:#211e22;color:#b9afab!important;font-size:10px!important;font-weight:800!important}
  .activity-row{gap:11px!important;padding:12px 13px!important;border-radius:12px!important}
  .activity-title{gap:10px!important;font-size:13px!important;font-weight:780!important;color:#e4dbd7!important}
  .activity-kind{width:30px!important;height:30px!important;border-radius:8px!important;font-size:14px!important;background:#262227!important;color:#aaa09c!important}
  .activity-detail{margin-top:7px!important;gap:6px!important}
  .activity-metric{min-height:24px!important;padding:4px 8px!important;font-size:11px!important;font-weight:650!important;color:#aaa19d!important}
  .activity-progress{height:6px!important;margin-top:9px!important}
  .activity-side{font-size:10.5px!important;font-weight:650!important;color:#8d8581!important}
  .activity-cancel{width:29px!important;height:29px!important}
  .activity-empty{padding:16px 8px!important;font-size:12px!important;font-weight:650!important}
  .activity-recent{margin-top:8px!important;padding-top:4px!important}
  .activity-recent .activity-section-head{margin:0!important;padding:10px 4px!important;border-top:1px solid #292529;user-select:none}
  .activity-recent .activity-section-head:hover{color:#d3c9c5!important}
  .activity-recent .activity-section-head:after{font-size:18px!important;color:#8f8582!important;margin-left:auto!important}
  .activity-recent.open .activity-list,.activity-recent.open .activity-empty{margin-top:7px!important}

  /* Backup management follows the same type scale. */
  .backup-center-dialog .backup-settings-section h4{font-size:14px!important;font-weight:800!important}
  .backup-center-dialog .backup-row-copy strong{font-size:13px!important;font-weight:740!important}
  .backup-center-dialog .backup-row-copy small,.backup-center-dialog .backup-destination-row .backup-row-copy small{font-size:11px!important;font-weight:600!important;line-height:1.35!important}
  .backup-center-dialog [data-folder-plan]{font-size:12px!important;font-weight:780!important}

  @media(max-width:700px){
    .activity-dialog .activity-body{padding:12px!important}
    .activity-mode-buttons button{height:36px!important}
    .activity-title{font-size:12.5px!important}
  }
`;
document.head.append(style);

const libraryCss = `
  /* Raise the Library's smallest recurring UI text without bloating the media grid. */
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

function applyRecentState() {
  polishFrame = 0;
  for (const recent of document.querySelectorAll('.activity-recent')) {
    recent.classList.toggle('open', recentOpen);
    recent.querySelector('.activity-section-head')?.setAttribute('aria-expanded', recentOpen ? 'true' : 'false');
  }
}

function schedulePolish() {
  if (polishFrame) return;
  polishFrame = requestAnimationFrame(applyRecentState);
}

document.addEventListener('click', event => {
  const head = event.target.closest?.('.activity-recent .activity-section-head');
  if (!head) return;
  queueMicrotask(() => {
    const recent = head.closest('.activity-recent');
    recentOpen = Boolean(recent?.classList.contains('open'));
    sessionStorage.setItem(RECENT_OPEN_KEY, recentOpen ? '1' : '0');
    schedulePolish();
  });
});

new MutationObserver(schedulePolish).observe(document.body, { childList:true, subtree:true });
frame?.addEventListener('load', () => requestAnimationFrame(injectLibraryType));

schedulePolish();
injectLibraryType();
