const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerClose = document.querySelector('#viewer-close');
const panel = document.querySelector('#viewerInfo');
const LEVELS = [
  ['inherit', 'Inherit'],
  ['disposable', 'One copy'],
  ['normal', 'Standard'],
  ['important', 'Important'],
  ['critical', 'Critical']
];
const LEVEL_HINTS = {
  disposable: '1 copy',
  normal: '2 copies · 2 devices',
  important: '3 copies · remote',
  critical: '3 devices · 2 places'
};
let generation = 0;
let decorating = false;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
const currentHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';

function age(value) {
  const time = new Date(value || 0).getTime();
  if (!time) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type':'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { data, status:response.status });
  return data;
}

async function enrichManagedCopies(state, hash) {
  const copies = await Promise.all((state?.copies || []).map(async copy => {
    if (copy.representation === 'compact' || !copy.id || !['backup','peer'].includes(copy.kind)) return copy;
    try {
      const replica = await jsonRequest(`/api/drives/${encodeURIComponent(copy.id)}/files/${hash}`);
      return { ...copy, verifiedAt: replica.verifiedAt || null, lastSeen: replica.lastSeen || null };
    } catch {
      return copy;
    }
  }));
  return { ...state, copies };
}

function protectionLabel(state) {
  if (!state) return '';
  const known = Number(state.status?.copies) || 0;
  const qualifying = Number(state.status?.qualifyingCopies ?? state.status?.verified) || 0;
  const parts = [`${known} known ${known === 1 ? 'copy' : 'copies'}`];
  if (qualifying !== known) parts.push(`${qualifying} count toward target`);
  parts.push(`${state.status?.devices || 0} ${state.status?.devices === 1 ? 'device' : 'devices'}`);
  parts.push(`${state.status?.sites || 0} ${state.status?.sites === 1 ? 'place' : 'places'}`);
  if (state.status?.remote) parts.push(`${state.status.remote} remote`);
  if (state.status?.reducedFidelity) parts.push(`${state.status.reducedFidelity} Squished`);
  return parts.join(' · ');
}

function missingLabel(state) {
  if (state?.meets) return 'Protection target met';
  const missing = [];
  if (state?.missing?.copies) missing.push(`${state.missing.copies} more verified ${state.missing.copies === 1 ? 'copy' : 'copies'}`);
  if (state?.missing?.originals) missing.push('an Original copy');
  if (state?.missing?.devices) missing.push(`${state.missing.devices} more ${state.missing.devices === 1 ? 'device' : 'devices'}`);
  if (state?.missing?.remote) missing.push('remote copy');
  if (state?.missing?.sites) missing.push(`${state.missing.sites} more ${state.missing.sites === 1 ? 'place' : 'places'}`);
  return missing.length ? `Needs ${missing.join(' · ')}` : 'Needs protection';
}

function copyDescription(copy) {
  const parts = [
    copy.kind === 'peer' ? 'Encrypted remote' : copy.kind === 'primary' ? 'Mochimono storage' : copy.kind === 'source' ? 'Local source' : 'Backup',
    copy.representation === 'compact' ? 'Squished recovery' : 'Original'
  ];
  if (copy.site && copy.site !== copy.name) parts.push(copy.site);
  if (copy.kind === 'source') {
    if (copy.verifiedAt) parts.push(`seen ${age(copy.verifiedAt)}`);
    else parts.push('known source');
  } else if (!copy.verified) parts.push('not verified');
  else if (copy.verifiedAt) parts.push(`verified ${age(copy.verifiedAt)}`);
  else parts.push('verified');
  if (copy.reliability === 'low') parts.push('does not count toward protection');
  if (copy.lastSeen) parts.push(`server last heard ${age(copy.lastSeen)}`);
  return parts.join(' · ');
}

function sectionHtml(state, hash) {
  const lifecycle=String(state?.lifecycle||'current');
  const pending=state?.protectionState==='pending'||state?.protectionState==='preparing';
  const unlinked=lifecycle==='unlinked';
  const remoteOnly=lifecycle==='remote-only';
  const selected = state.overrideLevel || 'inherit';
  const options = LEVELS.map(([value,label]) => {
    const suffix = value === 'inherit' ? ` (${state.level||'normal'})` : ` · ${LEVEL_HINTS[value] || ''}`;
    return `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}${suffix}</option>`;
  }).join('');
  const copyCards = (state.copies || []).map(copy => `<div class="protection-copy-row">
    <span>${esc(copy.name || copy.deviceName || copy.kind)}</span>
    <small>${esc(copyDescription(copy))}</small>
  </div>`).join('');
  const badge=unlinked?'Needs review':pending?'Backing up':state.meets?(remoteOnly?'Remote only':'Protected'):'Needs backup';
  const badgeClass=unlinked||pending||!state.meets?'warn':'good';

  if(unlinked)return `<section class="viewer-info-section protection-detail" data-protection-section data-hash="${hash}">
    <div class="viewer-section-head"><h3>Backup</h3><span class="protection-state warn">Needs review</span></div>
    <div class="protection-detail-summary"><strong>No current source</strong><span>This file is still stored by Mochimono. Keep it as remote only or delete it normally.</span></div>
    <div class="protection-copy-list">${copyCards || '<div class="viewer-info-empty">No known copy location.</div>'}</div>
    <div class="protection-review-actions"><button type="button" data-keep-remote>Keep remote only</button></div>
    <div class="protection-action-status" data-protection-status></div>
  </section>`;

  return `<section class="viewer-info-section protection-detail" data-protection-section data-hash="${hash}">
    <div class="viewer-section-head"><h3>Backup</h3><span class="protection-state ${badgeClass}">${badge}</span></div>
    <div class="protection-detail-summary"><strong>${pending?'Waiting for Mochimono storage':esc(protectionLabel(state))}</strong><span>${remoteOnly?'No local source · '+missingLabel(state):pending?'Mochimono is preparing or uploading this file.':esc(missingLabel(state))}</span></div>
    ${pending?'':`<label class="protection-level-field"><span>Protection</span><select data-file-protection>${options}</select></label>`}
    <div class="protection-copy-list">${copyCards || '<div class="viewer-info-empty">No known copies yet.</div>'}</div>
    <div class="protection-action-status" data-protection-status></div>
  </section>`;
}

