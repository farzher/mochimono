const clientLibrary = document.documentElement.classList.contains('client-library');

if (clientLibrary) {
  const style = document.createElement('style');
  style.textContent = `
    .compression-storage-button{display:none!important}
    .compression-work-button{border-color:transparent!important;background:transparent!important;box-shadow:none!important;color:#817976!important;font-weight:600!important;padding-inline:6px!important}
    .compression-work-button:hover{background:#211e22!important;color:#c8bfbc!important}
    .compression-work-button:has([data-work-count][hidden]){display:none!important}

    /* Day labels are timeline landmarks only. Selection now lives in the
       dedicated selection UI, so do not present a checkbox/button affordance. */
    .day-group-control{pointer-events:none!important;cursor:default!important;border:0!important;background:transparent!important;box-shadow:none!important;padding-inline:0!important;color:inherit!important}
    .day-group-control .timeline-check{display:none!important}
    .day-group-control:hover,.day-group-control.selected,.day-group-control.partial{background:transparent!important;color:inherit!important}
  `;
  document.head.append(style);
}
