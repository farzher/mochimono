// Grid geometry is now owned exclusively by stable-grid.js.
// Keep this tiny compatibility surface for catalog-cache/thumb callers that may
// still ask about previously learned dimensions. Thumbnail discovery persists
// dimensions for future layouts; it never mutates the active scrolling plane.
const geometry = new Map();

window.mochimonoStartupGeometry = geometry;
window.mochimonoGeometry = {
  get(hash) {
    return geometry.get(String(hash || '')) || null;
  },
  remember(hash, width, height) {
    hash = String(hash || '');
    width = Number(width) || 0;
    height = Number(height) || 0;
    if (hash && width > 0 && height > 0) geometry.set(hash, { width, height });
  },
  async prime() {
    return true;
  },
  state() {
    return { known:geometry.size, pending:0, checking:false };
  }
};
