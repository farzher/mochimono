const resolutionChoices = document.querySelector('[data-res]');
const resolutionLabel = document.querySelector('[data-res-label]');

if (resolutionChoices && resolutionLabel) {
  const style = document.createElement('style');
  style.textContent = `
.video-optimize-choices[data-res]{grid-template-columns:repeat(3,1fr)!important}
`;
  document.head.append(style);

  resolutionChoices.classList.remove('five');
  resolutionChoices.innerHTML = `
    <button class="video-optimize-choice active" data-value="0">Original</button>
    <button class="video-optimize-choice" data-value="2560">1440p</button>
    <button class="video-optimize-choice" data-value="1920">1080p</button>
    <button class="video-optimize-choice" data-value="1280">720p</button>
    <button class="video-optimize-choice" data-value="854">480p</button>
    <button class="video-optimize-choice" data-value="640">360p</button>`;

  const syncLabel = () => {
    resolutionLabel.textContent = resolutionChoices.querySelector('.active')?.textContent?.trim() || 'Original';
  };

  new MutationObserver(syncLabel).observe(resolutionChoices, {
    subtree:true,
    attributes:true,
    attributeFilter:['class']
  });
  resolutionChoices.addEventListener('click', () => queueMicrotask(syncLabel));
  syncLabel();
}
