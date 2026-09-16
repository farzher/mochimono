import { registerHooks } from 'node:module';
import { availableParallelism } from 'node:os';

const cpus = Math.max(1, availableParallelism());
process.env.MOCHIMONO_THUMBNAIL_WORKERS ||= String(Math.max(2, Math.min(8, Math.ceil(cpus / 2))));
process.env.MOCHIMONO_THUMBNAIL_VIDEO_WORKERS ||= String(Math.max(1, Math.min(2, Math.ceil(cpus / 4))));
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS ||= String(cpus);
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_VIDEO_WORKERS ||= String(cpus);
process.env.MOCHIMONO_PROVIDER_SHARP_WORKERS ||= process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS;

// Provider thumbnails decode arbitrary local files. Redirect only that Sharp
// import through a child-process proxy so a malformed image cannot kill the
// Agent or indexing work.
const providerThumbsUrl = new URL('./lib/provider-thumbs.js', import.meta.url).href;
const providerSharpProxyUrl = new URL('./lib/sharp-provider-proxy.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sharp' && context.parentURL === providerThumbsUrl) {
      return { url:providerSharpProxyUrl, shortCircuit:true };
    }
    return nextResolve(specifier, context);
  }
});

const { startProtectionAgent } = await import('./lib/protection-agent.js');
startProtectionAgent().catch(error => console.error('Protection agent failed', error));

// Bring up the Agent and backup workflows first. Media previews, metadata,
// Squish reconciliation, and other Library background services are loaded only
// when the Library is actually opened.
await import('./agent.js');
try {
  await import('./lib/friend-storage.js');
  await import('./lib/friend-auto.js');
} catch (error) {
  console.error('Friend Drive failed to start', error);
}
