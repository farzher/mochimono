const viewer = document.querySelector('#viewer');
const media = document.querySelector('#viewer-media');
const meta = document.querySelector('#viewer-meta');

if (viewer && media && meta) {
  let bound = null;

  function resolution(width, height) {
    return `${Number(width).toLocaleString()}×${Number(height).toLocaleString()}`;
  }

  function update(video) {
    if (!video?.isConnected || video !== media.querySelector(':scope > video')) return;
    const width = Number(video.videoWidth) || 0;
    const height = Number(video.videoHeight) || 0;
    if (!width || !height) return;

    const actual = resolution(width, height);
    const parts = String(meta.textContent || '').split('·').map(part => part.trim()).filter(Boolean);
    const index = parts.findIndex(part => /^\d[\d,]*\s*[×x]\s*\d[\d,]*$/i.test(part));
    if (index >= 0) parts[index] = actual;
    else if (parts.length) parts.splice(1, 0, actual);
    else parts.push(actual);
    meta.textContent = parts.join(' · ');
    meta.dataset.videoResolution = `${width}x${height}`;
  }

  function bind() {
    const video = media.querySelector(':scope > video');
    if (video === bound) {
      if (video) update(video);
      return;
    }
    bound = video;
    if (!video) return;
    video.addEventListener('loadedmetadata', () => update(video));
    video.addEventListener('loadeddata', () => update(video));
    if (video.readyState >= 1) update(video);
  }

  new MutationObserver(bind).observe(media, { childList:true, subtree:true });
  new MutationObserver(bind).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
  bind();
}
