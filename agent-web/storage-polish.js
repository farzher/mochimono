const protectionMenu = document.querySelector('#clientProtection');
const serverStorage = document.querySelector('#serverStorage');
const serverStorageText = document.querySelector('#serverStorageText');

function openProtectionSettings() {
  const button = document.querySelector('#protectionSettings');
  if (button) {
    button.click();
    return;
  }
  setTimeout(() => document.querySelector('#protectionSettings')?.click(), 150);
}

function parseBytesLabel(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)$/i);
  if (!match) return NaN;
  const units = ['B','KB','MB','GB','TB','PB'];
  const power = units.indexOf(match[2].toUpperCase());
  return Number(match[1]) * (1000 ** Math.max(0, power));
}

function formatBytes(number) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Math.max(0, Number(number) || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function showUsedAndFree() {
  if (!serverStorageText) return;
  const match = serverStorageText.textContent.match(/^(.+?)\s*\/\s*(.+)$/);
  if (!match) return;
  const used = parseBytesLabel(match[1]);
  const capacity = parseBytesLabel(match[2]);
  if (!Number.isFinite(used) || !Number.isFinite(capacity)) return;
  const text = `${match[1].trim()} used · ${formatBytes(Math.max(0, capacity - used))} free`;
  serverStorageText.textContent = text;
  if (serverStorage) serverStorage.title = `${text} · Cloud`;
}

protectionMenu?.addEventListener('click', openProtectionSettings);
if (serverStorageText) {
  new MutationObserver(showUsedAndFree).observe(serverStorageText, { childList:true, characterData:true, subtree:true });
  queueMicrotask(showUsedAndFree);
}
