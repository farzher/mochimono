import ai from './ai-engine.js';

const viewerMenu = document.querySelector('#viewer-menu > div');
const viewerOpen = document.querySelector('#viewer-open');
const viewerInfoButton = document.querySelector('#viewer-info-button');
const HASH_RE = /^[a-f0-9]{64}$/;
const AI_DB = 'mochimono-ai';
const AI_DB_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const DINO_VERSION = 'dinov3-vitb16-v2';
const SIGLIP_VERSION = 'siglip2-base-224-v2';
const VIS_DB = 'mochimono-visual-similarity';
const VIS_DB_VERSION = 1;
const VIS_STORE = 'fingerprints';
const TEMPLATE_VERSION = 'template12-v1';
const TEMPLATE_DIM = 216;
const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

let pinnedHash = '';
let targetHash = '';
let compareHash = '';
let mediaMap = new Map();
let dinoNeighbors = [];
let siglipNeighbors = [];
let pairState = null;
let generation = 0;
let controller = null;

const style = document.createElement('style');
style.textContent = `
.ai-sim-debug{width:min(1180px,calc(100vw - 24px));height:min(860px,calc(100vh - 24px));padding:0;border:1px solid #3b363b;border-radius:16px;background:#121013;color:#eee8e4;box-shadow:0 30px 100px rgba(0,0,0,.72)}
.ai-sim-debug::backdrop{background:rgba(0,0,0,.72);backdrop-filter:blur(5px)}.ai-sim-debug-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden}.ai-sim-debug-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #292529}.ai-sim-debug-head strong{font-size:12px}.ai-sim-debug-head span{min-width:0;flex:1;color:#81797d;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ai-sim-debug-head button,.ai-sim-debug-button{height:28px;padding:0 9px;border:1px solid #373238;border-radius:8px;background:#211e22;color:#d8cfcb;font-size:9px;font-weight:700}.ai-sim-debug-head button:hover,.ai-sim-debug-button:hover{background:#2b272c;color:#fff}.ai-sim-debug-close{width:29px;padding:0!important;font-size:17px!important}.ai-sim-debug-main{min-height:0;overflow:auto;padding:12px 14px 24px}.ai-sim-debug-note{margin-bottom:10px;padding:8px 10px;border:1px solid #342f34;border-radius:9px;background:#171518;color:#a79e9b;font-size:9px;line-height:1.45}.ai-sim-debug-targets{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:10px}.ai-sim-debug-target{display:grid;grid-template-columns:74px minmax(0,1fr);gap:9px;min-height:74px;padding:8px;border:1px solid #302b30;border-radius:10px;background:#171518}.ai-sim-debug-target img{width:74px;height:74px;object-fit:cover;border-radius:7px;background:#09080a}.ai-sim-debug-target strong,.ai-sim-debug-target span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ai-sim-debug-target strong{font-size:10px}.ai-sim-debug-target span{margin-top:3px;color:#7e7679;font-size:8px}.ai-sim-debug-target .ai-sim-debug-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.ai-sim-debug-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(360px,.9fr);gap:10px}.ai-sim-debug-neighbors{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ai-sim-debug-panel{min-width:0;padding:9px;border:1px solid #302b30;border-radius:10px;background:#151316}.ai-sim-debug-panel>strong{display:block;margin-bottom:7px;font-size:10px}.ai-sim-debug-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.ai-sim-debug-neighbor{position:relative;aspect-ratio:1;border:0;border-radius:6px;overflow:hidden;background:#0b0a0c;padding:0;cursor:pointer}.ai-sim-debug-neighbor img{width:100%;height:100%;object-fit:cover;display:block}.ai-sim-debug-neighbor b{position:absolute;top:3px;right:3px;padding:2px 4px;border-radius:5px;background:rgba(8,7,9,.78);font-size:7px}.ai-sim-debug-neighbor small{position:absolute;left:3px;right:3px;bottom:3px;padding:2px 4px;border-radius:4px;background:rgba(8,7,9,.72);font-size:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ai-sim-debug-neighbor.selected{box-shadow:0 0 0 2px #f0a19b inset}.ai-sim-debug-metrics{display:grid;grid-template-columns:1fr auto;gap:5px 12px;font:9px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace}.ai-sim-debug-metrics dt{color:#9d9491}.ai-sim-debug-metrics dd{margin:0;color:#e3dad6;text-align:right}.ai-sim-debug-diagnosis{margin-top:9px;padding:8px;border-radius:8px;background:#1d191d;color:#c7bebb;font-size:9px;line-height:1.45}.ai-sim-debug-description{margin-top:8px;padding:8px;border:1px solid #302b30;border-radius:8px;background:#121013;color:#bbb1ae;font-size:9px;line-height:1.45;white-space:pre-wrap}.ai-sim-debug-empty{padding:12px;border:1px dashed #332e33;border-radius:8px;color:#746d70;font-size:9px;text-align:center}.ai-sim-debug-status{margin-bottom:8px;color:#8d8481;font-size:9px}.ai-sim-debug-progress{height:3px;margin-bottom:10px;overflow:hidden;border-radius:99px;background:#282429}.ai-sim-debug-progress i{display:block;height:100%;width:0;background:#efa09a;transition:width .1s linear}
@media(max-width:850px){.ai-sim-debug-grid,.ai-sim-debug-targets,.ai-sim-debug-neighbors{grid-template-columns:1fr}.ai-sim-debug-list{grid-template-columns:repeat(5,minmax(0,1fr))}}
`;
document.head.append(style);

