const dialog = document.querySelector('#deviceDialog');
const fields = dialog?.querySelector('.field-stack');
const saveButton = document.querySelector('#saveDevice');

if (dialog && fields && saveButton) {
  const style = document.createElement('style');
  style.textContent = `
.lan-setting{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-top:7px;padding:10px 2px 0;border-top:1px solid #262326}
.lan-setting-copy{display:grid;gap:3px;min-width:0}
.lan-setting-copy strong{font-size:12px;color:#ddd5d2}
.lan-setting-copy span{font-size:11px;color:#817977;line-height:1.35}
.lan-setting input{width:auto;margin:2px 0 0;accent-color:#efa09a}
.lan-urls{display:grid;gap:3px;margin:-2px 2px 1px;color:#aaa19e;font-size:11px;word-break:break-all}
.lan-urls code{font:inherit;color:#d9d0cd}
`;
  document.head.append(style);

  const row = document.createElement('label');
  row.className = 'lan-setting';
  row.innerHTML = `<span class="lan-setting-copy"><strong>LAN access</strong><span>Allow other devices on this network to open Mochimono</span></span><input id="lanAccess" type="checkbox" aria-label="LAN access">`;
  const urls = document.createElement('div');
  urls.className = 'lan-urls';
  urls.hidden = true;
  fields.append(row, urls);

  const checkbox = row.querySelector('#lanAccess');
  let locked = false;

  const esc = value => String(value ?? '').replace(/[&<>]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[char]));

  function render(data) {
    const settings = data?.settings || {};
    const enabled = Boolean(settings.lanAccess);
    locked = Boolean(settings.lanAccessLocked);
    checkbox.checked = enabled;
    checkbox.disabled = locked;
    const list = Array.isArray(settings.lanUrls) ? settings.lanUrls : [];
    urls.hidden = !enabled;
    urls.innerHTML = enabled
      ? `${list.map(url => `<code>${esc(url)}</code>`).join('')}${locked ? '<span>Controlled by MOCHIMONO_AGENT_HOST</span>' : '<span>Anyone on this network can access Mochimono.</span>'}`
      : '';
  }

  async function refresh() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (response.ok) render(await response.json());
    } catch {}
  }

  document.querySelector('#deviceButton')?.addEventListener('click', () => setTimeout(refresh, 0));

  saveButton.addEventListener('click', async event => {
    if (locked) return;
    event.stopImmediatePropagation();
    const device = document.querySelector('#deviceName')?.value.trim();
    const workers = Number(document.querySelector('#uploadWorkers')?.value);
    if (!device || ![1, 2, 4].includes(workers)) return;
    saveButton.disabled = true;
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device, uploadWorkers: workers, lanAccess: checkbox.checked })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || response.statusText);
      dialog.close();
      setTimeout(refresh, 250);
    } catch (error) {
      const toast = document.querySelector('#toast');
      if (toast) {
        toast.textContent = error.message;
        toast.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => toast.classList.remove('show'), 2800);
      }
    } finally {
      saveButton.disabled = false;
    }
  }, true);

  refresh();
}
