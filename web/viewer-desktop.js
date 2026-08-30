const viewerDesktopStage = document.querySelector('#viewer-stage');
const viewerDesktopMedia = document.querySelector('#viewer-media');

const viewerDesktopStyle = document.createElement('style');
viewerDesktopStyle.textContent = `
  #viewer-media img{
    user-select:none;
    -webkit-user-select:none;
    -webkit-user-drag:none;
  }
`;
document.head.append(viewerDesktopStyle);

function protectViewerImages() {
  for (const image of viewerDesktopMedia?.querySelectorAll('img') || []) image.draggable = false;
}

protectViewerImages();
if (viewerDesktopMedia) {
  new MutationObserver(protectViewerImages).observe(viewerDesktopMedia, { childList: true, subtree: true });
  viewerDesktopMedia.addEventListener('dragstart', event => {
    if (event.target.closest('img')) event.preventDefault();
  });
  viewerDesktopMedia.addEventListener('selectstart', event => {
    if (event.target.closest('img')) event.preventDefault();
  });
}

if (viewerDesktopStage) {
  let press = null;
  let lastClick = null;
  let lastClickTimer = 0;

  viewerDesktopStage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if (!viewerDesktopStage.classList.contains('viewer-desktop-zoomed')) return;
    if (!event.target.closest('#viewer-media img')) return;
    window.getSelection()?.removeAllRanges();
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false
    };
  }, true);

  viewerDesktopStage.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press.moved = true;
  }, true);

  viewerDesktopStage.addEventListener('pointerup', event => {
    if (!press || event.pointerId !== press.pointerId) return;
    const current = press;
    press = null;
    if (current.moved || !viewerDesktopStage.classList.contains('viewer-desktop-zoomed')) return;

    const now = performance.now();
    const doubleClick = lastClick &&
      now - lastClick.time <= 350 &&
      Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) <= 44;

    clearTimeout(lastClickTimer);
    if (!doubleClick) {
      lastClick = { time: now, x: event.clientX, y: event.clientY };
      lastClickTimer = setTimeout(() => { lastClick = null; }, 400);
      return;
    }

    lastClick = null;
    window.getSelection()?.removeAllRanges();
    const image = viewerDesktopMedia?.querySelector('img');
    image?.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: event.clientX,
      clientY: event.clientY
    }));
  }, true);

  viewerDesktopStage.addEventListener('pointercancel', event => {
    if (press?.pointerId === event.pointerId) press = null;
  }, true);
}
