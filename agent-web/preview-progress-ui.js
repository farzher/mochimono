const style = document.createElement('style');
style.textContent = `
  html.background-waiting #activity>span{font-size:0}
  html.background-waiting #activity>span:after{content:'Background · Waiting for idle';font-size:10px}
  html.background-waiting #activity .progress-bar>i{animation:none!important;transform:none!important;left:0!important;opacity:.45}
`;
document.head.append(style);

let currentMode = 'idle';
let currentAllowed = false;

function apply({ mode = currentMode, allowed = currentAllowed } = {}) {
  currentMode = ['idle','max'].includes(mode) ? mode : 'idle';
  currentAllowed = Boolean(allowed);
  document.documentElement.classList.toggle('background-waiting', currentMode === 'idle' && !currentAllowed);
}

window.mochimonoPreviewMode = () => currentMode;
window.addEventListener('mochimono:background-state', event => apply(event.detail || {}));
apply();