async function decorateDetails() {
  if (decorating || !panel || panel.hidden) return;
  if (window.mochimonoViewerPerformance?.defer?.(decorateDetails)) return;
  const hash = currentHash();
  if (!hash || panel.querySelector(`[data-protection-section][data-hash="${hash}"]`)) return;
  const mine = ++generation;
  decorating = true;
  try {
    const state = await enrichManagedCopies(await jsonRequest(`/api/protection/objects/${hash}`), hash);
    if (mine !== generation || hash !== currentHash() || panel.hidden) return;
    const details = [...panel.querySelectorAll(':scope > .viewer-info-section')].find(section => section.querySelector('h3')?.textContent.trim() === 'Details');
    details?.insertAdjacentHTML('beforebegin', sectionHtml(state, hash));
    if (!details) panel.insertAdjacentHTML('beforeend', sectionHtml(state, hash));
  } catch {
    const file=window.mochimonoLibrary?.file?.(hash);
    if(mine===generation&&hash===currentHash()&&!panel.hidden&&file?.backupIntent){
      const state={ lifecycle:'current',protectionState:file.protectionState||'pending',level:file.protectionLevel||'normal',meets:false,copies:[],status:{},missing:{} };
      const details=[...panel.querySelectorAll(':scope > .viewer-info-section')].find(section=>section.querySelector('h3')?.textContent.trim()==='Details');
      details?.insertAdjacentHTML('beforebegin',sectionHtml(state,hash));
      if(!details)panel.insertAdjacentHTML('beforeend',sectionHtml(state,hash));
    }
  }
  finally { decorating = false; }
}

async function updateLevel(select) {
  const section = select.closest('[data-protection-section]');
  const hash = section?.dataset.hash;
  if (!hash) return;
  select.disabled = true;
  const status = section.querySelector('[data-protection-status]');
  try {
    const state = await enrichManagedCopies(await jsonRequest(`/api/protection/objects/${hash}/level`, {
      method:'POST', body:JSON.stringify({ level:select.value })
    }), hash);
    section.outerHTML = sectionHtml(state, hash);
    window.dispatchEvent(new CustomEvent('mochimono:protection-changed', { detail:{ hash,state } }));
  } catch (error) {
    select.disabled = false;
    if (status) status.textContent = error.message;
  }
}

function selectedHashes() {
  const exact = window.mochimonoSelection?.hashes?.();
  if (Array.isArray(exact)) return [...new Set(exact)];
  return [...new Set([...document.querySelectorAll('#files .selected[data-hash]')].map(item => item.dataset.hash))];
}

async function trash(hashes, ignore, source) {
  hashes = [...new Set((hashes || []).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!hashes.length) return;
  const noun = hashes.length === 1 ? 'file' : 'files';
  if (!confirm(`Move ${hashes.length.toLocaleString()} ${noun} to Mochimono Trash?\n\nNo file data is destroyed until you permanently delete it from Trash.`)) return;
  try {
    await jsonRequest('/api/protection/trash', { method:'POST', body:JSON.stringify({ hashes,ignore }) });
    window.mochimonoLibrary?.remove?.(hashes);
    window.mochimonoLocations?.refresh?.();
    if (source === 'viewer') viewerClose?.click();
    else window.mochimonoSelection?.clear?.();
  } catch (error) { alert(error.message); }
}

function interceptDelete(event) {
  const target = event.target.closest?.('#delete,#delete-ignore,#selectionDelete,#selectionIgnore');
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const viewerDelete = target.id === 'delete' || target.id === 'delete-ignore';
  const hashes = viewerDelete ? [currentHash()] : selectedHashes();
  trash(hashes, target.id === 'delete-ignore' || target.id === 'selectionIgnore', viewerDelete ? 'viewer' : 'selection');
}

async function keepRemote(button) {
  const section=button.closest('[data-protection-section]');
  const hash=section?.dataset.hash;
  if(!hash)return;
  button.disabled=true;
  const status=section.querySelector('[data-protection-status]');
  try{
    await jsonRequest('/api/protection/lifecycle',{method:'POST',body:JSON.stringify({hashes:[hash],mode:'remote-only'})});
    const state=await enrichManagedCopies(await jsonRequest(`/api/protection/objects/${hash}`),hash);
    section.outerHTML=sectionHtml(state,hash);
    await window.mochimonoLibrary?.refresh?.();
    window.dispatchEvent(new CustomEvent('mochimono:protection-changed',{detail:{hash,state}}));
  }catch(error){
    button.disabled=false;
    if(status)status.textContent=error.message;
  }
}

panel?.addEventListener('click',event=>{
  const button=event.target.closest('[data-keep-remote]');
  if(button)keepRemote(button);
});

panel?.addEventListener('change', event => {
  const select = event.target.closest('[data-file-protection]');
  if (select) updateLevel(select);
});
document.addEventListener('click', interceptDelete, true);
if (panel) new MutationObserver(() => queueMicrotask(decorateDetails)).observe(panel, { childList:true,subtree:true });
window.addEventListener('mochimono:viewer-opened', () => { generation++; queueMicrotask(decorateDetails); });
viewerOpen?.addEventListener('click', () => setTimeout(decorateDetails));
