const viewer = document.querySelector('#viewer');
const openLink = document.querySelector('#viewer-open');
const closeButton = document.querySelector('#viewer-close');
const viewerContext = document.querySelector('#viewer-context');
const VIEWER_STATE = 'mochimonoViewer';
const arrowKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);

function fileParam() {
  return new URL(location.href).searchParams.get('file');
}

function fileUrl(hash) {
  const url = new URL(location.href);
  if (hash) url.searchParams.set('file', hash);
  else url.searchParams.delete('file');
  return url;
}

function viewerHash() {
  const match = openLink.getAttribute('href')?.match(/\/api\/objects\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function viewerState(value) {
  return { ...(history.state || {}), [VIEWER_STATE]: value };
}

function finishRestore() {
  document.documentElement.classList.remove('viewer-restore-pending');
}

const initialHash = fileParam();
if (initialHash) {
  const viewerUrl = new URL(location.href);
  const baseUrl = new URL(viewerUrl);
  baseUrl.searchParams.delete('file');
  history.replaceState(viewerState(false), '', baseUrl);
  history.pushState(viewerState(true), '', viewerUrl);
} else if (history.state?.[VIEWER_STATE] == null) {
  history.replaceState(viewerState(false), '', location.href);
}

let wasOpen = false;
let closingFromHistory = false;
let rapidSyncPending = false;
let rapidSyncTimer = 0;

function clearRapidSync() {
  rapidSyncPending = false;
  clearTimeout(rapidSyncTimer);
  rapidSyncTimer = 0;
}

function flushRapidSync(delay = 30) {
  if (!rapidSyncPending || rapidSyncTimer) return;
  rapidSyncTimer = setTimeout(() => {
    rapidSyncTimer = 0;
    if (!rapidSyncPending) return;
    if (!viewer.hidden && window.mochimonoViewerPerformance?.rapid?.()) return flushRapidSync(8);
    rapidSyncPending = false;
    syncUrl();
  }, delay);
}

function syncUrl() {
  const open = !viewer.hidden;
  const hash = open ? viewerHash() : '';

  if (open && hash) {
    finishRestore();
    if (wasOpen && window.mochimonoViewerPerformance?.rapid?.()) {
      rapidSyncPending = true;
      return;
    }

    clearRapidSync();
    const url = fileUrl(hash);
    if (!wasOpen) {
      if (history.state?.[VIEWER_STATE] && fileParam() === hash) history.replaceState(viewerState(true), '', url);
      else history.pushState(viewerState(true), '', url);
    } else if (fileParam() !== hash || !history.state?.[VIEWER_STATE]) {
      history.replaceState(viewerState(true), '', url);
    }
  } else if (!open && wasOpen) {
    clearRapidSync();
    if (closingFromHistory) {
      closingFromHistory = false;
    } else if (history.state?.[VIEWER_STATE]) {
      history.back();
    } else if (fileParam()) {
      history.replaceState(viewerState(false), '', fileUrl(''));
    }
  }

  wasOpen = open;
}

new MutationObserver(syncUrl).observe(viewer, {
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden', 'href']
});

document.addEventListener('keyup', event => {
  if (arrowKeys.has(event.key)) flushRapidSync(30);
}, true);
window.addEventListener('blur', () => flushRapidSync(0));

// Context chips intentionally navigate *forward* from a viewer into a filtered
// library view. Preserve the current viewer entry and add a new non-viewer entry
// before file-info.js closes it, so browser Back restores this exact file.
viewerContext?.addEventListener('click', event => {
  if (viewer.hidden || !event.target.closest('[data-context-kind]')) return;
  if (!history.state?.[VIEWER_STATE]) return;
  history.pushState(viewerState(false), '', fileUrl(''));
}, true);

async function directFile(hash) {
  const response = await fetch(`/api/files/${encodeURIComponent(hash)}/details`);
  if (!response.ok) {
    const error = new Error(`Could not restore file: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const details = await response.json();
  const source = details.sources?.[0] || {};
  return {
    ...details.object,
    filename: source.filename || hash,
    originalPath: source.path || '',
    fileDate: source.mtime || details.object.createdAt
  };
}

async function restoreViewer() {
  const hash = fileParam();
  if (!hash) {
    finishRestore();
    return;
  }

  try {
    const fallback = await directFile(hash);
    if (fileParam() !== hash) return;
    if (!window.mochimonoOpenViewer?.(hash, fallback)) throw new Error('Viewer is unavailable');
  } catch (error) {
    finishRestore();
    if (error.status !== 401 && error.status !== 404) console.warn(error);
  }
}

window.addEventListener('popstate', () => {
  const hash = fileParam();
  if (!hash) {
    finishRestore();
    if (!viewer.hidden) {
      closingFromHistory = true;
      closeButton.click();
    }
    return;
  }

  if (viewer.hidden || viewerHash() !== hash) restoreViewer().catch(console.warn);
});

restoreViewer().catch(error => {
  finishRestore();
  console.warn(error);
});
