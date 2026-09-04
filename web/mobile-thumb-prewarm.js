const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const commandbar = document.querySelector('.commandbar');
const coarsePointer = matchMedia('(pointer: coarse)').matches || matchMedia('(any-pointer: coarse)').matches;

if (files && coarsePointer) {
  const AHEAD_SCREENS = 3.25;
  const BEHIND_SCREENS = 1.25;
  let frame = 0;
  let lastScrollY = scrollY;
  let clearTimer = 0;

  const viewportHeight = () => Math.max(240, Number(visualViewport?.height) || innerHeight || 0);
  const viewportTop = () => Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);

  function cardsIn(node) {
    if (!(node instanceof Element)) return [];
    const cards = [];
    if (node.matches('[data-hash]')) cards.push(node);
    cards.push(...node.querySelectorAll('[data-hash]'));
    return cards;
  }

  function prewarm(cards) {
    if (!cards.length) return;
    const thumbs = window.mochimonoThumbnails;
    if (!thumbs?.prioritize) return;
    thumbs.prioritize(cards);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => thumbs.clearPriority?.(), 700);
  }

  function warmBand() {
    frame = 0;
    if (document.hidden || !viewer?.hidden) return;

    const nowY = scrollY;
    const down = nowY >= lastScrollY;
    lastScrollY = nowY;

    const height = viewportHeight();
    const top = viewportTop();
    const above = height * (down ? BEHIND_SCREENS : AHEAD_SCREENS);
    const below = height * (down ? AHEAD_SCREENS : BEHIND_SCREENS);
    const start = top - above;
    const end = top + height + below;
    const cards = [];

    for (const card of files.querySelectorAll('[data-hash]')) {
      const rect = card.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= start || rect.top >= end) continue;
      cards.push(card);
    }
    prewarm(cards);
  }

  function scheduleWarm() {
    if (!frame) frame = requestAnimationFrame(warmBand);
  }

  // Stable-grid mounts rows several screens outside the viewport. Start those
  // thumbnail requests as soon as the rows enter the DOM instead of waiting for
  // IntersectionObserver, which mobile browsers can defer during touch scrolls.
  new MutationObserver(records => {
    const mounted = [];
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('.stable-grid-row')) mounted.push(...cardsIn(node));
        else for (const row of node.querySelectorAll?.('.stable-grid-row') || []) mounted.push(...cardsIn(row));
      }
    }
    if (mounted.length) prewarm(mounted);
    scheduleWarm();
  }).observe(files, { childList:true, subtree:true });

  addEventListener('scroll', scheduleWarm, { passive:true });
  addEventListener('resize', scheduleWarm, { passive:true });
  visualViewport?.addEventListener('resize', scheduleWarm, { passive:true });
  visualViewport?.addEventListener('scroll', scheduleWarm, { passive:true });
  addEventListener('mochimono:catalog-updated', scheduleWarm);
  requestAnimationFrame(warmBand);

  addEventListener('beforeunload', () => {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(clearTimer);
  }, { once:true });
}
