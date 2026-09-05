import { registerHooks } from 'node:module';
import { availableParallelism } from 'node:os';

const cpus = Math.max(1, availableParallelism());
process.env.MOCHIMONO_THUMBNAIL_WORKERS ||= String(Math.max(2, Math.min(8, Math.ceil(cpus / 2))));
process.env.MOCHIMONO_THUMBNAIL_VIDEO_WORKERS ||= String(Math.max(1, Math.min(2, Math.ceil(cpus / 4))));
// Local-provider thumbnails are already gated by the user's Off / Idle / Max
// policy. In Max, keep the provider and its crash-isolated Sharp pool at the
// same concurrency so "active" jobs are real decoders rather than another
// hidden queue behind the provider.
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS ||= String(cpus);
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_VIDEO_WORKERS ||= String(cpus);
process.env.MOCHIMONO_PROVIDER_SHARP_WORKERS ||= process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS;

// provider-thumbs decodes arbitrary files from local folders. Redirect only its
// Sharp import through a child-process proxy, so a malformed image can kill one
// tiny libvips worker without killing indexing or the Agent process itself.
const providerThumbsUrl = new URL('./lib/provider-thumbs.js', import.meta.url).href;
const providerSharpProxyUrl = new URL('./lib/sharp-provider-proxy.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sharp' && context.parentURL === providerThumbsUrl) {
      return { url: providerSharpProxyUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

// Older Mochimono builds stored provider previews directly in provider-thumbs/.
// The current cache is hash-bucketed. Complete this one-time local repair before
// provider-thumbs starts so its in-memory missing cache cannot hide a file that
// gets migrated moments later. The migration yields while processing large sets.
try {
  const { migrateLegacyProviderThumbCache } = await import('./lib/provider-thumb-cache-migration.js');
  const migrated = await migrateLegacyProviderThumbCache();
  if (migrated.migrated || migrated.removedDuplicates) {
    console.log(`Recovered ${migrated.migrated} legacy provider thumbnails${migrated.removedDuplicates ? ` (${migrated.removedDuplicates} duplicates removed)` : ''}`);
  }
} catch (error) {
  console.warn('Legacy provider thumbnail migration failed', error);
}

const [
  { startThumbnailAgent },
  { startMediaMetadataAgent },
  { startProtectionAgent },
  { startBrowseFastDedupe },
  { invalidateClientProviders }
] = await Promise.all([
  import('./lib/thumbnail-agent.js'),
  import('./lib/media-metadata-agent.js'),
  import('./lib/protection-agent.js'),
  import('./lib/browse-fast-dedupe.js'),
  import('./lib/client-providers.js')
]);

startThumbnailAgent();
startMediaMetadataAgent();
startProtectionAgent().catch(error => console.error('Protection agent failed', error));
await import('./agent.js');
startBrowseFastDedupe(invalidateClientProviders);
