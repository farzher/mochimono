import './thumb-geometry.js';
import './fast-arrow-nav.js';
import './context-ui.js';

const files = document.querySelector('#files');
const style = document.createElement('style');
style.textContent = `
  html.keyboard-navigation-active #files.grid .file-card.context-keyboard-focus:not(.keyboard-cursor){outline:none!important;box-shadow:none!important}
  html.keyboard-navigation-active #files.grid .file-card.keyboard-cursor{position:relative;z-index:2;outline:none!important;box-shadow:none!important}
  html.keyboard-navigation-active #files.grid .file-card.keyboard-cursor::before{
    content:"";position:absolute;z-index:20;inset:0;box-sizing:border-box;
    border:4px solid #efa09a;box-shadow:inset 0 0 0 1px rgba(0,0,0,.8);pointer-events:none
  }
  html.keyboard-navigation-active #files.grid .file-card.keyboard-cursor::after{
    content:attr(data-filename);position:absolute;z-index:19;left:0;right:0;bottom:0;
    min-width:0;padding:30px 9px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    background:linear-gradient(to bottom,transparent 0,rgba(5,5,6,.32) 34%,rgba(5,5,6,.96) 100%);
    color:#fff;font-size:10px;font-weight:780;line-height:1.2;text-shadow:0 1px 3px #000;pointer-events:none
  }
  html.keyboard-navigation-active #files.grid .file-card.keyboard-cursor .file-context-badge{opacity:0!important;transition:none!important}
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
