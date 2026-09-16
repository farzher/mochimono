const storagePane = document.querySelector('#storagePane');

if (storagePane) {
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const origin = `http://${host}:8644`;
  let locations = [];
  let libraryBytes = 0;
  let timer = 0;
  let busy = false;

  const style = document.createElement('style');
  style.textContent = `
    .managed-storage-capacity-note{display:block;margin-top:5px;color:#918784;font-size:10px;line-height:1.3}.managed-storage-capacity-note.partial{color:#bba17d}.managed-storage-capacity-note.low{color:#cb928b}
    .storage-capacity-guidance{padding:9px 10px;border:1px solid #302b2d;border-radius:9px;background:#100f11;color:#8f8682;font-size:10px;line-height:1.5}.storage-capacity-guidance strong{color:#cfc5c1}
  `;
  document.head.append(style);

  function bytes(number) { const units=['B','KB','MB','GB','TB','PB']; let value=Math.max(0,Number(number)||0),unit=0; while(value>=1000&&unit<units.length-1){value/=1000;unit++;} return `${value<10&&unit?value.toFixed(1):Math.round(value)} ${units[unit]}`; }
  async function read(url){const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(response.statusText);return response.json();}
  const byId = id => locations.find(item => String(item.id) === String(id));

  function capacityState(location) {
    if (!location?.online) return null;
    const capacity = Math.max(0, Number(location.capacityBytes) || 0);
    const free = Math.max(0, Number(location.freeBytes) || 0);
    const lowThreshold = Math.min(10 * 1000 ** 3, Math.max(500 * 1000 ** 2, capacity * .03));
    if (location.type === 'cloud') {
      if (free <= lowThreshold) return { tone:'low', short:`Cloud space low · ${bytes(free)} free`, detail:'Cloud folders need room here for their Original copies. Add Cloud capacity or keep new folders Local until space is available.' };
      return null;
    }
    if (!['backup','friend'].includes(location.type)) return null;
    if (free <= lowThreshold) return { tone:'partial', short:`Nearly full · ${bytes(free)} free`, detail:'This storage can still protect the copies that fit. It does not need to hold the whole library; remaining protection work stays for other destinations.' };
    if (libraryBytes && capacity && capacity < libraryBytes) return { tone:'partial', short:`Partial capacity · ${bytes(free)} free`, detail:`This destination is smaller than the ${bytes(libraryBytes)} Cloud library. That is okay: Protection can use it for part of the recovery set and use other destinations for the rest.` };
    if (location.capacityLimited) return { tone:'partial', short:`Partial capacity · ${bytes(free)} free`, detail:'This destination filled the space available to it. Files that did not fit remain visible as protection work for other storage.' };
    return null;
  }

  function decorateCards() {
    for (const card of storagePane.querySelectorAll('.managed-storage-card[data-location-id]')) {
      card.querySelector('[data-capacity-note]')?.remove();
      const location = byId(card.dataset.locationId);
      const state = capacityState(location);
      if (!state) continue;
      const note = document.createElement('span');
      note.dataset.capacityNote = '1';
      note.className = `managed-storage-capacity-note ${state.tone}`;
      note.textContent = state.short;
      note.title = state.detail;
      card.querySelector('.managed-storage-meta')?.after(note);
    }
  }

  function decorateDialog() {
    const dialog = document.querySelector('.storage-location-dialog[open][data-location-id]');
    if (!dialog) return;
    dialog.querySelector('[data-capacity-guidance]')?.remove();
    const location = byId(dialog.dataset.locationId);
    const state = capacityState(location);
    if (!state) return;
    const node = document.createElement('div');
    node.dataset.capacityGuidance = '1';
    node.className = 'storage-capacity-guidance';
    node.innerHTML = `<strong>${state.tone === 'low' ? 'Space needs attention.' : 'Partial storage is supported.'}</strong> ${state.detail}`;
    const actions = dialog.querySelector('.storage-location-actions');
    actions?.before(node);
    if (!actions) dialog.querySelector('.storage-location-inspect')?.append(node);
  }

  function decorate(){decorateCards();decorateDialog();}

  async function refresh() {
    clearTimeout(timer); timer = 0;
    if (busy || document.hidden) return schedule(5000);
    busy = true;
    try {
      const [locationData,state] = await Promise.all([read(`${origin}/local/storage-locations`), read('/api/state')]);
      locations = locationData.locations || [];
      libraryBytes = Number(state?.server?.stats?.bytes) || 0;
      decorate();
    } catch {}
    finally { busy = false; schedule(8000); }
  }
  function schedule(delay=0){clearTimeout(timer);timer=setTimeout(refresh,Math.max(0,delay));}

  new MutationObserver(decorate).observe(storagePane,{childList:true,subtree:true});
  new MutationObserver(decorateDialog).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
  window.addEventListener('focus',()=>schedule(0));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  schedule(500);
}
