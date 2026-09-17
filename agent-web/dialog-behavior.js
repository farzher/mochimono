document.addEventListener('pointerdown', event => {
  const dialog = event.target instanceof HTMLDialogElement ? event.target : null;
  if (!dialog?.open) return;
  const rect = dialog.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) dialog.close();
});
