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
    if (event.target.closest?.('img')) event.preventDefault();
  });
  viewerDesktopMedia.addEventListener('selectstart', event => {
    if (event.target.closest?.('img')) event.preventDefault();
  });
}
