const files = document.querySelector('#files');
const views = document.querySelector('#views');
const folderbar = document.querySelector('#folderbar');
const dateRail = document.querySelector('#dateRail');

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function syncLayoutMode() {
  document.documentElement.classList.toggle('library-grid-view', currentView() === 'grid');
}

views.addEventListener('click', () => requestAnimationFrame(syncLayoutMode));
new MutationObserver(syncLayoutMode).observe(views, {
  subtree: true,
  attributes: true,
  attributeFilter: ['class']
});
syncLayoutMode();

folderbar.addEventListener('click', event => {
  if (!event.target.closest('[data-folder-home]') || currentView() === 'folders') return;
  const url = new URL(location.href);
  url.searchParams.delete('source');
  url.searchParams.delete('path');
  history.replaceState(history.state, '', url);
  requestAnimationFrame(() => {
    folderbar.hidden = true;
    folderbar.replaceChildren();
  });
});

const railTopHit = document.createElement('div');
railTopHit.hidden = true;
railTopHit.setAttribute('aria-hidden', 'true');
Object.assign(railTopHit.style, {
  position: 'fixed',
  top: '0',
  width: '0',
  height: '0',
  zIndex: '6',
  background: 'transparent',
  cursor: 'ns-resize',
  touchAction: 'none',
  userSelect: 'none'
});
document.body.append(railTopHit);

function syncRailTopHit() {
  if (dateRail.hidden) {
    railTopHit.hidden = true;
    return;
  }
  const rect = dateRail.getBoundingClientRect();
  if (rect.top <= 0 || rect.width <= 0) {
    railTopHit.hidden = true;
    return;
  }
  railTopHit.hidden = false;
  railTopHit.style.right = `${Math.max(0, innerWidth - rect.right)}px`;
  railTopHit.style.width = `${rect.width}px`;
  railTopHit.style.height = `${rect.top}px`;
}

let railTopFrame = 0;
function scheduleRailTopHit() {
  if (railTopFrame) return;
  railTopFrame = requestAnimationFrame(() => {
    railTopFrame = 0;
    syncRailTopHit();
  });
}

function forwardRailPointer(type, event, forceTop = false) {
  if (dateRail.hidden) return;
  const rect = dateRail.getBoundingClientRect();
  const clientY = forceTop
    ? rect.top
    : Math.max(rect.top, Math.min(rect.bottom, event.clientY));
  const capture = dateRail.setPointerCapture;
  const release = dateRail.releasePointerCapture;
  dateRail.setPointerCapture = () => {};
  dateRail.releasePointerCapture = () => {};
  try {
    dateRail.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: event.pointerType || 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: Math.max(rect.left, rect.right - 1),
      clientY
    }));
  } finally {
    if (capture) dateRail.setPointerCapture = capture;
    else delete dateRail.setPointerCapture;
    if (release) dateRail.releasePointerCapture = release;
    else delete dateRail.releasePointerCapture;
  }
}

let railTopPointer = null;

railTopHit.addEventListener('pointerdown', event => {
  if (dateRail.hidden) return;
  railTopPointer = event.pointerId;
  try { railTopHit.setPointerCapture(event.pointerId); } catch {}
  forwardRailPointer('pointerdown', event, true);
  event.preventDefault();
});

railTopHit.addEventListener('pointermove', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointermove', event);
  event.preventDefault();
});

railTopHit.addEventListener('pointerup', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointerup', event);
  try { railTopHit.releasePointerCapture(event.pointerId); } catch {}
  railTopPointer = null;
  event.preventDefault();
});

railTopHit.addEventListener('pointercancel', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointercancel', event);
  railTopPointer = null;
});

new MutationObserver(scheduleRailTopHit).observe(dateRail, {
  childList: true,
  attributes: true,
  attributeFilter: ['hidden', 'style', 'class']
});
window.addEventListener('resize', scheduleRailTopHit, { passive: true });
views.addEventListener('click', scheduleRailTopHit);
scheduleRailTopHit();

// Escape closes the top-most dialog before the viewer/application sees it.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (!dialog) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  dialog.close();
}, true);

const hoverFine = matchMedia('(hover:hover) and (pointer:fine)');
const hoverInfo = document.createElement('div');
hoverInfo.className = 'grid-hover-info';
hoverInfo.hidden = true;
document.body.append(hoverInfo);

const hoverCache = new Map();
let hoverTimer = 0;
let hoverCard = null;
let hoverGeneration = 0;

function hoverBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function hoverDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function hoverFullPath(source) {
  if (!source) return '';
  const relative = String(source.path || '');
  const root = String(source.rootPath || '').replace(/[\\/]+$/, '');
  if (!root) return relative;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function positionHoverInfo(card) {
  const rect = card.getBoundingClientRect();
  const box = hoverInfo.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - box.width - 8, rect.left));
  let top = rect.bottom + 8;
  if (top + box.height > innerHeight - 8) {
    top = Math.max(8, rect.top - box.height - 8);
  }
  hoverInfo.style.left = `${left}px`;
  hoverInfo.style.top = `${top}px`;
}