const dialog = document.createElement('dialog');
dialog.className = 'ai-sim-debug';
dialog.innerHTML = `
<div class="ai-sim-debug-shell">
  <div class="ai-sim-debug-head"><strong>Similarity inspector</strong><span data-sim-debug-head></span><button type="button" data-sim-debug-copy>Copy report</button><button class="ai-sim-debug-close" type="button" aria-label="Close">×</button></div>
  <div class="ai-sim-debug-main">
    <div class="ai-sim-debug-note">DINO and SigLIP are vector embeddings; they do not contain captions. Qwen3-VL can describe files separately. Current AI <b>Structure</b> sort is DINO mixed with the rich color descriptor, not Mochimono's cached edge/layout fingerprint; this inspector shows the real edge/layout signal too.</div>
    <div class="ai-sim-debug-status" data-sim-debug-status>Idle</div><div class="ai-sim-debug-progress"><i></i></div>
    <div class="ai-sim-debug-targets"><div class="ai-sim-debug-target" data-sim-debug-a></div><div class="ai-sim-debug-target" data-sim-debug-b></div></div>
    <div class="ai-sim-debug-grid">
      <div class="ai-sim-debug-neighbors"><div class="ai-sim-debug-panel"><strong>DINO nearest</strong><div class="ai-sim-debug-list" data-sim-debug-dino></div></div><div class="ai-sim-debug-panel"><strong>SigLIP nearest</strong><div class="ai-sim-debug-list" data-sim-debug-siglip></div></div></div>
      <div class="ai-sim-debug-panel"><strong>Pair diagnostics</strong><div data-sim-debug-pair class="ai-sim-debug-empty">Choose a neighbor, or pin A and reopen the inspector on another image.</div><div data-sim-debug-descriptions></div></div>
    </div>
  </div>
</div>`;
document.body.append(dialog);

const head = dialog.querySelector('[data-sim-debug-head]');
const status = dialog.querySelector('[data-sim-debug-status]');
const progress = dialog.querySelector('.ai-sim-debug-progress i');
const targetA = dialog.querySelector('[data-sim-debug-a]');
const targetB = dialog.querySelector('[data-sim-debug-b]');
const dinoNode = dialog.querySelector('[data-sim-debug-dino]');
const siglipNode = dialog.querySelector('[data-sim-debug-siglip]');
const pairNode = dialog.querySelector('[data-sim-debug-pair]');
const descriptionsNode = dialog.querySelector('[data-sim-debug-descriptions]');

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function currentViewerHash() { return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || ''; }
function fileFor(hash) { return mediaMap.get(hash) || { hash, filename:hash, width:0, height:0, type:'image' }; }
function fmt(value, digits = 4) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'; }
function pct(value) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—'; }
function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function openDb(name, version) { return new Promise((resolve, reject) => { const q = indexedDB.open(name, version); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); }); }

