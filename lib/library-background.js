import { activateClientProviderCache } from './client-provider-cache.js';
import { activateLibraryDemand } from './library-demand.js';

let started = false;
let starting = null;

export function startLibraryBackground() {
  if (started) return Promise.resolve();
  if (starting) return starting;
  activateClientProviderCache();
  activateLibraryDemand();
  starting = (async () => {
    const [
      { startThumbnailAgent },
      { startMediaMetadataAgent },
      { startBrowseFastDedupe },
      { invalidateClientProviders },
      { startCompressionServerSync },
      { startRepresentationReconciler }
    ] = await Promise.all([
      import('./thumbnail-agent.js'),
      import('./media-metadata-agent.js'),
      import('./browse-fast-dedupe.js'),
      import('./client-providers.js'),
      import('./compression-server-sync.js'),
      import('./representation-reconciler.js')
    ]);

    startThumbnailAgent();
    startMediaMetadataAgent();
    startCompressionServerSync();
    startRepresentationReconciler();
    startBrowseFastDedupe(invalidateClientProviders);
    started = true;
  })().finally(() => { starting = null; });
  return starting;
}
