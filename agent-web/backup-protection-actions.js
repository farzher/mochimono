const storagePane = document.querySelector('#storagePane');
const toastNode = document.querySelector('#toast');

if (storagePane) {
  let busy = false;

  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    clearTimeout(toastNode.timer);
    toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
  }

  async function protect() {
    const response = await fetch('/api/client/protection/run', {
      method:'POST',
      headers:{ 'content-type':'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function polish() {
    for (const button of document.querySelectorAll('.storage-location-dialog [data-action="backup-update"]')) {
      button.textContent = 'Protect';
      button.title = 'Fill useful verified copies here. Anything that does not fit stays available for other storage destinations.';
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('.storage-location-dialog[data-location-id] [data-action="backup-update"]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;
    busy = true;
    button.disabled = true;
    protect().then(data => {
      button.closest('dialog')?.close();
      toast(data.job?.status === 'queued' ? 'Protection queued' : 'Protection started');
    }).catch(error => {
      button.disabled = false;
      toast(error.message);
    }).finally(() => { busy = false; });
  }, true);

  new MutationObserver(polish).observe(document.body, { childList:true, subtree:true });
  polish();
}
