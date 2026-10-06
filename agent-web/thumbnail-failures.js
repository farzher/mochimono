const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
let dialog;
let root = '';

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers:{ 'content-type':'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function ensureDialog() {
  if (dialog) return dialog;
  const style = document.createElement('style');
  style.textContent = `
    dialog.thumbnail-failures{width:min(680px,calc(100vw - 24px));max-height:85dvh;overflow:auto}
    .thumbnail-failure-list{display:grid;gap:12px}.thumbnail-failure{border-top:1px solid #302b30;padding-top:12px;min-width:0}
    .thumbnail-failure button{padding:0;background:transparent;color:#e9e0dc;text-align:left;overflow-wrap:anywhere;font-size:12px}
    .thumbnail-failure small{display:block;margin-top:5px;color:#aaa19e;font-size:11px}
    .thumbnail-failure pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#958c88;font-family:inherit;font-size:11px;line-height:1.5;margin:7px 0 0;max-height:140px;overflow:auto}
    .thumbnail-failures [data-error]{color:#dd817a;font-size:11px}
  `;
  document.head.append(style);
  dialog = document.createElement('dialog');
  dialog.className = 'thumbnail-failures';
  dialog.innerHTML = '<div class="dialog-head"><h3>Thumbnail failures</h3><button class="icon" data-close aria-label="Close">×</button></div><div class="thumbnail-failure-list"></div><div class="dialog-actions"><span data-error></span><span class="spacer"></span><button class="secondary" data-retry>Retry failed</button></div>';
  document.body.append(dialog);
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('click', async event => {
    const reveal = event.target.closest('[data-reveal]');
    const retry = event.target.closest('[data-retry]');
    if (!reveal && !retry) return;
    const button = reveal || retry;
    button.disabled = true;
    dialog.querySelector('[data-error]').textContent = '';
    try {
      if (reveal) {
        await request('/api/open-folder', { method:'POST', body:JSON.stringify({ path:`${root}/${reveal.dataset.reveal}`, select:true }) });
      } else {
        await request('/api/browse-folders/thumbnails/retry', { method:'POST', body:JSON.stringify({ path:root }) });
        dialog.close();
        window.dispatchEvent(new CustomEvent('mochimono:storage-changed'));
      }
    } catch (error) {
      dialog.querySelector('[data-error]').textContent = error.message;
    } finally { button.disabled = false; }
  });
  return dialog;
}

async function showFailures(path) {
  const box = ensureDialog();
  root = path;
  const list = box.querySelector('.thumbnail-failure-list');
  const retry = box.querySelector('[data-retry]');
  list.textContent = 'Loading…';
  retry.disabled = true;
  box.querySelector('[data-error]').textContent = '';
  if (!box.open) box.showModal();
  try {
    const { failures } = await request(`/api/browse-folders/thumbnail-failures?path=${encodeURIComponent(path)}`);
    if (root !== path) return;
    list.innerHTML = failures.length ? failures.map(file => {
      const status = file.terminal ? 'Unavailable · not retrying'
        : file.retryAt > Date.now() ? `Next retry after ${new Date(file.retryAt).toLocaleTimeString()}` : 'Retry pending';
      const attempts = !file.attempts ? '' : file.terminal
        ? `${file.attempts} attempt${file.attempts === 1 ? '' : 's'}` : `${file.attempts} / 3 attempts`;
      return `<div class="thumbnail-failure"><button data-reveal="${esc(file.path)}" title="Show in folder">${esc(file.path)}</button><small>${esc(status)}${attempts ? ` · ${esc(attempts)}` : ''}</small><pre>${esc(file.error)}</pre></div>`;
    }).join('') : '<div class="muted">No thumbnail failures</div>';
    retry.disabled = !failures.length;
  } catch (error) {
    if (root === path) list.textContent = error.message;
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-preview-failures]');
  if (button) void showFailures(button.dataset.previewFailures);
});
