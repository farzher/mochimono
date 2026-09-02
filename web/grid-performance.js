const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');

let active = false;
let until = 0;
let timer = 0;

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

function pulse(duration = 130) {
  if (viewer && !viewer.hidden) return;
  until = Math.max(until, performance.now() + duration);
  if (!active) {
    active = true;
    document.documentElement.classList.add('grid-interaction-active');
    window.dispatchEvent(new CustomEvent('mochimono:grid-interaction-start'));
  }
  schedule();
}

function release() {
  if (!active) return;
  until = Math.min(until, performance.now() + 40);
  clearTimeout(timer);
  timer = 0;
  schedule();
}

window.mochimonoGridInteraction = { active: () => active, pulse };

const arrows = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
const typing = target => Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));

document.addEventListener('keydown', event => {
  if (arrows.has(event.key) && !typing(event.target)) pulse(event.repeat ? 140 : 180);
}, true);
document.addEventListener('keyup', event => { if (arrows.has(event.key)) release(); }, true);
window.addEventListener('scroll', () => pulse(140), { passive: true });
window.addEventListener('wheel', () => pulse(180), { passive: true });
window.addEventListener('blur', release);

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    .files.grid>.date-group{contain:layout style}
    html.grid-interaction-active .commandbar{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:rgba(24,22,25,.98)!important}
    html.grid-interaction-active #files .file-context-badge{opacity:0!important;transform:none!important;transition:none!important}
    html.grid-interaction-active #files .file-card:hover{background:var(--surface)!important;box-shadow:none!important}
    .video-thumb-pending{background:linear-gradient(110deg,#0a090b 18%,#241e24 48%,#0a090b 78%)!important;background-size:240% 100%!important;animation:mochimono-thumb-pending 1.55s cubic-bezier(.4,0,.2,1) infinite alternate!important}
    .video-thumb-pending::after{display:none!important}
    .thumb-failed .video-thumb-pending{animation:none!important;background:repeating-linear-gradient(135deg,#0d0c0e 0,#0d0c0e 8px,#131115 8px,#131115 16px)!important}
    @keyframes mochimono-thumb-pending{from{background-position:110% 0}to{background-position:-110% 0}}
    @media(prefers-reduced-motion:reduce){.video-thumb-pending{animation:none!important}}
  `;
  document.head.append(style);

  const removeLoading = () => {
    for (const node of files.querySelectorAll(':scope > .empty')) if (node.textContent.trim() === 'Loading…') node.remove();
  };
  removeLoading();
  new MutationObserver(removeLoading).observe(files, { childList: true });
}
