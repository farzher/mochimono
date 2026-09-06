// video-optimize-compare.js owns frame pairing/zoom/pan. Its older settings-state
// hook predates the live-preview transport and would restore the timestamp from
// the instant a setting was changed. Suppress only those two listener
// registrations so playback continuity has a single owner.
const nativeAdd = EventTarget.prototype.addEventListener;

EventTarget.prototype.addEventListener = function(type, listener, options) {
  const isControls = this instanceof Element && this.matches?.('[data-controls]');
  const isLegacyRestore = isControls &&
    (type === 'click' || type === 'change') &&
    listener?.name === 'captureSettingState';
  if (isLegacyRestore) return;
  return nativeAdd.call(this, type, listener, options);
};

try {
  await import('./video-optimize-compare.js');
} finally {
  EventTarget.prototype.addEventListener = nativeAdd;
}

// The compositor releases its previous VideoFrame pair on a fresh optimizer
// open, but a canvas retains its last painted pixels until something explicitly
// clears it. Clear only on a fresh open so a different video's old comparison
// can never flash while its first sample is encoding. Setting changes do not
// dispatch optimize-open, so their currently displayed preview remains intact.
const comparisonCanvas = document.querySelector('.video-optimize-compare [data-canvas]');
window.addEventListener('mochimono:optimize-open', () => {
  if (!comparisonCanvas) return;
  comparisonCanvas.width = comparisonCanvas.width;
});
