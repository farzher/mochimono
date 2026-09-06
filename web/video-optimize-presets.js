const resolutionChoices = document.querySelector('[data-res]');
const resolutionLabel = document.querySelector('[data-res-label]');
const fpsChoices = document.querySelector('[data-fps]');
const fpsLabel = document.querySelector('[data-fps-label]');

if (resolutionChoices && resolutionLabel) {
  const style = document.createElement('style');
  style.textContent = `
.video-optimize-choices[data-res]{grid-template-columns:repeat(4,1fr)!important}
.video-optimize-choices[data-fps]{grid-template-columns:repeat(3,1fr)!important}
@media(max-width:760px){
  .video-optimize-choices[data-res],.video-optimize-choices[data-fps]{grid-template-columns:repeat(3,1fr)!important}
}
`;
  document.head.append(style);

  resolutionChoices.classList.remove('five');
  resolutionChoices.innerHTML = `
    <button class="video-optimize-choice active" data-value="0">Original</button>
    <button class="video-optimize-choice" data-value="2560">1440p</button>
    <button class="video-optimize-choice" data-value="1920">1080p</button>
    <button class="video-optimize-choice" data-value="1280">720p</button>
    <button class="video-optimize-choice" data-value="854">480p</button>
    <button class="video-optimize-choice" data-value="640">360p</button>
    <button class="video-optimize-choice" data-value="426">240p</button>
    <button class="video-optimize-choice" data-value="256">144p</button>`;

  const syncResolutionLabel = () => {
    resolutionLabel.textContent = resolutionChoices.querySelector('.active')?.textContent?.trim() || 'Original';
  };

  new MutationObserver(syncResolutionLabel).observe(resolutionChoices, {
    subtree:true,
    attributes:true,
    attributeFilter:['class']
  });
  resolutionChoices.addEventListener('click', () => queueMicrotask(syncResolutionLabel));
  syncResolutionLabel();
}

if (fpsChoices && fpsLabel) {
  fpsChoices.innerHTML = `
    <button class="video-optimize-choice active" data-value="0">Original</button>
    <button class="video-optimize-choice" data-value="60">60 fps</button>
    <button class="video-optimize-choice" data-value="30">30 fps</button>
    <button class="video-optimize-choice" data-value="15">15 fps</button>
    <button class="video-optimize-choice" data-value="10">10 fps</button>
    <button class="video-optimize-choice" data-value="5">5 fps</button>`;

  const syncFpsLabel = () => {
    fpsLabel.textContent = fpsChoices.querySelector('.active')?.textContent?.trim() || 'Original';
  };

  new MutationObserver(syncFpsLabel).observe(fpsChoices, {
    subtree:true,
    attributes:true,
    attributeFilter:['class']
  });
  fpsChoices.addEventListener('click', () => queueMicrotask(syncFpsLabel));
  syncFpsLabel();
}
