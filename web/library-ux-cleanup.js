const clientLibrary = document.documentElement.classList.contains('client-library');

if (clientLibrary) {
  const style = document.createElement('style');
  style.textContent = `
    .compression-storage-button{display:none!important}
    .compression-work-button{border-color:transparent!important;background:transparent!important;box-shadow:none!important;color:#817976!important;font-weight:600!important;padding-inline:6px!important}
    .compression-work-button:hover{background:#211e22!important;color:#c8bfbc!important}
    .compression-work-button:has([data-work-count][hidden]){display:none!important}
  `;
  document.head.append(style);

  const syncWork = () => {
    const button = document.querySelector('.compression-work-button');
    if (!button) return;
    const badge = button.querySelector('[data-work-count]');
    const count = Number(String(badge?.textContent || '').replace(/[^0-9]/g, '')) || 0;
    button.hidden = !count;
  };

  const observer = new MutationObserver(syncWork);
  observer.observe(document.body, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['hidden'] });
  syncWork();
}
