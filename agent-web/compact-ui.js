const backup = document.querySelector('#backupCenter');

const tierLabels = new Map([
  ['One copy', '1×'],
  ['Standard', '2×'],
  ['Important', '3×'],
  ['Critical', '◆']
]);

const shield = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.7 16 5v4.6c0 3.9-2.4 6.3-6 7.7-3.6-1.4-6-3.8-6-7.7V5l6-2.3Z"/></svg>`;
const run = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.7 16 5v4.6c0 3.9-2.4 6.3-6 7.7-3.6-1.4-6-3.8-6-7.7V5l6-2.3Z"/><path class="backup-run-mark" d="m8.3 7.2 4.2 2.8-4.2 2.8Z"/></svg>`;
const gear = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.3"/><path d="M10 2.8v1.6M10 15.6v1.6M2.8 10h1.6M15.6 10h1.6M4.9 4.9 6 6M14 14l1.1 1.1M15.1 4.9 14 6M6 14l-1.1 1.1"/></svg>`;

const style = document.createElement('style');
style.textContent = `
  .backup-center-head{margin-bottom:9px!important}
  .backup-center-manage{width:30px;height:30px;display:grid!important;place-items:center;padding:0!important;border-radius:8px!important;font-size:0!important}
  .backup-center-manage:hover{background:#211e22!important}
  .backup-center-manage svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
  .backup-health{grid-template-columns:minmax(0,1fr) 34px!important;gap:10px!important;padding:11px 12px!important;border-radius:13px!important}
  .backup-health-copy{display:grid!important;grid-template-columns:auto minmax(80px,1fr);align-items:center;gap:11px!important}
  .backup-health-title{min-width:72px;display:flex!important;align-items:center!important;gap:7px!important;font-size:13px!important;letter-spacing:-.01em!important;font-variant-numeric:tabular-nums}
  .backup-health-title svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round;color:#83bb91}
  .backup-health.needs .backup-health-title svg{color:#cfa06f}.backup-health.empty .backup-health-title svg{color:#70696b}
  .backup-health-title b{font-size:13px;color:#ddd5d1}.backup-health-title b span{padding:0 2px;color:#716a68;font-weight:500}
  .backup-health-dot,.backup-health-sub{display:none!important}
  .backup-progress{grid-column:2;margin:0!important;height:5px!important;background:#282428!important}
  .backup-health.empty .backup-progress{display:block!important;opacity:.35}
  .backup-health-actions{justify-content:flex-end!important}.backup-health-actions button{width:32px;height:32px;display:grid;place-items:center;padding:0!important;border-radius:9px!important;font-size:0!important}
  .backup-health-actions button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}.backup-health-actions button .backup-run-mark{fill:currentColor;stroke:none}
  .backup-health-actions button[data-running="1"] svg{animation:backup-compact-spin 1.1s linear infinite}.backup-health-actions button[data-running="1"] .backup-run-mark{display:none}
  @keyframes backup-compact-spin{to{transform:rotate(360deg)}}
  .backup-plans{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:4px!important;margin-top:5px!important}
  .backup-plan{justify-content:center!important;gap:6px!important;padding:5px 4px!important;border:0!important;background:transparent!important;border-radius:7px!important}
  .backup-plan strong{font-size:10px!important;color:#817977!important}.backup-plan b{font-size:11px!important;color:#c4bbb7!important}.backup-plan[data-zero="1"]{opacity:.38}
  .backup-job{display:flex;align-items:center;justify-content:center;gap:5px;margin-top:4px!important;padding:4px!important;border:0!important;background:transparent!important}.backup-job strong{font-size:0!important}.backup-job strong:before{content:'↻';font-size:11px;display:inline-block;animation:backup-compact-spin 1.1s linear infinite}
  @media(max-width:760px){.backup-health{grid-template-columns:minmax(0,1fr) 34px!important}.backup-plans{grid-template-columns:repeat(4,minmax(0,1fr))!important}}
`;
document.head.append(style);

function parseCount(value) {
  return Number(String(value || '').replace(/[^0-9]/g, '')) || 0;
}

function polishBackup() {
  if (!backup?.isConnected) return;

  const manage = backup.querySelector('[data-backup-manage]');
  if (manage && manage.dataset.compact !== '1') {
    manage.dataset.compact = '1';
    manage.innerHTML = gear;
    manage.title = 'Manage backup';
    manage.setAttribute('aria-label', 'Manage backup');
  }

  const health = backup.querySelector('.backup-health:not([data-compact])');
  if (health) {
    health.dataset.compact = '1';
    const title = health.querySelector('.backup-health-title');
    const sub = health.querySelector('.backup-health-sub');
    const originalTitle = title?.textContent?.trim() || 'Backup';
    const ratio = String(sub?.textContent || '').match(/([\d,]+)\s*\/\s*([\d,]+)/);
    const total = ratio ? parseCount(ratio[2]) : [...backup.querySelectorAll('.backup-plan b')].reduce((sum, node) => sum + parseCount(node.textContent), 0);
    const protectedFiles = ratio ? parseCount(ratio[1]) : total && !health.classList.contains('needs') ? total : 0;
    if (title) {
      title.innerHTML = `${shield}<b>${protectedFiles.toLocaleString()}<span>/</span>${total.toLocaleString()}</b>`;
      title.title = originalTitle;
    }

    const button = health.querySelector('[data-protect-now]');
    if (button) {
      const running = /protecting/i.test(button.textContent || '');
      button.innerHTML = run;
      button.dataset.running = running ? '1' : '0';
      button.title = running ? 'Protecting' : 'Protect now';
      button.setAttribute('aria-label', button.title);
    }
  }

  for (const plan of backup.querySelectorAll('.backup-plan:not([data-compact])')) {
    plan.dataset.compact = '1';
    const name = plan.querySelector('strong');
    const count = plan.querySelector('b');
    const full = name?.textContent?.trim() || '';
    if (name && tierLabels.has(full)) name.textContent = tierLabels.get(full);
    plan.title = full;
    if (parseCount(count?.textContent) === 0) plan.dataset.zero = '1';
  }
}

let polishFrame = 0;
const schedulePolish = () => {
  if (polishFrame) return;
  polishFrame = requestAnimationFrame(() => {
    polishFrame = 0;
    polishBackup();
  });
};

if (backup) {
  new MutationObserver(schedulePolish).observe(backup, { childList:true, subtree:true });
  schedulePolish();
}

document.addEventListener('pointerdown', event => {
  const dialog = event.target instanceof HTMLDialogElement ? event.target : null;
  if (!dialog?.open) return;
  const rect = dialog.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) dialog.close();
});
