import './thumb-geometry.js';
import './fast-arrow-nav.js';
import './context-ui.js';

const files = document.querySelector('#files');
const style = document.createElement('style');
style.textContent = `
  html.keyboard-navigation-active #files.grid .file-card.context-keyboard-focus:not(.keyboard-cursor){outline:none!important;box-shadow:none!important}
  #files.grid .file-card.keyboard-cursor{position:relative;z-index:2;outline:none!important}
  #files.grid .file-card.media-card.keyboard-cursor::before{opacity:0!important;transform:none!important;transition:none!important}
  #files.grid .file-card.media-card.keyboard-cursor::after{
    content:""!important;z-index:20!important;inset:0!important;left:0!important;top:0!important;right:0!important;bottom:0!important;
    width:auto!important;height:auto!important;padding:0!important;border-radius:3px!important;opacity:1!important;transform:none!important;
    background:none!important;box-shadow:inset 0 0 0 4px #efa09a,inset 0 0 0 5px rgba(0,0,0,.82)!important;transition:none!important;pointer-events:none
  }
  #files.grid .file-card:not(.media-card).keyboard-cursor{box-shadow:inset 0 0 0 4px #efa09a,inset 0 0 0 5px rgba(0,0,0,.82)!important}
  #files.grid .file-card.keyboard-cursor .file-context-badge{opacity:1!important;transform:none!important;transition:none!important}
  html.keyboard-navigation-active #files.list .file-row.context-keyboard-focus,
  html.keyboard-navigation-active #files.folders .folder-row.context-keyboard-focus{
    outline:3px solid #efa09a!important;outline-offset:-3px!important;box-shadow:none!important;border-radius:4px
  }
`;
document.head.append(style);

document.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  document.documentElement.classList.add('keyboard-navigation-active');
}, true);

files?.addEventListener('pointerdown', () => {
  document.documentElement.classList.remove('keyboard-navigation-active');
  files.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
}, true);
