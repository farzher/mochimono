const viewerMenu = document.querySelector('#viewer-menu');
let imageTools = null;
let sensitiveTools = null;

async function loadImageTools() {
  if (imageTools) return imageTools;
  imageTools = (async () => {
    for (const path of [
      './image-optimize-cloud-fallback.js',
      './image-optimize.js',
      './image-optimize-dual.js',
      './image-optimize-dual-polish.js',
      './image-optimize-zoom.js'
    ]) await import(path);
  })().catch(error => {
    imageTools = null;
    console.warn('Experimental image tools unavailable', error);
  });
  return imageTools;
}

async function loadSensitiveTools() {
  if (sensitiveTools) return sensitiveTools;
  sensitiveTools = (async () => {
    await import('./sensitive-scan.js');
    await import('./sensitive-ui.js');
    if (new URL(location.href).searchParams.has('debug')) await import('./sensitive-debug.js');
  })().catch(error => {
    sensitiveTools = null;
    console.warn('Sensitive media tools unavailable', error);
  });
  return sensitiveTools;
}

// Normal viewing stays on the core path. Image optimization is experimental and
// loads only when the viewer's extra-tools menu is actually opened.
viewerMenu?.addEventListener('toggle', () => {
  if (viewerMenu.open) void loadImageTools();
});

function watchTagManager() {
  const manager = document.querySelector('.tag-manager');
  if (!manager) return false;
  const maybeLoad = () => { if (manager.open) void loadSensitiveTools(); };
  new MutationObserver(maybeLoad).observe(manager, { attributes:true, attributeFilter:['open'] });
  maybeLoad();
  return true;
}

if (!watchTagManager()) {
  const observer = new MutationObserver(() => {
    if (!watchTagManager()) return;
    observer.disconnect();
  });
  observer.observe(document.body, { childList:true, subtree:true });
}

window.mochimonoExperimental = {
  loadImageTools,
  loadSensitiveTools
};
