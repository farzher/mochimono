const files = document.querySelector('#files');
const rail = document.querySelector('#dateRail');
const viewer = document.querySelector('#viewer');

// The library renders in 240-file pages and its jump window is 720 files.
// Keep browsing near that size instead of letting infinite scroll accumulate
// every card seen during the session.
const TARGET_WINDOW = 720;

let trimming = false;
let pendingTrim = null;
let installed = false;
let prefetchFrame = 0;
let sentinelObserver = null;

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

// Loaded before library-app.js, so this runs before library-app's rail scroll
// handler for real user scroll events.
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
    schedulePrefetch();
  };

  window.addEventListener('mochimono:grid-laid-out', restore, { once: true });
  // List view has no gallery-layout event; this is also a safety fallback.
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
  library.ensureIndex?.(pending.probeIndex);
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
    // that final partial page mounted is harmless.
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

function keepLegacySentinelsInert() {
  const sentinels = [
    document.querySelector('#top-scroll-sentinel'),
    document.querySelector('#scroll-sentinel')
  ].filter(Boolean);
  if (!sentinels.length) return;

  const hide = () => {
    for (const sentinel of sentinels) if (!sentinel.hidden) sentinel.hidden = true;
  };
  hide();
  sentinelObserver?.disconnect();
  sentinelObserver = new MutationObserver(hide);
  for (const sentinel of sentinels) sentinelObserver.observe(sentinel, {
    attributes: true,
    attributeFilter: ['hidden']
  });
}

function prefetch() {
  prefetchFrame = 0;
  const library = window.mochimonoLibrary;
  const state = library?.state?.();
  if (!library || !state || state.view === 'folders' || !viewer?.hidden || trimming) return;
  if (pendingTrim) {
    checkTrim();
    return;
  }

  const hashes = library.filteredHashes?.() || [];
  if (!hashes.length || !state.loaded) return;
  const bottomHeadroom = Math.max(1800, innerHeight * 2.5);
  const topHeadroom = Math.max(1400, innerHeight * 2);

  if (state.hasMore) {
    const last = cardFor(hashes[state.offset + state.loaded - 1]);
    if (last && last.getBoundingClientRect().bottom - innerHeight < bottomHeadroom) {
      library.extend(1);
      return;
    }
  }
  if (state.hasPrevious) {
    const first = cardFor(hashes[state.offset]);
    if (first && first.getBoundingClientRect().top > -topHeadroom) library.extend(-1);
  }
}

function schedulePrefetch() {
  if (!prefetchFrame) prefetchFrame = requestAnimationFrame(prefetch);
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
  const ensureIndex = library.ensureIndex.bind(library);

  // The covered grid does not need to chase Viewer navigation. The existing
  // closeViewer/revealViewerHash path recenters once when the Viewer closes.
  library.ensureIndex = index => {
    if (!viewer?.hidden && !trimming) return false;
    return ensureIndex(index);
  };

  library.extend = direction => {
    direction = Number(direction) < 0 ? -1 : 1;

    // Once one extra page is mounted, do not let another prefetch append more
    // before the user reaches that page and the window slides forward/backward.
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
    schedulePrefetch();
    return true;
  };

  keepLegacySentinelsInert();
  schedulePrefetch();
}

window.addEventListener('scroll', () => {
  scheduleTrimCheck();
  schedulePrefetch();
}, { passive: true });
window.addEventListener('resize', schedulePrefetch, { passive: true });
files?.addEventListener('focusin', scheduleTrimCheck, true);
window.addEventListener('mochimono:grid-laid-out', () => {
  scheduleTrimCheck();
  schedulePrefetch();
});
window.addEventListener('mochimono:catalog-cache-restored', schedulePrefetch);
window.addEventListener('mochimono:catalog-updated', schedulePrefetch);
window.addEventListener('mochimono-viewer-return', schedulePrefetch);
window.addEventListener('blur', thawRail);

installBoundedWindow();
