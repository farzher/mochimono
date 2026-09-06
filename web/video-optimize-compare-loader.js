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
