import ai from './ai-engine.js';

const files = document.querySelector('#files');
const search = document.querySelector('#search');
const commandbar = document.querySelector('.commandbar');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');
const viewerMenu = document.querySelector('#viewer-menu > div');
const viewerInfoButton = document.querySelector('#viewer-info-button');

if (commandbar && files) {
  const style = document.createElement('style');
  style.textContent = `
.ai-lab-toggle{height:31px;min-width:31px;padding:0 9px;border:1px solid rgba(255,255,255,.07);border-radius:9px;background:#171518;color:#bbb2af;font-size:10px;font-weight:750;letter-spacing:.02em}
.ai-lab-toggle:hover{background:#252126;color:#fff}
.ai-lab-dialog{width:min(1040px,calc(100vw - 28px));height:min(820px,calc(100vh - 28px));padding:0;border:1px solid #3b363b;border-radius:16px;background:#121013;color:#eee8e4;box-shadow:0 30px 100px rgba(0,0,0,.72)}
.ai-lab-dialog::backdrop{background:rgba(0,0,0,.7);backdrop-filter:blur(5px)}
.ai-lab-shell{height:100%;display:grid;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden}
.ai-lab-head{display:flex;align-items:center;gap:12px;padding:14px 16px 12px;border-bottom:1px solid #292529}
.ai-lab-head strong{font-size:13px}.ai-lab-head span{min-width:0;flex:1;color:#81797d;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ai-lab-close{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#8d8588;font-size:18px}.ai-lab-close:hover{background:#282429;color:#fff}
.ai-lab-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:10px 16px;border-bottom:1px solid #292529;background:#151316}
.ai-lab-search{display:flex;min-width:min(440px,100%);flex:1;gap:6px}.ai-lab-search input{min-width:0;flex:1;height:31px;padding:0 10px;border:1px solid #373238;border-radius:8px;background:#0d0c0e;color:#eee8e4;font-size:11px;outline:none}.ai-lab-search input:focus{border-color:#6d6268}
.ai-lab-button{height:31px;padding:0 10px;border:1px solid #373238;border-radius:8px;background:#211e22;color:#d8cfcb;font-size:9.5px;font-weight:700;white-space:nowrap}.ai-lab-button:hover{background:#2b272c;color:#fff}.ai-lab-button:disabled{opacity:.4}
.ai-lab-main{min-height:0;overflow:auto;padding:14px 16px 24px}.ai-lab-section{margin-bottom:20px}.ai-lab-section[hidden]{display:none!important}
.ai-lab-section-head{display:flex;align-items:center;gap:9px;margin-bottom:9px}.ai-lab-section-head strong{font-size:11px}.ai-lab-section-head span{color:#797174;font-size:9px}.ai-lab-section-head .ai-lab-button{margin-left:auto}
.ai-lab-progress{height:3px;margin:0 0 12px;overflow:hidden;border-radius:99px;background:#282429}.ai-lab-progress i{display:block;width:0;height:100%;background:#efa09a;transition:width .12s linear}
.ai-lab-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:7px}.ai-result{position:relative;aspect-ratio:1;border:0;border-radius:9px;overflow:hidden;background:#0a090b;padding:0;cursor:pointer}.ai-result img{width:100%;height:100%;display:block;object-fit:cover}.ai-result span{position:absolute;right:5px;top:5px;padding:3px 5px;border-radius:999px;background:rgba(8,7,9,.76);color:#f4ede9;font-size:8px;font-weight:800;backdrop-filter:blur(5px)}.ai-result small{position:absolute;left:5px;right:5px;bottom:5px;padding:3px 5px;border-radius:6px;background:rgba(8,7,9,.7);color:#ddd4d0;font-size:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ai-compare-column{min-width:0;padding:10px;border:1px solid #292529;border-radius:11px;background:#151316}.ai-compare-column>strong{display:block;margin-bottom:8px;font-size:10px}.ai-compare-column .ai-lab-results{grid-template-columns:repeat(4,minmax(0,1fr))}
.ai-target{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid #302b30;border-radius:10px;background:#171518}.ai-target img{width:48px;height:48px;border-radius:7px;object-fit:cover;background:#080709}.ai-target div{min-width:0;flex:1}.ai-target strong,.ai-target span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ai-target strong{font-size:10px}.ai-target span{margin-top:3px;color:#7e7679;font-size:9px}
.ai-text-output{padding:11px 12px;border:1px solid #302b30;border-radius:10px;background:#171518;color:#cec5c2;font-size:10px;line-height:1.55;white-space:pre-wrap}
.ai-groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}.ai-group{padding:9px;border:1px solid #302b30;border-radius:10px;background:#171518}.ai-group-head{display:flex;align-items:center;gap:8px;margin-bottom:7px}.ai-group-head strong{font-size:10px}.ai-group-head span{flex:1;color:#766f72;font-size:8.5px}.ai-group-head button{height:24px;padding:0 7px}
.ai-group-thumbs{display:grid;grid-template-columns:repeat(6,1fr);gap:2px}.ai-group-thumbs img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px;background:#09080a}
.ai-mask-preview{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.ai-mask-preview canvas{max-width:360px;max-height:320px;border-radius:9px;background:#09080a}.ai-mask-preview .ai-text-output{flex:1;min-width:220px}
.ai-empty{padding:18px;border:1px dashed #332e33;border-radius:10px;color:#766f72;font-size:10px;text-align:center}
@media(max-width:760px){.ai-lab-dialog{width:100vw;height:100vh;max-width:none;max-height:none;border:0;border-radius:0}.ai-compare{grid-template-columns:1fr}.ai-compare-column .ai-lab-results{grid-template-columns:repeat(4,minmax(0,1fr))}.ai-lab-search{min-width:100%}}
`;
  document.head.append(style);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ai-lab-toggle';
  toggle.textContent = 'AI';
  toggle.title = 'AI Lab · semantic search, AI similarity, auto groups, descriptions, and masks';
  search?.after(toggle);

  const viewerAi = document.createElement('button');
  viewerAi.type = 'button';
  viewerAi.className = 'viewer-menu-action';
  viewerAi.textContent = 'AI tools';
  viewerAi.title = 'Open AI Lab for this file';
  if (viewerMenu) viewerMenu.insertBefore(viewerAi, viewerInfoButton || viewerMenu.firstChild);

  const dialog = document.createElement('dialog');
  dialog.className = 'ai-lab-dialog';
  dialog.innerHTML = `
    <div class="ai-lab-shell">
      <div class="ai-lab-head"><strong>AI Lab</strong><span data-ai-status>Local AI is idle</span><button class="ai-lab-close" type="button" aria-label="Close">×</button></div>
      <div class="ai-lab-toolbar">
        <form class="ai-lab-search" data-ai-search-form>
          <input type="search" data-ai-query placeholder="Search what is in your images and video previews" autocomplete="off">
          <button class="ai-lab-button" type="submit">Semantic search</button>
        </form>
        <button class="ai-lab-button" type="button" data-ai-index="siglip2">Index semantic</button>
        <button class="ai-lab-button" type="button" data-ai-index="dinov3">Index visual</button>
        <button class="ai-lab-button" type="button" data-ai-groups>Auto groups</button>
      </div>
      <div class="ai-lab-main">
        <div class="ai-lab-progress" hidden><i></i></div>
        <section class="ai-lab-section" data-ai-target-section hidden>
          <div class="ai-lab-section-head"><strong>Selected file</strong><span>AI runs locally in this browser</span></div>
          <div class="ai-target">
            <img data-ai-target-image alt="">
            <div><strong data-ai-target-name></strong><span data-ai-target-hash></span></div>
            <button class="ai-lab-button" type="button" data-ai-compare>Compare similarity</button>
            <button class="ai-lab-button" type="button" data-ai-current>Current similarity</button>
            <button class="ai-lab-button" type="button" data-ai-describe>Describe / OCR</button>
            <button class="ai-lab-button" type="button" data-ai-mask>Subject mask</button>
          </div>
        </section>
        <section class="ai-lab-section" data-ai-compare-section hidden>
          <div class="ai-lab-section-head"><strong>AI similarity comparison</strong><span>DINOv3 emphasizes visual representation · SigLIP 2 adds semantics</span></div>
          <div class="ai-compare">
            <div class="ai-compare-column"><strong>DINOv3</strong><div class="ai-lab-results" data-ai-dino-results></div></div>
            <div class="ai-compare-column"><strong>SigLIP 2</strong><div class="ai-lab-results" data-ai-siglip-results></div></div>
          </div>
        </section>
        <section class="ai-lab-section" data-ai-description-section hidden>
          <div class="ai-lab-section-head"><strong>AI description</strong><span>Qwen3-VL 2B · cached per content hash</span></div>
          <div class="ai-text-output" data-ai-description></div>
        </section>
        <section class="ai-lab-section" data-ai-mask-section hidden>
          <div class="ai-lab-section-head"><strong>Subject mask</strong><span>SAM · useful foundation for importance-aware compression</span></div>
          <div class="ai-mask-preview"><canvas data-ai-mask-canvas></canvas><div class="ai-text-output" data-ai-mask-copy></div></div>
        </section>
        <section class="ai-lab-section" data-ai-groups-section hidden>
          <div class="ai-lab-section-head"><strong>Suggested groups</strong><span>Preview first; create only the groups you want</span></div>
          <div class="ai-groups" data-ai-groups-list></div>
        </section>
        <section class="ai-lab-section" data-ai-results-section hidden>
          <div class="ai-lab-section-head"><strong data-ai-results-title>Results</strong><span data-ai-results-subtitle></span></div>
          <div class="ai-lab-results" data-ai-results></div>
        </section>
        <div class="ai-empty" data-ai-empty>Semantic search and AI similarity use persistent embeddings keyed by SHA-256. The first use downloads the selected open model; later uses reuse the browser model cache and Mochimono AI index.</div>
      </div>
    </div>`;
  document.body.append(dialog);

  const status = dialog.querySelector('[data-ai-status]');
  const progressWrap = dialog.querySelector('.ai-lab-progress');
  const progressBar = progressWrap.querySelector('i');
  const query = dialog.querySelector('[data-ai-query]');
  const empty = dialog.querySelector('[data-ai-empty]');
  const targetSection = dialog.querySelector('[data-ai-target-section]');
  const targetImage = dialog.querySelector('[data-ai-target-image]');
  const targetNameNode = dialog.querySelector('[data-ai-target-name]');
  const targetHashNode = dialog.querySelector('[data-ai-target-hash]');
  const compareSection = dialog.querySelector('[data-ai-compare-section]');
  const dinoResults = dialog.querySelector('[data-ai-dino-results]');
  const siglipResults = dialog.querySelector('[data-ai-siglip-results]');
  const descriptionSection = dialog.querySelector('[data-ai-description-section]');
  const descriptionNode = dialog.querySelector('[data-ai-description]');
  const maskSection = dialog.querySelector('[data-ai-mask-section]');
  const maskCanvas = dialog.querySelector('[data-ai-mask-canvas]');
  const maskCopy = dialog.querySelector('[data-ai-mask-copy]');
  const groupsSection = dialog.querySelector('[data-ai-groups-section]');
  const groupsList = dialog.querySelector('[data-ai-groups-list]');
  const resultsSection = dialog.querySelector('[data-ai-results-section]');
  const resultsTitle = dialog.querySelector('[data-ai-results-title]');
  const resultsSubtitle = dialog.querySelector('[data-ai-results-subtitle]');
  const resultsNode = dialog.querySelector('[data-ai-results]');

  let controller = null;
  let targetHash = '';
  let targetName = '';
  let fileMap = new Map();
  let groupData = [];

  function viewerHash() { return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || ''; }
  function cancel() { controller?.abort(); controller = null; }
  function begin() {
    cancel();
    controller = new AbortController();
    progressWrap.hidden = false;
    progressBar.style.width = '2%';
    return controller.signal;
  }
  function end(signal = null) {
    if (signal && controller?.signal !== signal) return;
    controller = null;
    progressWrap.hidden = true;
    progressBar.style.width = '0';
  }
  function onProgress(data) {
    const done = Number(data.done) || 0;
    const total = Number(data.total) || 0;
    progressBar.style.width = total > 0 ? `${Math.max(2, Math.min(100, done / total * 100))}%` : '12%';
    status.textContent = data.detail || data.stage || 'Working…';
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  }
  async function refreshFiles() {
    const media = await ai.catalogMedia();
    fileMap = new Map(media.map(file => [file.hash, file]));
    return media;
  }
  async function refreshStatus(note = '') {
    try {
      const state = await ai.status();
      const device = state.webgpu ? 'WebGPU' : 'WASM';
      status.textContent = note || `${device} · ${Number(state.indexed?.siglip2 || 0).toLocaleString()} semantic · ${Number(state.indexed?.dinov3 || 0).toLocaleString()} visual embeddings`;
    } catch { status.textContent = note || 'AI status unavailable'; }
  }
  function fileFor(hash) { return fileMap.get(hash) || { hash, filename:hash, type:'image' }; }
  function resultHtml(items, count = 40) {
    if (!items?.length) return '<div class="ai-empty">No indexed matches.</div>';
    return items.slice(0, count).map(item => {
      const file = fileFor(item.hash);
      return `<button class="ai-result" type="button" data-ai-open="${item.hash}" title="${escapeHtml(file.filename || item.hash)}"><img loading="lazy" src="/api/thumbs/${item.hash}?v=3" alt=""><span>${Number(item.score) || ''}</span><small>${escapeHtml(file.filename || '')}</small></button>`;
    }).join('');
  }
  async function openTarget(hash, name = '') {
    targetHash = String(hash || '');
    targetName = String(name || fileMap.get(targetHash)?.filename || targetHash);
    targetSection.hidden = !targetHash;
    if (!targetHash) return;
    targetImage.src = `/api/thumbs/${targetHash}?v=3`;
    targetNameNode.textContent = targetName;
    targetHashNode.textContent = targetHash;
  }
  async function openLab(hash = '', name = '') {
    await refreshFiles();
    await openTarget(hash, name);
    if (!dialog.open) dialog.showModal();
    empty.hidden = false;
    refreshStatus();
    if (!hash) requestAnimationFrame(() => query.focus());
  }

  async function indexModel(model) {
    const signal = begin();
    try {
      status.textContent = `Preparing ${model}…`;
      const result = await ai.index(model, { signal, onProgress, scope:'all' });
      status.textContent = `${model === 'dinov3' ? 'DINOv3' : 'SigLIP 2'} indexed ${Number(result.indexed || 0).toLocaleString()} files${result.unavailable ? ` · ${result.unavailable} unavailable` : ''}`;
      await refreshStatus(status.textContent);
    } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
    finally { end(signal); }
  }

  async function semanticSearch() {
    const text = query.value.trim();
    if (!text) return;
    const signal = begin();
    resultsSection.hidden = false;
    empty.hidden = true;
    resultsTitle.textContent = `“${text}”`;
    resultsSubtitle.textContent = 'SigLIP 2 semantic image/text retrieval';
    resultsNode.innerHTML = '<div class="ai-empty">Building/searching the semantic index…</div>';
    try {
      const result = await ai.search(text, { signal, onProgress, limit:120 });
      resultsNode.innerHTML = resultHtml(result, 120);
      resultsSubtitle.textContent = `${result.length.toLocaleString()} closest semantic matches`;
      await refreshStatus();
    } catch (error) {
      if (error.name !== 'AbortError') resultsNode.innerHTML = `<div class="ai-empty">${escapeHtml(error.message)}</div>`;
    } finally { end(signal); }
  }

  async function compareSimilarity() {
    if (!targetHash) return;
    const signal = begin();
    empty.hidden = true;
    compareSection.hidden = false;
    dinoResults.innerHTML = '<div class="ai-empty">Indexing DINOv3…</div>';
    siglipResults.innerHTML = '<div class="ai-empty">Waiting…</div>';
    try {
      const dino = await ai.similar(targetHash, 'dinov3', { signal, onProgress, limit:32 });
      dinoResults.innerHTML = resultHtml(dino, 32);
      siglipResults.innerHTML = '<div class="ai-empty">Indexing SigLIP 2…</div>';
      const siglip = await ai.similar(targetHash, 'siglip2', { signal, onProgress, limit:32 });
      siglipResults.innerHTML = resultHtml(siglip, 32);
      status.textContent = 'Similarity comparison ready';
      await refreshStatus(status.textContent);
    } catch (error) {
      if (error.name !== 'AbortError') {
        status.textContent = error.message;
        if (!dinoResults.querySelector('.ai-result')) dinoResults.innerHTML = `<div class="ai-empty">${escapeHtml(error.message)}</div>`;
        if (!siglipResults.querySelector('.ai-result')) siglipResults.innerHTML = `<div class="ai-empty">${escapeHtml(error.message)}</div>`;
      }
    } finally { end(signal); }
  }

  async function describe() {
    if (!targetHash) return;
    const signal = begin();
    empty.hidden = true;
    descriptionSection.hidden = false;
    descriptionNode.textContent = 'Loading Qwen3-VL and reading the file…';
    try {
      const text = await ai.describe(targetHash, '', { signal, onProgress });
      descriptionNode.textContent = text;
      status.textContent = 'AI description cached';
    } catch (error) { if (error.name !== 'AbortError') descriptionNode.textContent = error.message; }
    finally { end(signal); }
  }

  function drawMask(hash, mask) {
    const dims = Array.isArray(mask?.dims) ? mask.dims : [];
    const width = Number(dims.at(-1)) || 0;
    const height = Number(dims.at(-2)) || 0;
    const data = mask?.data;
    if (!width || !height || !data?.length) throw new Error('SAM returned an unsupported mask format.');
    const context = maskCanvas.getContext('2d');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const image = new Image();
    image.onload = () => {
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      for (let index = 0; index < width * height; index++) {
        if (Number(data[index]) <= 0) continue;
        const offset = index * 4;
        pixels.data[offset] = Math.min(255, pixels.data[offset] * .45 + 140);
        pixels.data[offset + 1] = Math.min(255, pixels.data[offset + 1] * .45 + 140);
        pixels.data[offset + 2] = Math.min(255, pixels.data[offset + 2] * .45 + 140);
      }
      context.putImageData(pixels, 0, 0);
    };
    image.src = `/api/thumbs/${hash}?v=3`;
  }

  async function maskSubject() {
    if (!targetHash) return;
    const signal = begin();
    empty.hidden = true;
    maskSection.hidden = false;
    maskCopy.textContent = 'Loading SAM and finding subject masks…';
    try {
      const masks = await ai.masks(targetHash, { signal, onProgress });
      if (!masks?.length) throw new Error('SAM did not return a usable mask for this file.');
      drawMask(targetHash, masks[0]);
      maskCopy.textContent = `${masks.length} mask${masks.length === 1 ? '' : 's'} found. The first mask is previewed here. Mochimono also emits this mask as an experimental event so compression tools can consume it without rerunning SAM.`;
      window.dispatchEvent(new CustomEvent('mochimono:ai-subject-mask', { detail:{ hash:targetHash, masks } }));
      status.textContent = 'Subject mask ready';
    } catch (error) { if (error.name !== 'AbortError') maskCopy.textContent = error.message; }
    finally { end(signal); }
  }

  async function suggestGroups() {
    const signal = begin();
    empty.hidden = true;
    groupsSection.hidden = false;
    groupsList.innerHTML = '<div class="ai-empty">Building semantic groups…</div>';
    try {
      groupData = await ai.groups({ signal, onProgress, limitPerGroup:120 });
      groupsList.innerHTML = groupData.map((group, index) => `<article class="ai-group"><div class="ai-group-head"><strong>${escapeHtml(group.name)}</strong><span>top ${group.matches.length}</span><button class="ai-lab-button" type="button" data-ai-create-group="${index}">Create group</button></div><div class="ai-group-thumbs">${group.matches.slice(0, 12).map(item => `<img loading="lazy" src="/api/thumbs/${item.hash}?v=3" alt="" title="${escapeHtml(fileFor(item.hash).filename || '')}">`).join('')}</div></article>`).join('');
      status.textContent = 'AI group suggestions ready';
    } catch (error) {
      if (error.name !== 'AbortError') groupsList.innerHTML = `<div class="ai-empty">${escapeHtml(error.message)}</div>`;
    } finally { end(signal); }
  }

  async function createGroup(index, button) {
    const group = groupData[Number(index)];
    if (!group?.matches?.length) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Creating…';
    try {
      const response = await fetch('/api/collections', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ name:group.name }) });
      const item = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(item.error || 'Could not create group');
      const hashes = group.matches.map(match => match.hash);
      for (let offset = 0; offset < hashes.length; offset += 1000) {
        const add = await fetch(`/api/collections/${encodeURIComponent(item.id)}/items`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ hashes:hashes.slice(offset, offset + 1000) }) });
        if (!add.ok) {
          const data = await add.json().catch(() => ({}));
          throw new Error(data.error || 'Could not add files to group');
        }
      }
      button.textContent = 'Created';
      window.dispatchEvent(new CustomEvent('mochimono:ai-group-created', { detail:{ id:item.id, name:group.name, hashes } }));
    } catch (error) {
      button.textContent = error.message;
      button.disabled = false;
      setTimeout(() => { if (!button.disabled) button.textContent = original; }, 2200);
    }
  }

  dialog.querySelector('.ai-lab-close').addEventListener('click', () => { cancel(); dialog.close(); });
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', cancel);
  dialog.addEventListener('click', event => { if (event.target === dialog) { cancel(); dialog.close(); } });
  toggle.addEventListener('click', () => openLab('', '').catch(error => { status.textContent = error.message; }));
  viewerAi.addEventListener('click', () => {
    const hash = viewerHash();
    const name = viewerName?.textContent || hash;
    document.querySelector('#viewer-menu')?.removeAttribute('open');
    openLab(hash, name).catch(error => { status.textContent = error.message; });
  });
  dialog.querySelector('[data-ai-search-form]').addEventListener('submit', event => { event.preventDefault(); semanticSearch(); });
  dialog.querySelectorAll('[data-ai-index]').forEach(button => button.addEventListener('click', () => indexModel(button.dataset.aiIndex)));
  dialog.querySelector('[data-ai-groups]').addEventListener('click', suggestGroups);
  dialog.querySelector('[data-ai-compare]').addEventListener('click', compareSimilarity);
  dialog.querySelector('[data-ai-describe]').addEventListener('click', describe);
  dialog.querySelector('[data-ai-mask]').addEventListener('click', maskSubject);
  dialog.querySelector('[data-ai-current]').addEventListener('click', () => {
    if (!targetHash) return;
    const hash = targetHash;
    const name = targetName;
    dialog.close();
    window.mochimonoVisualSimilarity?.find?.(hash, name);
  });
  dialog.addEventListener('click', event => {
    const result = event.target.closest('[data-ai-open]');
    if (result) {
      const hash = result.dataset.aiOpen;
      const file = fileFor(hash);
      dialog.close();
      window.mochimonoOpenViewer?.(hash, file);
      return;
    }
    const create = event.target.closest('[data-ai-create-group]');
    if (create) createGroup(create.dataset.aiCreateGroup, create);
  });

  window.mochimonoAILab = {
    open:openLab,
    compare:(hash, name = '') => openLab(hash, name).then(compareSimilarity),
    search:text => openLab('', '').then(() => { query.value = String(text || ''); return semanticSearch(); })
  };
}
