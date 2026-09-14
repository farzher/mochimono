const tagsApi = window.mochimonoTags;
const scanner = window.mochimonoSensitiveScan;
const manager = document.querySelector('.tag-manager');
const editor = manager?.querySelector('.tag-editor');
const list = manager?.querySelector('.tag-list');
const viewerTags = document.querySelector('#viewerTags');

if (tagsApi && scanner && manager && editor && list) {
  const style = document.createElement('style');
  style.textContent = `
    .sensitive-editor{display:grid;gap:10px}.sensitive-head{display:flex;align-items:center;gap:12px;padding:2px 0 4px}.sensitive-head-main{min-width:0}.sensitive-head-title{display:flex;align-items:center;gap:7px}.sensitive-head h2{margin:0;color:#eee8e4;font:760 16px/1.2 system-ui}.sensitive-built-in{padding:3px 6px;border-radius:999px;background:#32272a;color:#d6a9a1;font:800 8px/1 system-ui;text-transform:uppercase;letter-spacing:.05em}.sensitive-head p{margin:4px 0 0;color:#817976;font:10px/1.35 system-ui}.sensitive-head>button{margin-left:auto;height:34px;padding:0 12px;background:#eee8e4;color:#171416}
    .sensitive-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.sensitive-stat{padding:9px 10px;border:1px solid rgba(255,255,255,.065);border-radius:9px;background:#111012}.sensitive-stat strong{display:block;color:#ddd5d1;font:760 14px/1 system-ui}.sensitive-stat span{display:block;margin-top:4px;color:#7f7774;font:9px/1 system-ui}
    .sensitive-control{display:grid;gap:7px;padding:10px;border:1px solid rgba(255,255,255,.065);border-radius:9px;background:#111012}.sensitive-control-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#bcb3af;font:700 10px/1 system-ui}.sensitive-control-head b{color:#eee8e4;font-size:11px}.sensitive-control input[type=range]{width:100%;height:auto;padding:0;accent-color:#d7cbc7}.sensitive-control small{color:#756e6b;font:9px/1.35 system-ui}.sensitive-actions{display:flex;flex-wrap:wrap;gap:6px}.sensitive-actions button{height:31px;padding:0 10px}.sensitive-actions .subtle{background:#211e22;color:#a99f9b}
    .sensitive-editor .tag-review{margin-top:0}.sensitive-editor .tag-review-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}.sensitive-editor .tag-review-thumb{aspect-ratio:4/3;padding:5px;box-sizing:border-box}.sensitive-editor .tag-review-thumb img{object-fit:contain}.tag-review-badge.detected{background:rgba(70,47,55,.94);color:#edc0b8}.tag-review-badge.excluded{background:rgba(48,45,50,.94);color:#bbb2b0}.tag-review-actions button[data-sensitive-action="exclude"]{color:#d9aaa8}.tag-review-actions button[data-sensitive-action="manual"],.tag-review-actions button[data-sensitive-action="mark"]{color:#b8ceb7}
    @media(max-width:650px){.sensitive-head{align-items:flex-start;flex-wrap:wrap}.sensitive-head>button{margin-left:0}.sensitive-stats{grid-template-columns:repeat(3,1fr)}.sensitive-editor .tag-review-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;
  document.head.append(style);

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
  })[character]);

  let mode = 'detected';
  let generation = 0;
  let queued = false;

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      cache:'no-store',
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
      body:options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function activeTag() {
    const id = String(list.querySelector('[data-manage-tag].active')?.dataset.manageTag || '');
    return tagsApi.tags().find(tag => String(tag.id) === id) || null;
  }

  function isSensitive(tag) {
    return Boolean(tag?.builtin && String(tag.name || '').toLowerCase() === 'sensitive');
  }

  function negativeHashes(state) {
    return new Set((state?.examples || [])
      .filter(item => Number(item.polarity) === -1)
      .map(item => String(item.hash)));
  }

  function selectedHashes() {
    const selected = window.mochimonoSelection?.hashes?.() || [];
    if (selected.length) return [...new Set(selected.map(String))];
    const hash = document.querySelector('#viewer-open')?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
    return hash ? [hash] : [];
  }

  async function writeExclusions(tagId, negative) {
    await requestJson(`/api/tags/${tagId}/examples`, {
      method:'POST',
      body:{ positive:[], negative:[...negative] }
    });
  }

  async function exclude(tagId, hash) {
    const state = await requestJson(`/api/tags/${tagId}`);
    const negative = negativeHashes(state);
    negative.add(hash);
    await writeExclusions(tagId, negative);
  }

  async function allow(tagId, hash) {
    const state = await requestJson(`/api/tags/${tagId}`);
    const negative = negativeHashes(state);
    negative.delete(hash);
    await writeExclusions(tagId, negative);
  }

  async function markManual(tagId, hashes) {
    if (!hashes.length) return;
    const state = await requestJson(`/api/tags/${tagId}`);
    const negative = negativeHashes(state);
    for (const hash of hashes) negative.delete(hash);
    await requestJson(`/api/tags/${tagId}/members`, { method:'POST', body:{ hashes, source:'manual' } });
    // Sensitive is not trained from positive examples. Strip the generic tag
    // system's automatic positive-example side effect while keeping exclusions.
    await writeExclusions(tagId, negative);
  }

  async function removeManual(tagId, hash) {
    await requestJson(`/api/tags/${tagId}/remove`, { method:'POST', body:{ hashes:[hash] } });
  }

  async function refresh(tagId) {
    await tagsApi.refresh().catch(() => {});
    const button = list.querySelector(`[data-manage-tag="${CSS.escape(String(tagId))}"]`);
    button?.click();
    schedule();
  }

  function card(item, cardMode) {
    const hash = String(item.hash);
    const confidence = item.confidence == null ? null : Math.round(Number(item.confidence) * 100);
    let badge = '';
    let actions = '';
    if (cardMode === 'detected') {
      badge = `<span class="tag-review-badge detected">${confidence == null ? 'Detected' : `${confidence}% NSFW`}</span>`;
      actions = `<button type="button" data-sensitive-action="manual" data-hash="${hash}">Keep manually</button><button type="button" data-sensitive-action="exclude" data-hash="${hash}">Not sensitive</button>`;
    } else if (cardMode === 'manual') {
      badge = '<span class="tag-review-badge manual">Manual</span>';
      actions = `<button type="button" data-sensitive-action="remove" data-hash="${hash}">Remove</button><button type="button" data-sensitive-action="exclude" data-hash="${hash}">Not sensitive</button>`;
    } else {
      badge = '<span class="tag-review-badge excluded">Excluded</span>';
      actions = `<button type="button" data-sensitive-action="allow" data-hash="${hash}">Allow again</button><button type="button" data-sensitive-action="mark" data-hash="${hash}">Mark sensitive</button>`;
    }
    return `<article class="tag-review-card" data-review-hash="${hash}">
      <div class="tag-review-thumb"><img loading="lazy" src="/api/thumbs/${hash}" alt=""></div>
      <div class="tag-review-badges">${badge}</div>
      <div class="tag-review-actions">${actions}</div>
    </article>`;
  }

  function modeHelp(current) {
    if (current === 'detected') return 'Marked by the dedicated NSFW detector. Confidence is the model’s NSFW probability.';
    if (current === 'manual') return 'Files you explicitly marked Sensitive. Scans do not remove these.';
    return 'False positives the detector is not allowed to mark Sensitive.';
  }

  async function render() {
    queued = false;
    const tag = activeTag();
    decorateList();
    decorateViewer();
    if (!manager.open || !isSensitive(tag)) return;
    if (editor.querySelector(`.sensitive-editor[data-tag-id="${tag.id}"]`)) return;

    const mine = ++generation;
    const state = await requestJson(`/api/tags/${tag.id}`);
    if (mine !== generation || !manager.open || String(activeTag()?.id) !== String(tag.id)) return;

    const members = Array.isArray(state.members) ? state.members : [];
    const detected = members.filter(item => item.source === 'system');
    const manual = members.filter(item => item.source === 'manual');
    const excluded = [...negativeHashes(state)];
    const modes = [
      ['detected','Detected',detected.length],
      ['manual','Manual',manual.length],
      ['excluded','Excluded',excluded.length]
    ];
    if (!modes.some(item => item[0] === mode)) mode = 'detected';
    const items = mode === 'detected' ? detected : mode === 'manual' ? manual : excluded.map(hash => ({ hash }));
    const threshold = scanner.threshold();

    editor.innerHTML = `<div class="sensitive-editor" data-tag-id="${tag.id}">
      <div class="sensitive-head">
        <div class="sensitive-head-main">
          <div class="sensitive-head-title"><h2>Sensitive</h2><span class="sensitive-built-in">Built-in</span></div>
          <p>Dedicated local NSFW detection</p>
        </div>
        <button type="button" data-tag-sensitive-scan>Scan library</button>
      </div>
      <div class="sensitive-stats">
        <div class="sensitive-stat"><strong>${detected.length.toLocaleString()}</strong><span>Detected</span></div>
        <div class="sensitive-stat"><strong>${manual.length.toLocaleString()}</strong><span>Manual</span></div>
        <div class="sensitive-stat"><strong>${excluded.length.toLocaleString()}</strong><span>Excluded</span></div>
      </div>
      <div class="sensitive-control">
        <div class="sensitive-control-head"><span>Detection threshold</span><b data-sensitive-threshold-label>${Math.round(threshold * 100)}%</b></div>
        <input type="range" min="50" max="95" step="5" value="${Math.round(threshold * 100)}" data-sensitive-threshold aria-label="Sensitive detection threshold">
        <small>Higher is stricter. Changing this reuses cached scores on the next scan.</small>
      </div>
      <div class="sensitive-actions">
        <button type="button" data-sensitive-mark-selection>Mark selection sensitive</button>
        <button type="button" class="subtle" data-tag-clear-ai>Clear detected</button>
        <button type="button" class="subtle" data-tag-filter-current>View sensitive media</button>
      </div>
      <div class="tag-ai-status"></div>
      <section class="tag-review">
        <div class="tag-review-head"><strong>Review</strong><span>${escapeHtml(modeHelp(mode))}</span>${mode === 'excluded' && excluded.length ? '<button type="button" class="tag-review-clear" data-sensitive-clear-excluded>Clear exclusions</button>' : ''}</div>
        <div class="tag-review-tabs">${modes.map(([id,label,count]) => `<button type="button" class="${id === mode ? 'active' : ''}" data-sensitive-mode="${id}">${label}<small>${count}</small></button>`).join('')}</div>
        <div class="tag-review-grid">${items.length ? items.map(item => card(item, mode)).join('') : '<div class="tag-review-empty">Nothing here.</div>'}</div>
      </section>
    </div>`;
  }

  function decorateList() {
    const tag = tagsApi.tags().find(isSensitive);
    if (!tag) return;
    const button = list.querySelector(`[data-manage-tag="${CSS.escape(String(tag.id))}"]`);
    const small = button?.querySelector('small');
    if (!small) return;
    small.textContent = `${Number(tag.systemCount) || 0} auto · ${Number(tag.manualCount) || 0} manual`;
    button.title = `${Number(tag.systemCount) || 0} detected · ${Number(tag.manualCount) || 0} manual · ${Number(tag.negativeExamples) || 0} excluded`;
  }

  function decorateViewer() {
    const chip = viewerTags?.querySelector('.viewer-tag-chip.sensitive');
    if (chip) {
      const origin = chip.querySelector('.viewer-tag-origin.system');
      if (origin) {
        const confidence = chip.title.match(/(\d+)%/)?.[1];
        origin.textContent = confidence ? `Detected ${confidence}%` : 'Detected';
      }
    }
    for (const chipNode of viewerTags?.querySelectorAll('.viewer-tag-training-only.negative') || []) {
      const button = chipNode.querySelector('button');
      if (button?.textContent.includes('Sensitive')) {
        const role = chipNode.querySelector('.viewer-tag-role');
        if (role) role.textContent = 'Excluded';
        button.title = 'Excluded from automatic Sensitive detection';
      }
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => render().catch(error => console.error(error)));
  }

  editor.addEventListener('input', event => {
    const input = event.target.closest('[data-sensitive-threshold]');
    if (!input) return;
    const value = scanner.setThreshold(Number(input.value) / 100);
    editor.querySelector('[data-sensitive-threshold-label]')?.replaceChildren(`${Math.round(value * 100)}%`);
  });

  editor.addEventListener('click', async event => {
    const tag = activeTag();
    if (!isSensitive(tag)) return;
    const modeButton = event.target.closest('[data-sensitive-mode]');
    if (modeButton) {
      mode = modeButton.dataset.sensitiveMode;
      editor.querySelector('.sensitive-editor')?.remove();
      schedule();
      return;
    }
    const selection = event.target.closest('[data-sensitive-mark-selection]');
    if (selection) {
      const hashes = selectedHashes();
      if (!hashes.length) {
        const status = editor.querySelector('.tag-ai-status');
        if (status) status.textContent = 'Select files or open one first';
        return;
      }
      selection.disabled = true;
      try { await markManual(tag.id, hashes); await refresh(tag.id); }
      catch (error) { console.error(error); selection.disabled = false; }
      return;
    }
    const clear = event.target.closest('[data-sensitive-clear-excluded]');
    if (clear) {
      const state = await requestJson(`/api/tags/${tag.id}`);
      const count = negativeHashes(state).size;
      if (!count || !confirm(`Clear all ${count} Sensitive exclusions?`)) return;
      clear.disabled = true;
      try { await writeExclusions(tag.id, new Set()); await refresh(tag.id); }
      catch (error) { console.error(error); clear.disabled = false; }
      return;
    }
    const action = event.target.closest('[data-sensitive-action]');
    if (!action) return;
    const hash = String(action.dataset.hash || '');
    if (!hash) return;
    action.disabled = true;
    try {
      if (action.dataset.sensitiveAction === 'exclude') await exclude(tag.id, hash);
      else if (action.dataset.sensitiveAction === 'allow') await allow(tag.id, hash);
      else if (action.dataset.sensitiveAction === 'manual' || action.dataset.sensitiveAction === 'mark') await markManual(tag.id, [hash]);
      else if (action.dataset.sensitiveAction === 'remove') await removeManual(tag.id, hash);
      await refresh(tag.id);
    } catch (error) {
      console.error(error);
      action.disabled = false;
    }
  });

  new MutationObserver(schedule).observe(editor, { childList:true, subtree:true });
  new MutationObserver(() => { decorateList(); schedule(); }).observe(list, { childList:true, subtree:true });
  if (viewerTags) new MutationObserver(decorateViewer).observe(viewerTags, { childList:true, subtree:true });
  manager.addEventListener('close', () => { generation++; });
  window.addEventListener('mochimono:sensitive-threshold', schedule);
  decorateList();
  decorateViewer();
  schedule();
}
