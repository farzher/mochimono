const CLIENT = document.documentElement.classList.contains('client-library');
const rail = document.querySelector('#dateRail');
const source = document.querySelector('#source');

if (CLIENT && rail && source) {
  const style = document.createElement('style');
  style.textContent = `
    html.mochimono-timeline-settling #dateRail{
      visibility:hidden!important;
      pointer-events:none!important;
    }
  `;
  document.head.append(style);
  document.documentElement.classList.add('mochimono-timeline-settling');

  const settled = () => source.options[0]?.textContent?.trim() === 'All sources';
  const reveal = () => {
    if (!settled()) return false;
    document.documentElement.classList.remove('mochimono-timeline-settling');
    return true;
  };

  if (!reveal()) {
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    observer.observe(source, { childList:true, subtree:true });
  }
}
