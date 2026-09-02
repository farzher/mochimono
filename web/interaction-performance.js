const files = document.querySelector('#files');
const rail = document.querySelector('#dateRail');
const viewer = document.querySelector('#viewer');

// The library renders in 240-file pages and its jump window is 720 files.
// Keep normal browsing bounded to that same window instead of letting every
// infinite-scroll extension remain mounted for the rest of the session.
const TARGET_WINDOW = 720;

let trimming = false;
let pendingTrim = null;
let installed = false;

// Normal scrolling used to make library-app scan every mounted card on every
// animation frame just to move the date-rail thumb. Keep the already-rendered
// rail visible while scrolling and do one exact update when scrolling settles.
let railFrozen = false;
let railWasHidden = false;
let railTimer = 0;
let syntheticRailScroll = false;

const style = document.createElement('style');
style.textContent = `
  #dateRail.interaction-scroll-freeze[hidden]{display:block!important}
`;
document.head.append(style);

function thawRail() {
  clearTimeout(railTimer);
  railTimer = 0;
  if (!railFrozen || !rail) return;
  railFrozen = false;
  rail.classList.remove('interaction-scroll-freeze');
  rail.hidden = railWasHidden;
  if (rail.hidden) return;

  // Let library-app calculate the exact final rail position once after the
  // scroll burst, without turning every intermediate scroll frame into O(n).
  syntheticRailScroll = true;
  window.dispatchEvent(new Event('scroll'));
  syntheticRailScroll = false;
}

function freezeRailDuringScroll() {
  if (syntheticRailScroll || trimming || !rail) return;
  if (!railFrozen) {
    if (rail.hidden) return;
    railFrozen = true;
    railWasHidden = rail.hidden;
    rail.classList.add('interaction-scroll-freeze');
    rail.hidden = true;
  }
  clearTimeout(railTimer);
  railTimer = setTimeout(thawRail, 72);
}

// This module is loaded before library-app.js, so this scroll listener runs
// before library-app's expensive rail scan for real user scroll events.
window.addEventListener('scroll', freezeRailDuringScroll, { passive: true });

function hashSelector(hash) {
  return `[data-hash="${CSS.escape(String(hash || ''))}"]`;
}

function cardFor(hash) {
  return hash ? files?.querySelector(hashSelector(hash)) : null;
}

function scheduleTrimCheck() {
  if (!pendingTrim || trimming) return;
  requestAnimationFrame(checkTrim);
}

function restoreAfterRecenter(anchorHash, anchorTop, focusHash) {
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    window.removeEventListener('mochimono:grid-laid-out', restore);

    const anchor = cardFor(anchorHash);
    if (anchor) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > .5) window.scrollBy(0, delta);
    }

    const focused = cardFor(focusHash);
    if (focused) {
      focused.classList.add('context-keyboard-focus');
      if (focused.tabIndex < 0) focused.tabIndex = 0;
      focused.focus({ preventScroll: true });
    }
    trimming = false;
  };

  window.addEventListener('mochimono:grid-laid-out', restore, { once: true });
  // List view has no gallery-layout event; this is also a safety fallback if a
  // grid layout was already complete synchronously.
  requestAnimationFrame(() => requestAnimationFrame(restore));
}

function recenterWindow(pending) {
  const library = window.mochimonoLibrary;
  if (!library || trimming) return;
  const anchor = cardFor(pending.thresholdHash);
  if (!anchor) {
    pendingTrim = null;
    return;
  }

  const anchorTop = anchor.getBoundingClientRect().top;
  const focused = document.activeElement?.closest?.('#files [data-hash]');
  const focusHash = focused?.dataset.hash || '';

  pendingTrim = null;
  trimming = true;
  restoreAfterRecenter(pending.thresholdHash, anchorTop, focusHash);
  const changed = library.ensureIndex?.(pending.probeIndex);
  if (changed === false) {
    trimming = false;
    window.removeEventListener('mochimono:grid-laid-out', restoreAfterRecenter);
  }
}

function checkTrim() {
  if (!pendingTrim || trimming || !viewer?.hidden) return;
  const pending = pendingTrim;
  const threshold = cardFor(pending.thresholdHash);
  if (!threshold) {
    pendingTrim = null;
    return;
  }

  const rect = threshold.getBoundingClientRect();
  const ready = pending.direction > 0
    ? rect.top < innerHeight - 24
    : rect.bottom > 92;
  if (ready) recenterWindow(pending);
}

function prepareTrim(direction, before, after) {
  const library = window.mochimonoLibrary;
  const hashes = library?.filteredHashes?.() || [];
  if (!hashes.length || after.loaded <= TARGET_WINDOW) return;

  if (direction > 0) {
    const thresholdIndex = before.offset + before.loaded;
    const probeIndex = after.offset + after.loaded;
    // ensureIndex only recenters when given an index outside the current window.
    // At the absolute end of a small library there is no outside index; keeping
    // that final partial page mounted is harmless and still bounded closely.
    if (!hashes[thresholdIndex] || probeIndex >= hashes.length) return;
    pendingTrim = {
      direction: 1,
      thresholdHash: hashes[thresholdIndex],
      probeIndex
    };
  } else {
    const thresholdIndex = before.offset - 1;
    const probeIndex = after.offset - 1;
    if (!hashes[thresholdIndex] || probeIndex < 0) return;
    pendingTrim = {
      direction: -1,
      thresholdHash: hashes[thresholdIndex],
      probeIndex
    };
  }
  scheduleTrimCheck();
}

function installBoundedWindow() {
  if (installed) return;
  const library = window.mochimonoLibrary;
  if (!library?.extend || !library?.state || !library?.ensureIndex) {
    requestAnimationFrame(installBoundedWindow);
    return;
  }
  installed = true;

  const extend = library.extend.bind(library);
  library.extend = direction => {
    direction = Number(direction) < 0 ? -1 : 1;

    // Once one extra page is mounted, do not let the two independent prefetch
    // mechanisms keep appending more pages before the user reaches it.
    if (pendingTrim && pendingTrim.direction === direction) {
      scheduleTrimCheck();
      return false;
    }
    if (pendingTrim && pendingTrim.direction !== direction) pendingTrim = null;

    const before = library.state();
    const changed = extend(direction);
    if (!changed) return false;
    const after = library.state();
    prepareTrim(direction, before, after);
    return true;
  };
}

window.addEventListener('scroll', scheduleTrimCheck, { passive: true });
files?.addEventListener('focusin', scheduleTrimCheck, true);
window.addEventListener('mochimono:grid-laid-out', scheduleTrimCheck);
window.addEventListener('blur', thawRail);

installBoundedWindow();