async function visualRow(hash) {
  const db = await openDb(VIS_DB, VIS_DB_VERSION);
  try { return await requestResult(db.transaction(VIS_STORE, 'readonly').objectStore(VIS_STORE).get(hash)); }
  finally { db.close(); }
}

async function embeddingRow(hash, version) {
  const db = await openDb(AI_DB, AI_DB_VERSION);
  try {
    const store = db.transaction(EMBEDDINGS, 'readonly').objectStore(EMBEDDINGS);
    let row = await requestResult(store.get(`${version}:${hash}`));
    if (row) return row;
    const rows = await requestResult(store.index('hash').getAll(hash));
    return (rows || []).find(item => String(item?.model || '') === version) || null;
  } finally { db.close(); }
}

function embeddingCosine(left, right) {
  const a = left?.vector, b = right?.vector;
  if (!a?.length || !b?.length) return null;
  const length = Math.min(a.length, b.length);
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < length; i++) { const x = Number(a[i]) || 0, y = Number(b[i]) || 0; dot += x * y; aa += x * x; bb += y * y; }
  const norm = Math.sqrt((Number(left.normSq) || aa) * (Number(right.normSq) || bb));
  return norm ? dot / norm : null;
}

function hammingHex(left, right) {
  left = String(left || '').toLowerCase(); right = String(right || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return null;
  let total = 0;
  for (let i = 0; i < 16; i++) total += POPCOUNT16[parseInt(left.slice(i * 4, i * 4 + 4), 16) ^ parseInt(right.slice(i * 4, i * 4 + 4), 16)];
  return total;
}

function cosineDistance(left, right) {
  if (!left?.length || !right?.length || left.length !== right.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < left.length; i++) { const x = Number(left[i]) || 0, y = Number(right[i]) || 0; dot += x * y; aa += x * x; bb += y * y; }
  const norm = Math.sqrt(aa * bb);
  return norm ? Math.max(0, 1 - dot / norm) : null;
}

function rms(left, right, indexes = null) {
  if (!left?.length || !right?.length || left.length !== right.length) return null;
  let sum = 0, count = 0;
  if (indexes) {
    for (const i of indexes) { const d = ((Number(left[i]) || 0) - (Number(right[i]) || 0)) / 255; sum += d * d; count++; }
  } else {
    for (let i = 0; i < left.length; i++) { const d = ((Number(left[i]) || 0) - (Number(right[i]) || 0)) / 255; sum += d * d; count++; }
  }
  return count ? Math.sqrt(sum / count) : null;
}

function templateDistance(leftRow, rightRow) {
  const a = leftRow?.experimentalTemplateVersion === TEMPLATE_VERSION && leftRow.experimentalTemplate?.length === TEMPLATE_DIM ? leftRow.experimentalTemplate : null;
  const b = rightRow?.experimentalTemplateVersion === TEMPLATE_VERSION && rightRow.experimentalTemplate?.length === TEMPLATE_DIM ? rightRow.experimentalTemplate : null;
  if (!a || !b) return null;
  let meanA = 0, meanB = 0;
  for (let i = 0; i < 144; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= 144; meanB /= 144;
  let luma = 0, chroma = 0;
  for (let i = 0; i < 144; i++) { const d = ((a[i] - meanA) - (b[i] - meanB)) / 255; luma += d * d; }
  for (let i = 144; i < TEMPLATE_DIM; i++) { const d = (a[i] - b[i]) / 255; chroma += d * d; }
  return Math.sqrt(luma / 144) * .65 + Math.sqrt(chroma / (TEMPLATE_DIM - 144)) * .25 + Math.abs(meanA - meanB) / 255 * .10;
}

function visualMetrics(leftRow, rightRow) {
  const lf = leftRow?.visualFeature, rf = rightRow?.visualFeature;
  const layoutL = lf?.layout?.length === 48 && rf?.layout?.length === 48 ? rms(lf.layout, rf.layout, Array.from({ length:16 }, (_, i) => i * 3)) : null;
  const layoutAB = lf?.layout?.length === 48 && rf?.layout?.length === 48 ? rms(lf.layout, rf.layout, Array.from({ length:32 }, (_, i) => Math.floor(i / 2) * 3 + 1 + (i % 2))) : null;
  const edges = lf?.edges?.length === 64 && rf?.edges?.length === 64 ? rms(lf.edges, rf.edges) : null;
  const energy = lf?.energy?.length === 16 && rf?.energy?.length === 16 ? rms(lf.energy, rf.energy) : null;
  const hues = lf?.hues?.length === 24 && rf?.hues?.length === 24 ? cosineDistance(lf.hues, rf.hues) : null;
  const stats = lf && rf ? ([['meanLuma',255],['contrast',255],['colorfulness',255],['edgeDensity',255]].reduce((sum,[key,scale]) => sum + Math.abs((Number(lf[key]) || 0) - (Number(rf[key]) || 0)) / scale, 0) / 4) : null;
  const parts = [[layoutL,.22],[layoutAB,.12],[edges,.28],[energy,.18],[stats,.12],[hues,.08]].filter(([v]) => Number.isFinite(v));
  const structure = parts.length ? parts.reduce((sum,[v,w]) => sum + v * w, 0) / parts.reduce((sum,[,w]) => sum + w, 0) : null;
  const color = cosineDistance(leftRow?.aiColorFlow?.v, rightRow?.aiColorFlow?.v);
  const hueA = Number(leftRow?.aiColorFlow?.h ?? leftRow?.visualColor?.dominantHue);
  const hueB = Number(rightRow?.aiColorFlow?.h ?? rightRow?.visualColor?.dominantHue);
  let hueDelta = Number.isFinite(hueA) && Number.isFinite(hueB) ? Math.abs(hueA - hueB) : null;
  if (hueDelta != null) hueDelta = Math.min(hueDelta, 1 - hueDelta);
  return { layoutL, layoutAB, edges, energy, hues, stats, structure, color, hueDelta, phash:hammingHex(leftRow?.robust, rightRow?.robust), template:templateDistance(leftRow, rightRow) };
}

function currentOrder() {
  const aiOrder = window.mochimonoAIGlobalSort?.orderedHashes?.();
  if (Array.isArray(aiOrder)?.length) return aiOrder;
  return (window.mochimonoGridModel?.items || []).map(item => String(item?.[0] || '')).filter(HASH_RE.test.bind(HASH_RE));
}

function rankOf(items, hash) {
  const index = (items || []).findIndex(item => item.hash === hash);
  return index >= 0 ? index + 1 : null;
}

function neighborScore(items, hash) { return (items || []).find(item => item.hash === hash)?.score ?? null; }

function targetHtml(hash, label) {
  if (!hash) return `<div class="ai-sim-debug-empty">${label}: none</div>`;
  const file = fileFor(hash);
  const pinned = pinnedHash === hash;
  return `<img src="/api/thumbs/${hash}?v=3" alt=""><div><strong>${label} · ${escapeHtml(file.filename || hash)}</strong><span>${hash.slice(0,16)}… · ${file.width || '?'}×${file.height || '?'}</span><div class="ai-sim-debug-actions"><button class="ai-sim-debug-button" type="button" data-sim-debug-pin="${hash}">${pinned ? 'Pinned A' : 'Pin as A'}</button>${label === 'B' ? `<button class="ai-sim-debug-button" type="button" data-sim-debug-open="${hash}">Open B</button>` : ''}<button class="ai-sim-debug-button" type="button" data-sim-debug-describe="${label}">Describe ${label}</button></div></div>`;
}

function renderTargets() {
  targetA.innerHTML = targetHtml(targetHash, 'A');
  targetB.innerHTML = compareHash ? targetHtml(compareHash, 'B') : '<div class="ai-sim-debug-empty">B: choose a neighbor, or pin A and inspect another file.</div>';
}

function neighborHtml(items, kind) {
  const order = currentOrder(), positions = new Map(order.map((hash,index) => [hash,index])), aPos = positions.get(targetHash);
  const filtered = (items || []).filter(item => item.hash !== targetHash).slice(0, 28);
  if (!filtered.length) return '<div class="ai-sim-debug-empty">No indexed neighbors.</div>';
  return filtered.map((item, index) => {
    const file = fileFor(item.hash), pos = positions.get(item.hash), gap = aPos != null && pos != null ? Math.abs(pos - aPos) : null;
    return `<button type="button" class="ai-sim-debug-neighbor${compareHash===item.hash?' selected':''}" data-sim-debug-neighbor="${item.hash}" data-kind="${kind}" title="${escapeHtml(file.filename || item.hash)}"><img loading="lazy" src="/api/thumbs/${item.hash}?v=3" alt=""><b>#${index+1} · ${Number(item.score)||0}</b><small>${gap!=null?`gap ${gap.toLocaleString()} · `:''}${escapeHtml(file.filename || '')}</small></button>`;
  }).join('');
}

function renderNeighbors() {
  dinoNode.innerHTML = neighborHtml(dinoNeighbors, 'dino');
  siglipNode.innerHTML = neighborHtml(siglipNeighbors, 'siglip');
}

function diagnosisText(state) {
  if (!state) return '';
  const { orderGap, dinoRank, siglipRank, dinoCosine, visual } = state;
  const notes = [];
  if (orderGap != null && orderGap > 24 && dinoRank != null && dinoRank <= 12) notes.push(`DINO already considers B a top-${dinoRank} neighbor, but the current order puts it ${orderGap.toLocaleString()} positions away. That points at the routing/sort algorithm, not the embedding.`);
  if (orderGap != null && orderGap > 24 && Number.isFinite(visual?.structure) && visual.structure < .11) notes.push(`The cached edge/layout fingerprint also considers the pair structurally close (${visual.structure.toFixed(4)}), so the current Structure mode is wasting a useful signal.`);
  if (Number.isFinite(visual?.template) && visual.template < .06 && (dinoRank == null || dinoRank > 20)) notes.push(`The aligned template sees a very strong match (${visual.template.toFixed(4)}) that DINO does not rank highly. This is a descriptor disagreement rather than only an ordering problem.`);
  if (Number.isFinite(dinoCosine) && dinoCosine < .55 && Number.isFinite(visual?.structure) && visual.structure < .1) notes.push('DINO is relatively insensitive to this pair even though their screen/layout structure is close; a screenshot-specific structural signal should carry more weight.');
  if (!notes.length) notes.push('No single signal is obviously failing from these thresholds. Compare the raw metrics and nearest-neighbor ranks; the report is designed to make the next algorithm change evidence-based.');
  return notes.join(' ');
}

async function inspectPair(hash) {
  compareHash = String(hash || '');
  if (!HASH_RE.test(compareHash) || compareHash === targetHash) { compareHash = ''; pairState = null; renderTargets(); renderNeighbors(); pairNode.innerHTML = '<div class="ai-sim-debug-empty">Choose another image.</div>'; return; }
  renderTargets(); renderNeighbors();
  pairNode.innerHTML = '<div class="ai-sim-debug-empty">Reading exact descriptors…</div>';
  descriptionsNode.innerHTML = '';
  const mine = generation;
  const [leftRow,rightRow,dinoA,dinoB,sigA,sigB] = await Promise.all([
    visualRow(targetHash), visualRow(compareHash), embeddingRow(targetHash,DINO_VERSION), embeddingRow(compareHash,DINO_VERSION), embeddingRow(targetHash,SIGLIP_VERSION), embeddingRow(compareHash,SIGLIP_VERSION)
  ]);
  if (mine !== generation) return;
  const order = currentOrder(), positions = new Map(order.map((value,index)=>[value,index])), leftPos = positions.get(targetHash), rightPos = positions.get(compareHash);
  const leftFile = fileFor(targetHash), rightFile = fileFor(compareHash);
  const visual = visualMetrics(leftRow,rightRow);
  const state = {
    a:targetHash,b:compareHash,
    orderGap:leftPos!=null&&rightPos!=null?Math.abs(leftPos-rightPos):null,
    aPosition:leftPos??null,bPosition:rightPos??null,
    dinoRank:rankOf(dinoNeighbors,compareHash),siglipRank:rankOf(siglipNeighbors,compareHash),
    dinoListScore:neighborScore(dinoNeighbors,compareHash),siglipListScore:neighborScore(siglipNeighbors,compareHash),
    dinoCosine:embeddingCosine(dinoA,dinoB),siglipCosine:embeddingCosine(sigA,sigB),
    aspectDistance:leftFile.width&&leftFile.height&&rightFile.width&&rightFile.height?Math.abs(Math.log2((leftFile.width/leftFile.height)/(rightFile.width/rightFile.height))):null,
    visual
  };
  pairState = state;
  const rows = [
    ['Current order gap', state.orderGap == null ? '—' : `${state.orderGap.toLocaleString()} positions`],
    ['DINO nearest rank', state.dinoRank == null ? '> 60 / not returned' : `#${state.dinoRank}`],
    ['DINO exact cosine', fmt(state.dinoCosine)],
    ['DINO list score', state.dinoListScore ?? '—'],
    ['SigLIP nearest rank', state.siglipRank == null ? '> 60 / not returned' : `#${state.siglipRank}`],
    ['SigLIP exact cosine', fmt(state.siglipCosine)],
    ['SigLIP list score', state.siglipListScore ?? '—'],
    ['Robust pHash', visual.phash == null ? '—' : `${visual.phash} / 256 bits`],
    ['Aligned template distance', fmt(visual.template)],
    ['Real structure composite', fmt(visual.structure)],
    ['Layout luma RMS', fmt(visual.layoutL)],
    ['Layout color RMS', fmt(visual.layoutAB)],
    ['Edge orientation RMS', fmt(visual.edges)],
    ['Edge energy RMS', fmt(visual.energy)],
    ['Hue histogram distance', fmt(visual.hues)],
    ['Rich color distance', fmt(visual.color)],
    ['Hue delta', visual.hueDelta == null ? '—' : pct(visual.hueDelta)],
    ['Aspect log2 distance', fmt(state.aspectDistance)]
  ];
  pairNode.className = '';
  pairNode.innerHTML = `<dl class="ai-sim-debug-metrics">${rows.map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl><div class="ai-sim-debug-diagnosis">${escapeHtml(diagnosisText(state))}</div>`;
}

function onProgress(data) {
  const done = Number(data.done) || 0, total = Number(data.total) || 0;
  progress.style.width = total ? `${Math.max(2, Math.min(100, done / total * 100))}%` : '12%';
  status.textContent = data.detail || data.stage || 'Working…';
}

async function loadNeighbors() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal, mine = generation;
  progress.style.width = '2%';
  dinoNode.innerHTML = '<div class="ai-sim-debug-empty">Reading DINO neighbors…</div>';
  siglipNode.innerHTML = '<div class="ai-sim-debug-empty">Waiting…</div>';
  try {
    dinoNeighbors = await ai.similar(targetHash, 'dinov3', { signal, onProgress, limit:60 });
    if (mine !== generation) return;
    renderNeighbors();
    siglipNode.innerHTML = '<div class="ai-sim-debug-empty">Reading SigLIP neighbors…</div>';
    siglipNeighbors = await ai.similar(targetHash, 'siglip2', { signal, onProgress, limit:60 });
    if (mine !== generation) return;
    renderNeighbors();
    status.textContent = `Ready · ${dinoNeighbors.length} DINO · ${siglipNeighbors.length} SigLIP neighbors`;
    progress.style.width = '100%';
    setTimeout(() => { if (mine === generation) progress.style.width = '0'; }, 300);
    if (compareHash) await inspectPair(compareHash);
  } catch (error) {
    if (error.name !== 'AbortError' && mine === generation) status.textContent = error.message || String(error);
  }
}

async function describe(label) {
  const hash = label === 'B' ? compareHash : targetHash;
  if (!hash) return;
  status.textContent = `Describing ${label} with Qwen3-VL…`;
  try {
    const text = await ai.describe(hash, '', { onProgress });
    const existing = descriptionsNode.querySelector(`[data-description="${label}"]`);
    const html = `<div class="ai-sim-debug-description" data-description="${label}"><b>${label} · Qwen3-VL</b>\n${escapeHtml(text)}</div>`;
    if (existing) existing.outerHTML = html; else descriptionsNode.insertAdjacentHTML('beforeend', html);
    status.textContent = `Qwen description ${label} ready`;
  } catch (error) { status.textContent = error.message || String(error); }
}

async function refreshMedia() {
  const media = await ai.catalogMedia();
  mediaMap = new Map(media.map(file => [file.hash,file]));
}

async function openInspector(currentHash = currentViewerHash()) {
  currentHash = String(currentHash || '');
  if (!HASH_RE.test(currentHash)) return;
  generation++;
  controller?.abort();
  await refreshMedia();
  if (pinnedHash && pinnedHash !== currentHash) { targetHash = pinnedHash; compareHash = currentHash; }
  else { targetHash = currentHash; compareHash = ''; }
  dinoNeighbors = []; siglipNeighbors = []; pairState = null; descriptionsNode.innerHTML = '';
  const mode = window.mochimonoAIGlobalSort?.mode?.();
  head.textContent = `${mode ? `AI ${mode} · ` : ''}${fileFor(targetHash).filename || targetHash}`;
  renderTargets(); renderNeighbors();
  pairNode.className = 'ai-sim-debug-empty';
  pairNode.textContent = compareHash ? 'Reading pair diagnostics…' : 'Choose a neighbor, or pin A and reopen the inspector on another image.';
  dialog.showModal();
  loadNeighbors();
  if (compareHash) inspectPair(compareHash).catch(error => { pairNode.textContent = error.message || String(error); });
}

function copyReport() {
  const report = {
    target:fileFor(targetHash), compare:compareHash ? fileFor(compareHash) : null,
    mode:window.mochimonoAIGlobalSort?.mode?.() || String(window.mochimonoGridModel?.sort || ''),
    pair:pairState,
    dinoTop:dinoNeighbors.slice(0,12), siglipTop:siglipNeighbors.slice(0,12),
    note:'Structure AI sort currently mixes DINO with the rich color descriptor; visual.structure above is calculated from Mochimono visualFeature layout/edges/energy/hues.'
  };
  navigator.clipboard.writeText(JSON.stringify(report,null,2)).then(()=>{status.textContent='Debug report copied';}).catch(()=>{});
}

if (viewerMenu) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'viewer-menu-action';
  button.textContent = 'Similarity inspector';
  button.title = 'Inspect AI and visual similarity signals for this file';
  viewerMenu.insertBefore(button, viewerInfoButton || viewerMenu.firstChild);
  button.addEventListener('click', () => openInspector());
}

