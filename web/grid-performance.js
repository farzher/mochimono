const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');

let interactionActive = false;
let interactionUntil = 0;
let interactionTimer = 0;
let interactionTimerAt = 0;

function scheduleFinish(delay, sooner = false) {
  const at = performance.now() + delay;
  if (interactionTimer) {
    if (!sooner || interactionTimerAt <= at) return;
    clearTimeout(interactionTimer);
  }
  interactionTimerAt = at;
  interactionTimer = setTimeout(finishInteraction, delay);
}

function finishInteraction() {
  interactionTimer = 0;
  interactionTimerAt = 0;
  const wait = interactionUntil - performance.now();
  if (wait > 0) {
    scheduleFinish(wait + 4);
    return;
  }
  if (!interactionActive) return;
  interactionActive = false;
  document.documentElement.classList.remove('grid-interaction-active');
  window.dispatchEvent(new CustomEvent('mochimono:grid-interaction-end'));
}

function pulseInteraction(duration = 130) {
  if (viewer && !viewer.hidden) return;
  interactionUntil = Math.max(interactionUntil, performance.now() + duration);
  if (!interactionActive) {
    interactionActive = true;
    document.documentElement.classList.add('grid-interaction-active');
    window.dispatchEvent(new CustomEvent('mochimono:grid-interaction-start'));
  }
  scheduleFinish(duration + 4);
}

function releaseInteraction() {
  if (!interactionActive) return;
  interactionUntil = Math.min(interactionUntil, performance.now() + 45);
  scheduleFinish(50, true);
}

window.mochimonoGridInteraction = { active: () => interactionActive, pulse: pulseInteraction };

const arrowKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
const typingTarget = target => Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));

document.addEventListener('keydown', event => {
  if (arrowKeys.has(event.key) && !typingTarget(event.target)) pulseInteraction(event.repeat ? 140 : 180);
}, true);
document.addEventListener('keyup', event => { if (arrowKeys.has(event.key)) releaseInteraction(); }, true);
window.addEventListener('scroll', () => pulseInteraction(140), { passive:true });
window.addEventListener('wheel', () => pulseInteraction(180), { passive:true });
window.addEventListener('blur', releaseInteraction);

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    .files.grid>.date-group{contain:layout style}
    html.grid-interaction-active .commandbar{
      backdrop-filter:none!important;-webkit-backdrop-filter:none!important;
      background:rgba(24,22,25,.98)!important
    }
    html.grid-interaction-active #files .file-context-badge{
      opacity:0!important;transform:none!important;transition:none!important
    }
    html.grid-interaction-active #files .file-card:hover{
      background:var(--surface)!important;box-shadow:none!important
    }
    .video-thumb-pending{
      background:linear-gradient(110deg,#0a090b 18%,#201b21 48%,#0a090b 78%)!important;
      background-size:240% 100%!important;
      animation:mochimono-thumb-pending 1.7s ease-in-out infinite alternate!important
    }
    .video-thumb-pending::after{display:none!important}
    @keyframes mochimono-thumb-pending{
      from{background-position:100% 0}
      to{background-position:-100% 0}
    }
    @media(prefers-reduced-motion:reduce){.video-thumb-pending{animation:none!important}}
  `;
  document.head.append(style);

  function cardsIn(node) {
    if (!(node instanceof Element)) return [];
    const cards = [];
    if (node.matches('[data-hash]')) cards.push(node);
    cards.push(...node.querySelectorAll('[data-hash]'));
    return cards;
  }

  function loadedThumbnail(card) {
    const image = card.querySelector('img.cached-thumb:not([hidden])');
    return image?.complete && image.naturalWidth ? image : null;
  }

  function removeLoadingPlaceholder() {
    for (const node of files.querySelectorAll(':scope > .empty')) {
      if (node.textContent.trim() === 'Loading…') node.remove();
    }
  }

  removeLoadingPlaceholder();
  new MutationObserver(records => {
    const reusable = new Map();
    for (const record of records) {
      for (const node of record.removedNodes) {
        for (const card of cardsIn(node)) {
          const image = loadedThumbnail(card);
          if (image) reusable.set(String(card.dataset.hash || ''), image);
        }
      }
    }

    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('.empty') && node.textContent.trim() === 'Loading…') node.remove();
        for (const card of cardsIn(node)) {
          const image = reusable.get(String(card.dataset.hash || ''));
          const box = image && card.querySelector('.media-thumb');
          if (!box || box.querySelector('img.cached-thumb')) continue;
          box.querySelector('.video-thumb-pending')?.remove();
          box.prepend(image);
        }
      }
    }
  }).observe(files, { childList:true, subtree:true });
}
