const viewer = document.querySelector('#viewer');
const CLIENT = document.documentElement.classList.contains('client-library');

// The grid owns its geometry. Browser anchoring and independent scroll repairs
// must not compete with it.
document.documentElement.style.overflowAnchor = 'none';

const PAGE_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End']);
const VERTICAL_ARROWS = new Set(['ArrowUp', 'ArrowDown']);
const RAPID_SCROLL_PAGES_PER_SECOND = 3;
const RAPID_SCROLL_SETTLE_MS = 95;

let active = false;
let until = 0;
let timer = 0;
let lastThumbnailActivity = 0;
let rapid = false;
let rapidMode = '';
let rapidTimer = 0;
let velocityUntil = 0;
let lastScrollY = scrollY;
let lastScrollAt = performance.now();
let pagesPerSecond = 0;
let arrowRepeated = false;
const heldPageKeys = new Set();
const heldArrowKeys = new Set();

function noteThumbnailActivity() {
  if (!CLIENT) return;
  const now = Date.now();
  if (now - lastThumbnailActivity < 1400) return;
  lastThumbnailActivity = now;
  fetch('/api/thumbnail-activity', { method:'POST', keepalive:true }).catch(() => {});
}

function finish() {
  timer = 0;
  const wait = until - performance.now();
  if (wait > 0) {
    timer = setTimeout(finish, wait + 4);
    return;
  }
  if (!active) return;
  active = false;
  document.documentElement.classList.remove('grid-interaction-active');
  window.dispatchEvent(new CustomEvent('mochimono:grid-interaction-end'));
}

function schedule() {
  if (timer) return;
  timer = setTimeout(finish, Math.max(0, until - performance.now()) + 4);
}

function pulse(duration = 140) {
  if (viewer && !viewer.hidden) return;
  noteThumbnailActivity();
  until = Math.max(until, performance.now() + duration);
  if (!active) {
    active = true;
    document.documentElement.classList.add('grid-interaction-active');
    window.dispatchEvent(new CustomEvent('mochimono:grid-interaction-start'));
  }
  schedule();
}

function wantedRapidMode(now = performance.now()) {
  if (heldPageKeys.size) return 'page';
  if (heldArrowKeys.size && arrowRepeated) return 'arrow';
  if (now < velocityUntil) return 'scroll';
  return '';
}

function scheduleRapidCheck() {
  clearTimeout(rapidTimer);
  rapidTimer = 0;
  if (heldPageKeys.size || (heldArrowKeys.size && arrowRepeated)) return;
  const wait = velocityUntil - performance.now();
  if (wait > 0) rapidTimer = setTimeout(syncRapid, wait + 4);
}

function syncRapid() {
  const next = wantedRapidMode();
  if (next) {
    rapidMode = next;
    if (!rapid) {
      rapid = true;
      document.documentElement.classList.add('grid-fast-scroll-active');
      window.mochimonoThumbnails?.clearPriority?.();
      window.dispatchEvent(new CustomEvent('mochimono:grid-fast-scroll-start', { detail:{ mode:next } }));
    }
    scheduleRapidCheck();
    return;
  }

  if (!rapid) return;
  rapid = false;
  rapidMode = '';
  document.documentElement.classList.remove('grid-fast-scroll-active');
  window.dispatchEvent(new CustomEvent('mochimono:grid-fast-scroll-end'));
}

function release() {
  if (active) {
    until = Math.min(until, performance.now() + 40);
    clearTimeout(timer);
    timer = 0;
    schedule();
  }
  heldPageKeys.clear();
  heldArrowKeys.clear();
  arrowRepeated = false;
  velocityUntil = 0;
  clearTimeout(rapidTimer);
  rapidTimer = 0;
  syncRapid();
}

// Thumbnail priority is valuable while browsing normally but becomes active
// churn during a held page/arrow key. Gate every caller in one place so stale
// image requests are canceled at rapid-mode entry and no subsystem restarts
// them until the navigation settles.
const thumbnails = window.mochimonoThumbnails;
if (thumbnails?.prioritize && !thumbnails.__rapidGridGate) {
  const prioritize = thumbnails.prioritize.bind(thumbnails);
  thumbnails.prioritize = cards => rapid ? undefined : prioritize(cards);
  thumbnails.__rapidGridGate = true;
}

window.mochimonoGridInteraction = {
  active:() => active,
  rapid:() => rapid,
  rapidMode:() => rapid ? rapidMode : '',
  pulse,
  release,
  state:() => ({ active, rapid, rapidMode:rapid ? rapidMode : '', pagesPerSecond })
};

window.addEventListener('scroll', () => {
  const now = performance.now();
  const y = scrollY;
  const elapsed = Math.max(1, now - lastScrollAt);
  const pages = Math.abs(y - lastScrollY) / Math.max(1, innerHeight);
  pagesPerSecond = pages * 1000 / elapsed;
  lastScrollY = y;
  lastScrollAt = now;
  if (pagesPerSecond >= RAPID_SCROLL_PAGES_PER_SECOND) {
    velocityUntil = Math.max(velocityUntil, now + RAPID_SCROLL_SETTLE_MS);
    syncRapid();
  }
  pulse(150);
}, { passive:true });

window.addEventListener('wheel', () => pulse(170), { passive:true, capture:true });

document.addEventListener('keydown', event => {
  if (PAGE_KEYS.has(event.key)) {
    heldPageKeys.add(event.key);
    pulse(180);
    syncRapid();
    return;
  }
  if (VERTICAL_ARROWS.has(event.key)) {
    heldArrowKeys.add(event.key);
    if (event.repeat) arrowRepeated = true;
    pulse(180);
    syncRapid();
  }
}, true);

document.addEventListener('keyup', event => {
  const now = performance.now();
  if (PAGE_KEYS.has(event.key)) heldPageKeys.delete(event.key);
  if (VERTICAL_ARROWS.has(event.key)) {
    heldArrowKeys.delete(event.key);
    if (!heldArrowKeys.size) arrowRepeated = false;
  }
  if (PAGE_KEYS.has(event.key) || VERTICAL_ARROWS.has(event.key)) {
    velocityUntil = Math.max(velocityUntil, now + 55);
    syncRapid();
  }
}, true);

window.addEventListener('blur', release);
noteThumbnailActivity();
