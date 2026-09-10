const files = document.querySelector('#files');
const status = document.querySelector('.similarity-sort-copy > span');

const style = document.createElement('style');
style.textContent = '.similarity-match{display:none!important}';
document.head.append(style);

function simplifyStatus() {
  if (!status) return;
  const suffix = " · ↔ shows each image's closest match";
  if (status.textContent.includes(suffix)) status.textContent = status.textContent.replace(suffix, '');
}

function simplifyCards(root = files) {
  if (!root) return;
  const scope = root instanceof Element ? root : files;
  scope.querySelectorAll?.('.similarity-match').forEach(element => element.remove());
  scope.querySelectorAll?.('.similarity-score').forEach(element => {
    const value = element.textContent.trim();
    if (value) element.title = `Similarity ${value}`;
  });
}

if (files && typeof MutationObserver === 'function') {
  new MutationObserver(records => {
    simplifyStatus();
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) simplifyCards(node);
    }
  }).observe(document.body, { childList:true, subtree:true, characterData:true });
}

simplifyStatus();
simplifyCards();
