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

window.mochimonoGridInteraction = { active: () => active, pulse, release };

window.addEventListener('scroll', () => pulse(140), { passive: true });
window.addEventListener('wheel', () => pulse(180), { passive: true });
window.addEventListener('blur', release);
