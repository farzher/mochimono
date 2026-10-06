// Preview the same item-index mapping used by rail scrubbing, without scrolling.
export function installRailHover(rail, count, labelAt) {
  const preview = document.createElement('div');
  preview.className = 'rail-hover-label';
  preview.hidden = true;
  preview.innerHTML = '<span></span><i></i>';
  const text = preview.querySelector('span');

  function hide() {
    preview.hidden = true;
  }

  function show(event) {
    if (event.pointerType === 'touch' || rail.hidden) return hide();
    const total = count();
    if (!total) return hide();
    const rect = rail.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const index = Math.round(y / Math.max(1, rect.height) * (total - 1));
    const label = labelAt(index);
    if (!label) return hide();
    // Rail contents can be rebuilt when the sort or filters change.
    if (preview.parentNode !== rail) rail.append(preview);
    if (text.textContent !== label) text.textContent = label;
    preview.style.top = `${Math.max(12, Math.min(rect.height - 12, y))}px`;
    preview.hidden = false;
  }

  rail.addEventListener('pointerenter', show);
  rail.addEventListener('pointerleave', hide);
  rail.addEventListener('pointercancel', hide);
  // Capture before scrub handlers, which stop propagation during dragging.
  for (const type of ['pointermove', 'pointerdown']) {
    document.addEventListener(type, event => {
      if (rail.contains(event.target)) show(event);
    }, true);
  }
  window.addEventListener('blur', hide);
}
