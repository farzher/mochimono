const viewer = document.querySelector('#viewer');
const openLink = document.querySelector('#viewer-open');
const closeButton = document.querySelector('#viewer-close');
const viewerContext = document.querySelector('#viewer-context');
const VIEWER_STATE = 'mochimonoViewer';

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const fileParam = () => new URL(location.href).searchParams.get('file');

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

const viewerState = value => ({ ...(history.state || {}), [VIEWER_STATE]: value });
const finishRestore = () => document.documentElement.classList.remove('viewer-restore-pending');

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

function syncUrl() {
  const open = !viewer.hidden;
  const hash = open ? viewerHash() : '';

  if (open && hash) {
    finishRestore();
    if (wasOpen && window.mochimonoViewerPerformance?.defer?.(syncUrl)) return;

    const url = fileUrl(hash);
    if (!wasOpen) {
      if (history.state?.[VIEWER_STATE] && fileParam() === hash) history.replaceState(viewerState(true), '', url);
      else history.pushState(viewerState(true), '', url);
    } else if (fileParam() !== hash || !history.state?.[VIEWER_STATE]) {
      history.replaceState(viewerState(true), '', url);
    }
  } else if (!open && wasOpen) {
    if (closingFromHistory) closingFromHistory = false;
    else if (history.state?.[VIEWER_STATE]) history.back();
    else if (fileParam()) history.replaceState(viewerState(false), '', fileUrl(''));
  }

  wasOpen = open;
}

const viewerObserver = new MutationObserver(syncUrl);
viewerObserver.observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
viewerObserver.observe(openLink, { attributes: true, attributeFilter: ['href'] });

viewerContext?.addEventListener('click', event => {
  if (viewer.hidden || !event.target.closest('[data-context-kind]') || !history.state?.[VIEWER_STATE]) return;
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

function waitForCatalogFile(hash) {
  let timer;
  let settled = false;
  const events = ['mochimono:catalog-cache-restored', 'mochimono:catalog-updated'];
  return new Promise(resolve => {
    const finish = found => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, check);
      resolve(found);
    };
    const check = () => {
      if (fileParam() !== hash) return finish(false);
      if (window.mochimonoOpenViewer?.(hash)) finish(true);
    };
    for (const event of events) window.addEventListener(event, check);
    timer = setTimeout(() => finish(false), 10000);
    check();
  });
}

async function restoreViewer() {
  const hash = fileParam();
  if (!hash) {
    finishRestore();
    return;
  }

  // The catalog boots asynchronously. A direct link can arrive before either
  // its cached or fresh catalog has been installed, especially for local-only
  // files which have no server details response to use as a fallback.
  if (window.mochimonoOpenViewer?.(hash)) {
    finishRestore();
    return;
  }

  try {
    const fallback = await directFile(hash);
    if (fileParam() !== hash) return;
    if (!window.mochimonoOpenViewer?.(hash, fallback)) throw new Error('Viewer is unavailable');
  } catch (error) {
    if (await waitForCatalogFile(hash)) {
      finishRestore();
      return;
    }
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
