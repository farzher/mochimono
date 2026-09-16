import { registerHooks } from 'node:module';
import { availableParallelism } from 'node:os';

const cpus = Math.max(1, availableParallelism());
process.env.MOCHIMONO_THUMBNAIL_WORKERS ||= String(Math.max(2, Math.min(8, Math.ceil(cpus / 2))));
process.env.MOCHIMONO_THUMBNAIL_VIDEO_WORKERS ||= String(Math.max(1, Math.min(2, Math.ceil(cpus / 4))));
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS ||= String(cpus);
process.env.MOCHIMONO_PROVIDER_THUMBNAIL_VIDEO_WORKERS ||= String(cpus);
process.env.MOCHIMONO_PROVIDER_SHARP_WORKERS ||= process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS;

const providerThumbsUrl = new URL('./lib/provider-thumbs.js', import.meta.url).href;
const providerSharpProxyUrl = new URL('./lib/sharp-provider-proxy.js', import.meta.url).href;
const agentSyncUrl = new URL('./lib/agent-sync.js', import.meta.url).href;
const agentUrl = new URL('./agent.js', import.meta.url).href;
const thumbnailLazyUrl = new URL('./lib/thumbnail-agent-lazy.js', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sharp' && context.parentURL === providerThumbsUrl) {
      return { url:providerSharpProxyUrl, shortCircuit:true };
    }
    if ((specifier === './thumbnail-agent.js' && context.parentURL === agentSyncUrl) ||
        (specifier === './lib/thumbnail-agent.js' && context.parentURL === agentUrl)) {
      return { url:thumbnailLazyUrl, shortCircuit:true };
    }
    return nextResolve(specifier, context);
  }
});

const { startProtectionAgent } = await import('./lib/protection-agent.js');
startProtectionAgent().catch(error => console.error('Protection agent failed', error));

// Bring up backup/protection first. Library media services stay unloaded until
// the Library is actually opened.
await import('./agent.js');
try {
  await import('./lib/friend-storage.js');
  await import('./lib/friend-auto.js');
} catch (error) {
  console.error('Friend Drive failed to start', error);
}
