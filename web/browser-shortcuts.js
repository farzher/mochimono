document.addEventListener('keydown', event => {
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    // Leave Alt+Left/Right to the browser for Back/Forward. This listener is
    // loaded before Mochimono's viewer keyboard handlers so they never steal it.
    event.stopImmediatePropagation();
  }
}, true);
