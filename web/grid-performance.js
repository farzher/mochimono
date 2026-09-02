const files = document.querySelector('#files');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    /* Keep month layout work isolated without deactivating its contents. The
       browser already skips off-screen painting; content-visibility caused
       visible activation flashes when rapidly reversing through the grid. */
    .files.grid>.date-group{contain:layout style}
  `;
  document.head.append(style);

  function removeLoadingPlaceholder() {
    for (const node of files.querySelectorAll(':scope > .empty')) {
      if (node.textContent.trim() === 'Loading…') node.remove();
    }
  }

  removeLoadingPlaceholder();
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('.empty') && node.textContent.trim() === 'Loading…') node.remove();
      }
    }
  }).observe(files, { childList:true });
}
