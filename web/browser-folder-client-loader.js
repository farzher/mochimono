if (document.documentElement.classList.contains('client-library')) {
  import('./browser-folder-drop.js').catch(error => console.warn('Browser folder sync unavailable', error));
}
