const backup = document.querySelector('#backupCenter');

const tierLabels = new Map([
  ['One copy', '1×'],
  ['Standard', '2×'],
  ['Important', '3×'],
  ['Critical', '◆']
]);
const kindGlyphs = new Map([
  ['Index', '▦'],
  ['Sync', '↻'],
  ['Hash', '#'],
  ['Thumbnail', '▧'],
  ['Backup', '◇'],
  ['Friend Drive', '↔'],
  ['Squish', '⇥'],
  ['Verify', '✓'],
  ['Restore', '↩'],
  ['Work', '•']
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
  .backup-health-title{min-width:72px;display:flex!important;align-items:center!important;gap:8px!important;font-size:13px!important;letter-spacing:-.01em!important;font-variant-numeric:tabular-nums}
  .backup-health-title svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round;color:#83bb91}
  .backup-health.needs .backup-health-title svg{color:#cfa06f}.backup-health.empty .backup-health-title svg{color:#70696b}
  .backup-health-title b{font-size:15px;color:#ddd5d1;font-variant-numeric:tabular-nums}
  .backup-health-dot,.backup-health-sub{display:none!important}
  .backup-progress{grid-column:2;margin:0!important;height:6px!important;background:#282428!important}
  .backup-health.empty .backup-progress{display:block!important;opacity:.35}
  .backup-health-actions{justify-content:flex-end!important}.backup-health-actions button{width:32px;height:32px;display:grid;place-items:center;padding:0!important;border-radius:9px!important;font-size:0!important}
  .backup-health-actions button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}.backup-health-actions button .backup-run-mark{fill:currentColor;stroke:none}
  .backup-health-actions button[data-running="1"] svg{animation:backup-compact-spin 1.1s linear infinite}.backup-health-actions button[data-running="1"] .backup-run-mark{display:none}
  @keyframes backup-compact-spin{to{transform:rotate(360deg)}}
  .backup-plans{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:7px!important;margin-top:7px!important}
  .backup-plan{display:grid!important;grid-template-columns:auto 1fr!important;align-items:center!important;justify-content:stretch!important;gap:8px!important;padding:9px 10px!important;border:1px solid #292529!important;background:#111012!important;border-radius:10px!important}
  .backup-plan strong{font-size:11px!important;color:#8e8582!important;font-weight:760!important}.backup-plan b{text-align:right;font-size:14px!important;color:#d2c8c4!important;font-weight:760!important}.backup-plan[data-zero="1"]{opacity:.38}
  .backup-job{display:flex;align-items:center;justify-content:center;gap:5px;margin-top:4px!important;padding:4px!important;border:0!important;background:transparent!important}.backup-job strong{font-size:0!important}.backup-job strong:before{content:'↻';font-size:11px;display:inline-block;animation:backup-compact-spin 1.1s linear infinite}

  .backup-center-dialog .backup-settings{gap:14px!important}
  .backup-center-dialog .backup-settings-section:first-child{display:none!important}
  .backup-center-dialog .backup-settings-section{gap:8px!important}
  .backup-center-dialog .backup-settings-section h4{font-size:13px!important;color:#d8cfcb!important;letter-spacing:-.01em}
  .backup-center-dialog .backup-source-row,.backup-center-dialog .backup-destination-row,.backup-center-dialog .backup-background{padding:11px 12px!important;border-radius:11px!important}
  .backup-center-dialog .backup-source-row .backup-row-copy small{display:none!important}
  .backup-center-dialog .backup-row-copy strong{font-size:12px!important}
  .backup-center-dialog .backup-destination-row .backup-row-copy small{font-size:10px!important;margin-top:3px!important}
  .backup-center-dialog [data-folder-plan]{min-width:64px!important;width:64px!important;text-align:center;font-weight:760}
  .backup-center-dialog .backup-destination-controls{gap:7px!important}
  .backup-center-dialog .backup-destination-controls label{font-size:0!important;gap:5px!important}
  .backup-center-dialog .backup-destination-controls label:before{font-size:13px;color:#8e8582}
  .backup-center-dialog .backup-destination-controls label[data-visual-media="image"]:before{content:'▧'}
  .backup-center-dialog .backup-destination-controls label[data-visual-media="video"]:before{content:'▶';font-size:9px}
  .backup-center-dialog .backup-rely{width:29px;height:29px;display:grid;place-items:center;padding:0!important;border-radius:8px!important;font-size:0!important}
  .backup-center-dialog .backup-rely:before{content:'✓';font-size:12px}.backup-center-dialog .backup-rely.off:before{content:'—'}

  .activity-dialog{width:min(620px,calc(100vw - 24px))!important}
  .activity-dialog .activity-body{padding:10px 13px 14px!important}
  .activity-mode{display:block!important;padding:3px!important;margin:0 0 11px!important;border:0!important;background:transparent!important}
  .activity-mode-copy{display:none!important}
  .activity-mode-buttons{width:100%!important;display:grid!important;grid-template-columns:repeat(3,1fr)!important;gap:3px!important;padding:3px!important;border-radius:10px!important}
  .activity-mode-buttons button{height:31px!important;font-size:10px!important;border-radius:7px!important}
  .activity-summary{min-height:30px!important;gap:7px!important;margin:0 0 9px!important;font-size:0!important}
  .activity-summary .spacer,.activity-summary>span:not(.activity-stat){display:none!important}
  .activity-stat{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:1px solid #292529;border-radius:999px;background:#111012;color:#8c8380;font-size:10px!important;font-variant-numeric:tabular-nums}
  .activity-stat b{font-size:12px;color:#d8cfcb}.activity-stat.working{border-color:#3b3032}.activity-stat.waiting{color:#948a86}.activity-stat.done{color:#82b990}
  .activity-section{margin-top:11px!important}.activity-section-head{margin-bottom:6px!important;font-size:9px!important}
  .activity-row{grid-template-columns:minmax(0,1fr) auto!important;gap:9px!important;padding:10px!important;border-radius:11px!important}
  .activity-title{gap:9px!important;font-size:12px!important}.activity-kind{width:25px;height:25px;display:grid!important;place-items:center!important;padding:0!important;border-radius:7px!important;font-size:13px!important;text-transform:none!important;letter-spacing:0!important}
  .activity-detail{display:flex!important;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px!important;font-size:0!important}
  .activity-metric{display:inline-flex;align-items:center;min-height:22px;padding:3px 7px;border-radius:7px;background:#211e22;color:#9c928f;font-size:9px!important;font-variant-numeric:tabular-nums}
  .activity-detail.wait .activity-metric{color:#b5a397}
  .activity-current{display:none!important}
  .activity-progress{height:5px!important;margin-top:7px!important}
  .activity-side{font-size:9px!important}.activity-cancel{font-size:0!important;width:25px;height:25px;border-radius:7px!important}.activity-cancel:after{content:'×';font-size:14px}
  .activity-recent .activity-list,.activity-recent .activity-empty{display:none}.activity-recent.open .activity-list,.activity-recent.open .activity-empty{display:grid}.activity-recent .activity-section-head{cursor:pointer}.activity-recent .activity-section-head:after{content:'›';margin-left:auto;font-size:13px;transform:rotate(90deg);transition:transform .15s}.activity-recent.open .activity-section-head:after{transform:rotate(-90deg)}
  .activity-button .activity-count{display:inline-flex;gap:4px;align-items:center;font-size:10px}.activity-button .activity-count i{font-style:normal;color:#7f7775}.activity-button .activity-count b{color:#d8cfcb;font-weight:760}

  @media(max-width:760px){.backup-health{grid-template-columns:minmax(0,1fr) 34px!important}.backup-plans{grid-template-columns:repeat(2,minmax(0,1fr))!important}.activity-row{grid-template-columns:1fr!important}}
`;
document.head.append(style);

function parseCount(value) {
  return Number(String(value || '').replace(/[^0-9]/g, '')) || 0;
}

function compactPlanSelect(select) {
  if (!select || select.dataset.visual === '1') return;
  select.dataset.visual = '1';
  for (const option of select.options) {
    const original = option.textContent.trim();
    const name = original.split(' · ')[0];
    if (tierLabels.has(name)) option.textContent = tierLabels.get(name);
  }
  select.title = 'Protection';
}

function polishBackupManage(root = document) {
  for (const box of root.querySelectorAll?.('.backup-center-dialog') || []) {
    for (const select of box.querySelectorAll('[data-folder-plan]')) compactPlanSelect(select);
    for (const label of box.querySelectorAll('.backup-destination-controls label')) {
      if (label.dataset.visualMedia) continue;
      const text = String(label.childNodes[0]?.textContent || '').trim();
      label.dataset.visualMedia = /^images/i.test(text) ? 'image' : 'video';
      label.title = /^images/i.test(text) ? 'Images' : 'Video';
    }
    for (const button of box.querySelectorAll('.backup-rely')) {
      const relied = !button.classList.contains('off');
      button.title = relied ? 'Counts toward protection' : 'Do not rely on';
      button.setAttribute('aria-label', button.title);
    }
  }
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
    const percent = total ? Math.round(protectedFiles / total * 100) : 0;
    if (title) {
      title.innerHTML = `${shield}<b>${percent}%</b>`;
      title.title = total ? `${protectedFiles.toLocaleString()} of ${total.toLocaleString()} protected` : originalTitle;
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

function metricText(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (/^waiting for idle$/i.test(text)) return '◷';
  if (/^on demand$/i.test(text)) return 'Ⅱ';
  text = text
    .replace(/\bfiles?\b/gi, '')
    .replace(/\bready\b/gi, '')
    .replace(/\bchecked\b/gi, '')
    .replace(/\bfound\b/gi, '')
    .replace(/^([\d,.]+)\s+generating$/i, '↻ $1')
    .replace(/^([\d,.]+)\s+(queued|waiting)$/i, '… $1')
    .replace(/^([\d,.]+)\s+copied$/i, '↑ $1')
    .replace(/\s+left$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function polishActivity(root = document) {
  for (const count of root.querySelectorAll?.('.activity-button .activity-count') || []) {
    const raw = count.textContent.trim();
    if (!/working|waiting/.test(raw)) continue;
    const working = raw.match(/([\d,]+)\s+working/)?.[1];
    const waiting = raw.match(/([\d,]+)\s+waiting/)?.[1];
    count.innerHTML = `${working ? `<i>▶</i><b>${working}</b>` : ''}${waiting ? `<i>…</i><b>${waiting}</b>` : ''}`;
  }

  for (const summary of root.querySelectorAll?.('.activity-summary') || []) {
    if (summary.dataset.visual === '1') continue;
    const raw = summary.textContent.trim();
    const working = raw.match(/([\d,]+)\s+working/)?.[1];
    const waiting = raw.match(/([\d,]+)\s+waiting/)?.[1];
    const idle = /waiting for idle/i.test(raw);
    summary.dataset.visual = '1';
    summary.innerHTML = working || waiting
      ? `${working ? `<span class="activity-stat working">▶ <b>${working}</b></span>` : ''}${waiting ? `<span class="activity-stat waiting">… <b>${waiting}</b></span>` : ''}${idle ? '<span class="activity-stat waiting">◷</span>' : ''}`
      : '<span class="activity-stat done">✓</span>';
  }

  for (const kind of root.querySelectorAll?.('.activity-kind:not([data-visual])') || []) {
    const name = kind.textContent.trim() || 'Work';
    kind.dataset.visual = '1';
    kind.title = name;
    kind.textContent = kindGlyphs.get(name) || '•';
  }

  for (const detail of root.querySelectorAll?.('.activity-detail:not([data-visual])') || []) {
    detail.dataset.visual = '1';
    const metrics = detail.textContent.split(' · ').map(metricText).filter(Boolean);
    detail.innerHTML = metrics.map(text => `<span class="activity-metric">${text.replace(/[&<>]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]))}</span>`).join('');
  }

  for (const recent of root.querySelectorAll?.('.activity-recent:not([data-visual])') || []) {
    recent.dataset.visual = '1';
    recent.querySelector('.activity-section-head')?.addEventListener('click', () => recent.classList.toggle('open'));
  }
}

let polishFrame = 0;
const schedulePolish = () => {
  if (polishFrame) return;
  polishFrame = requestAnimationFrame(() => {
    polishFrame = 0;
    polishBackup();
    polishBackupManage();
    polishActivity();
  });
};

if (backup) {
  new MutationObserver(schedulePolish).observe(backup, { childList:true, subtree:true });
  schedulePolish();
}
new MutationObserver(schedulePolish).observe(document.body, { childList:true, subtree:true });
schedulePolish();

document.addEventListener('pointerdown', event => {
  const dialog = event.target instanceof HTMLDialogElement ? event.target : null;
  if (!dialog?.open) return;
  const rect = dialog.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) dialog.close();
});
