const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));

function bytes(number) {
  const units = ['B','KB','MB','GB','TB'];
  let value = Math.max(0, Number(number) || 0), unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

async function json(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

let dialog = null;
function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'small-dialog';
  dialog.innerHTML = `
    <div class="dialog-head"><h3>Empty Trash</h3><button class="icon" data-close>×</button></div>
    <div class="field-stack" style="padding-top:4px">
      <div data-trash-summary style="display:flex;align-items:center;justify-content:center;gap:10px;padding:16px 0 7px;font-variant-numeric:tabular-nums"></div>
      <input data-trash-password type="password" autocomplete="current-password" placeholder="Password" aria-label="Password">
      <div data-trash-error class="error"></div>
    </div>
    <div class="dialog-actions"><button class="secondary" data-close>Cancel</button><div class="spacer"></div><button class="primary" data-purge>Delete permanently</button></div>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.querySelector('[data-trash-password]').value = '';
    dialog.querySelector('[data-trash-error]').textContent = '';
  });
  return dialog;
}

async function confirmPurge(sourceDialog) {
  const trash = await json('/api/protection/trash');
  const files = trash.files || [];
  if (!files.length) return;
  sourceDialog?.close?.();

  const box = ensureDialog();
  const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  box.querySelector('[data-trash-summary]').innerHTML = `<strong style="font-size:22px">${files.length.toLocaleString()}</strong><span style="color:#817977">·</span><strong>${esc(bytes(total))}</strong>`;
  const password = box.querySelector('[data-trash-password]');
  const purge = box.querySelector('[data-purge]');
  const error = box.querySelector('[data-trash-error]');

  purge.onclick = async () => {
    const value = password.value;
    if (!value) { password.focus(); return; }
    purge.disabled = true;
    error.textContent = '';
    try {
      await json('/api/protection/purge', {
        method:'POST',
        headers:{ 'content-type':'application/json', 'x-mochimono-delete-password':encodeURIComponent(value) },
        body:JSON.stringify({ hashes:files.map(file => file.hash), confirm:'DELETE' })
      });
      box.close();
      location.reload();
    } catch (failure) {
      error.textContent = failure.message;
      password.select();
    } finally { purge.disabled = false; }
  };
  password.onkeydown = event => { if (event.key === 'Enter') purge.click(); };
  if (!box.open) box.showModal();
  requestAnimationFrame(() => password.focus());
}

document.addEventListener('click', event => {
  const button = event.target.closest?.('#trashEmpty');
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  confirmPurge(button.closest('dialog')).catch(error => alert(error.message));
}, true);