dialog.querySelector('.ai-sim-debug-close').addEventListener('click', () => dialog.close());
dialog.querySelector('[data-sim-debug-copy]').addEventListener('click', copyReport);
dialog.addEventListener('click', event => {
  const neighbor = event.target.closest('[data-sim-debug-neighbor]');
  if (neighbor) { inspectPair(neighbor.dataset.simDebugNeighbor).catch(error => { pairNode.textContent = error.message || String(error); }); return; }
  const pin = event.target.closest('[data-sim-debug-pin]');
  if (pin) { pinnedHash = pin.dataset.simDebugPin === pinnedHash ? '' : pin.dataset.simDebugPin; renderTargets(); status.textContent = pinnedHash ? 'A pinned · close inspector, open another image, then inspect again' : 'Pin cleared'; return; }
  const open = event.target.closest('[data-sim-debug-open]');
  if (open) { window.mochimonoOpenViewer?.(open.dataset.simDebugOpen, fileFor(open.dataset.simDebugOpen)); return; }
  const describeButton = event.target.closest('[data-sim-debug-describe]');
  if (describeButton) describe(describeButton.dataset.simDebugDescribe);
});
dialog.addEventListener('close', () => { generation++; controller?.abort(); controller = null; });

window.mochimonoSimilarityInspector = { open:openInspector, pinned:()=>pinnedHash, clearPin:()=>{pinnedHash='';} };
