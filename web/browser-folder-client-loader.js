if (document.documentElement.classList.contains('client-library')) {
  import('./browser-folder-catalog-reconcile.js')
    .catch(error => console.warn('Browser folder catalog reconciliation unavailable', error))
    .then(() => import('./browser-folder-drop.js'))
    .catch(error => console.warn('Browser folder sync unavailable', error));
}