function renderHoverInfo(card, data) {
  const primary = data.sources?.[0] || {};
  const filename = primary.filename || card.title || 'File';
  const copies = data.sources?.length || 0;
  const source = primary.deviceName || primary.sourceName || '';
  const path = hoverFullPath(primary);
  const date = hoverDate(data.date?.fileDate);
  const embedded = /^exif\.|^video\./.test(String(data.date?.dateSource || ''));

  const name = document.createElement('strong');
  name.textContent = filename;
  const meta = document.createElement('div');
  meta.className = 'grid-hover-meta';
  meta.textContent = [
    date ? `${embedded ? 'Taken' : 'Date'} ${date}` : '',
    hoverBytes(data.object?.size)
  ].filter(Boolean).join(' · ');
  hoverInfo.replaceChildren(name, meta);

  if (source || copies > 1) {
    const sourceLine = document.createElement('div');
    sourceLine.className = 'grid-hover-source';
    sourceLine.textContent = [
      source,
      copies > 1 ? `${copies} source copies` : ''
    ].filter(Boolean).join(' · ');
    hoverInfo.append(sourceLine);
  }

  if (path) {
    const pathLine = document.createElement('div');
    pathLine.className = 'grid-hover-path';
    pathLine.textContent = path;
    pathLine.title = path;
    hoverInfo.append(pathLine);
  }

  hoverInfo.style.visibility = 'hidden';
  hoverInfo.hidden = false;
  positionHoverInfo(card);
  hoverInfo.style.visibility = '';
}

function hideHoverInfo() {
  if (!hoverTimer && !hoverCard && hoverInfo.hidden) return;
  clearTimeout(hoverTimer);
  hoverTimer = 0;
  hoverCard = null;
  hoverGeneration++;
  hoverInfo.hidden = true;
}

async function showHoverInfo(card, generation) {
  if (hoverCard !== card || generation !== hoverGeneration || !card.isConnected) return;
  const hash = card.dataset.hash;
  let data = hoverCache.get(hash);
  if (!data) {
    try {
      const response = await fetch(`/api/provenance/${hash}`);
      if (!response.ok) return;
      data = await response.json();
      hoverCache.set(hash, data);
    } catch {
      return;
    }
  }
  if (hoverCard !== card || generation !== hoverGeneration || !card.isConnected) return;
  renderHoverInfo(card, data);
}

files.addEventListener('pointerover', event => {
  if (!hoverFine.matches || window.mochimonoGridInteraction?.active?.() || event.pointerType && event.pointerType !== 'mouse') return;
  const card = event.target.closest('.file-card.media-card[data-hash]');
  if (!card || card.contains(event.relatedTarget) || hoverCard === card) return;
  hideHoverInfo();
  hoverCard = card;
  const generation = hoverGeneration;
  hoverTimer = setTimeout(() => showHoverInfo(card, generation), 450);
});

files.addEventListener('pointerout', event => {
  const card = event.target.closest('.file-card.media-card[data-hash]');
  if (!card || card.contains(event.relatedTarget)) return;
  if (hoverCard === card) hideHoverInfo();
});

window.addEventListener('mochimono:grid-interaction-start', hideHoverInfo);
window.addEventListener('scroll', hideHoverInfo, { passive: true });
window.addEventListener('resize', hideHoverInfo, { passive: true });

let press = null;
let dispatchingLongPress = false;
let suppressHash = '';
let suppressUntil = 0;

function cancelPress() {
  if (press?.timer) clearTimeout(press.timer);
  press = null;
}

files.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  const item = event.target.closest('[data-hash]');
  if (!item) return;
  cancelPress();
  const hash = item.dataset.hash;
  press = {
    pointerId: event.pointerId,
    hash,
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      if (!press || press.hash !== hash) return;
      suppressHash = hash;
      suppressUntil = performance.now() + 900;
      dispatchingLongPress = true;
      item.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: press.x,
        clientY: press.y
      }));
      dispatchingLongPress = false;
      navigator.vibrate?.(8);
      cancelPress();
    }, 500)
  };
}, { passive: true });

files.addEventListener('pointermove', event => {
  if (!press || event.pointerId !== press.pointerId) return;
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) {
    cancelPress();
  }
}, { passive: true });

files.addEventListener('pointerup', cancelPress, { passive: true });
files.addEventListener('pointercancel', cancelPress, { passive: true });

files.addEventListener('click', event => {
  if (dispatchingLongPress) return;
  const item = event.target.closest('[data-hash]');
  if (!item || item.dataset.hash !== suppressHash || performance.now() > suppressUntil) return;
  suppressHash = '';
  suppressUntil = 0;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

files.addEventListener('contextmenu', event => {
  const item = event.target.closest('[data-hash]');
  if (item && item.dataset.hash === suppressHash && performance.now() <= suppressUntil) {
    event.preventDefault();
  }
});
