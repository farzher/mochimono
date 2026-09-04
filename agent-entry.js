import { registerHooks } from 'node:module';
import { availableParallelism } from 'node:os';

const cpus = Math.max(1, availableParallelism());
process.env.MOCHIMONO_THUMBNAIL_WORKERS ||= String(Math.max(2, Math.min(8, Math.ceil(cpus / 2))));
process.env.MOCHIMONO_THUMBNAIL_VIDEO_WORKERS ||= String(Math.max(1, Math.min(2, Math.ceil(cpus / 4))));
// Local-provider thumbnails are already gated by the user's Off / Idle / Max
// policy. Give Max enough workers to actually use a modern desktop CPU instead
// of silently bottlenecking video generation at the provider's conservative
// default of four concurrent ffmpeg jobs.
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS ||= String(cpus);
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_VIDEO_WORKERS ||= String(cpus);

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

const [{ startThumbnailAgent }, { startMediaMetadataAgent }, { startProtectionAgent }] = await Promise.all([
  import('./lib/thumbnail-agent.js'),
  import('./lib/media-metadata-agent.js'),
  import('./lib/protection-agent.js')
]);

startThumbnailAgent();
startMediaMetadataAgent();
startProtectionAgent().catch(error => console.error('Protection agent failed', error));
await import('./agent.js');
