const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');

let interactionActive = false;
let interactionUntil = 0;
let interactionTimer = 0;

function finishInteraction() {
  interactionTimer = 0;
  const wait = interactionUntil - performance.now();
  if (wait > 0) {
    interactionTimer = setTimeout(finishInteraction, wait + 4);
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
  clearTimeout(interactionTimer);
  interactionTimer = setTimeout(finishInteraction, duration + 4);
}

function releaseInteraction() {
  if (!interactionActive) return;
  interactionUntil = Math.min(interactionUntil, performance.now() + 45);
  clearTimeout(interactionTimer);
  interactionTimer = setTimeout(finishInteraction, 50);
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
  `;
  document.head.append(style);

  function removeLoadingPlaceholder() {
    for (const node of files.querySelectorAll(':scope > .empty')) {
      if (node.textContent.trim() === 'Loading…') node.remove();
    }
  }

  removeLoadingPlaceholder();
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('.empty') && node.textContent.trim() === 'Loading…') node.remove();
      }
    }
  }).observe(files, { childList:true });
}
