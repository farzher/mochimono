const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerMedia = document.querySelector('#viewer-media');
const viewerMeta = document.querySelector('#viewer-meta');
const actions = viewer?.querySelector('.viewer-actions');
const menuActions = document.querySelector('#viewer-menu > div');

if (viewer && viewerOpen && viewerMedia && viewerMeta && actions) {
  const style = document.createElement('style');
  style.textContent = `
.viewer-renditions{display:inline-grid;grid-template-columns:1fr 1fr;align-items:center;height:30px;padding:2px;border-radius:8px;background:rgba(20,19,20,.82);border:1px solid rgba(255,255,255,.08)}
.viewer-renditions[hidden]{display:none!important}.viewer-renditions button{height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:#a9a19d;font-size:10px;font-weight:750}.viewer-renditions button.active{background:#eee9e5;color:#171416}.viewer-renditions button:hover:not(.active){color:#fff}
@media(max-width:700px){.viewer-renditions button{padding:0 6px;font-size:9.5px}}
`;
  document.head.append(style);

  const switcher = document.createElement('div');
  switcher.className = 'viewer-renditions';
  switcher.hidden = true;
  switcher.innerHTML = '<button type="button" data-rendition="original" class="active">Original</button><button type="button" data-rendition="compact">Compact</button>';
  viewerOpen.before(switcher);

  const removeCompact = document.createElement('button');
  removeCompact.type = 'button';
  removeCompact.className = 'viewer-menu-action';
  removeCompact.textContent = 'Remove compact';
  removeCompact.hidden = true;
  menuActions?.prepend(removeCompact);

  let generation = 0;
  let currentHash = '';
  let rendition = null;
  let mode = 'original';
  let originalMeta = '';
  let originalImageFull = '';

  const hash = () => viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const bytes = value => {
    const units = ['B','KB','MB','GB','TB'];
    let amount = Math.max(0, Number(value) || 0);
    let unit = 0;
    while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
    return `${amount < 10 && unit ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
  };

  async function readJson(path) {
    const response = await fetch(path, { cache:'no-store' });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  async function readRendition(originalHash) {
    const local = await readJson(`/api/renditions/${encodeURIComponent(originalHash)}`);
    if (local?.rendition) return { ...local.rendition, remote:false };
    const remote = await readJson(`/api/representations/${encodeURIComponent(originalHash)}/rendition`);
    return remote?.rendition ? { ...remote.rendition, remote:true } : null;
  }

  function compactUrl() {
    if (!rendition || !currentHash) return '';
    return rendition.remote
      ? `/api/representations/${encodeURIComponent(currentHash)}/compact?v=${Date.now()}`
      : `/api/renditions/file?original=${encodeURIComponent(currentHash)}&v=${Date.now()}`;
  }

  function setButtons() {
    switcher.querySelectorAll('[data-rendition]').forEach(button => button.classList.toggle('active', button.dataset.rendition === mode));
    removeCompact.hidden = !rendition;
  }

  function compactMeta() {
    if (!rendition) return originalMeta;
    const resolution = rendition.width && rendition.height ? `${Number(rendition.width).toLocaleString()}×${Number(rendition.height).toLocaleString()}` : '';
    return [bytes(rendition.size), resolution, 'Compact', rendition.presetName].filter(Boolean).join(' · ');
  }

  function rememberOriginalImage(image) {
    if (!image || originalImageFull) return;
    originalImageFull = image.dataset.fullSrc || `/api/objects/${encodeURIComponent(currentHash)}`;
  }

  async function swapVideo(video, nextSrc) {
    const time = Number(video.currentTime) || 0;
    const paused = video.paused;
    const volume = video.volume;
    const muted = video.muted;
    const rate = video.playbackRate;
    video.src = nextSrc;
    video.load();
    await new Promise(resolve => {
      if (video.readyState >= 1) return resolve();
      video.addEventListener('loadedmetadata', resolve, { once:true });
      setTimeout(resolve, 1500);
    });
    try { video.currentTime = Math.min(time, Number(video.duration) || time); } catch {}
    video.volume = volume;
    video.muted = muted;
    video.playbackRate = rate;
    if (!paused) video.play().catch(() => {});
  }

  async function show(next) {
    if (!rendition || !currentHash || (next !== 'original' && next !== 'compact')) return;
    mode = next;
    setButtons();
    const image = viewerMedia.querySelector(':scope > img');
    const video = viewerMedia.querySelector(':scope > video');
    if (image) {
      rememberOriginalImage(image);
      image.removeAttribute('data-full-src');
      image.src = next === 'compact'
        ? compactUrl()
        : originalImageFull || `/api/objects/${encodeURIComponent(currentHash)}`;
    } else if (video) {
      await swapVideo(video, next === 'compact'
        ? compactUrl()
        : `/api/objects/${encodeURIComponent(currentHash)}`);
    }
    viewerMeta.textContent = next === 'compact' ? compactMeta() : originalMeta;
  }

  async function removeCurrentCompact() {
    const originalHash = currentHash;
    if (!originalHash || !rendition) return;
    if (mode === 'compact') await show('original');
    await fetch(`/api/renditions/${encodeURIComponent(originalHash)}`, { method:'DELETE' }).catch(() => {});
    await fetch(`/api/representations/${encodeURIComponent(originalHash)}/rendition`, { method:'DELETE' }).catch(() => {});
    rendition = null;
    mode = 'original';
    switcher.hidden = true;
    setButtons();
    window.dispatchEvent(new CustomEvent('mochimono:work-changed', { detail:{ originalHash, removedCompact:true } }));
  }

  async function sync() {
    const nextHash = hash();
    const serial = ++generation;
    if (viewer.hidden || !nextHash) {
      switcher.hidden = true;
      removeCompact.hidden = true;
      currentHash = '';
      rendition = null;
      return;
    }
    if (nextHash !== currentHash) {
      currentHash = nextHash;
      mode = 'original';
      originalImageFull = '';
      originalMeta = viewerMeta.textContent;
      setButtons();
    } else if (mode === 'original') originalMeta = viewerMeta.textContent;
    const found = await readRendition(nextHash).catch(() => null);
    if (serial !== generation || nextHash !== hash()) return;
    rendition = found;
    switcher.hidden = !rendition;
    if (!rendition && mode === 'compact') mode = 'original';
    setButtons();
  }

  switcher.addEventListener('click', event => {
    const button = event.target.closest('[data-rendition]');
    if (button) show(button.dataset.rendition).catch(error => console.warn('Could not switch rendition', error));
  });
  removeCompact.addEventListener('click', () => removeCurrentCompact().catch(error => console.warn('Could not remove compact rendition', error)));

  document.addEventListener('click', event => {
    const trigger = event.target.closest('.viewer-optimize-trigger');
    if (!trigger || mode !== 'compact' || !rendition) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show('original').then(() => requestAnimationFrame(() => trigger.click())).catch(() => {});
  }, true);

  new MutationObserver(() => requestAnimationFrame(() => sync().catch(() => {}))).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
  new MutationObserver(() => requestAnimationFrame(() => sync().catch(() => {}))).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
  window.addEventListener('mochimono:work-changed', () => sync().catch(() => {}));
  window.addEventListener('mochimono:catalog-updated', () => sync().catch(() => {}));
  setInterval(() => { if (!viewer.hidden && currentHash) sync().catch(() => {}); }, 2500);
  sync().catch(() => {});
}