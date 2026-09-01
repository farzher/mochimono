import { availableParallelism } from 'node:os';

const cpus = Math.max(1, availableParallelism());
process.env.MOCHIMONO_THUMBNAIL_WORKERS ||= String(Math.max(2, Math.min(8, Math.ceil(cpus / 2))));
process.env.MOCHIMONO_THUMBNAIL_VIDEO_WORKERS ||= String(Math.max(1, Math.min(2, Math.ceil(cpus / 4))));

const [{ startThumbnailAgent }, { startMediaMetadataAgent }, { startProtectionAgent }] = await Promise.all([
  import('./lib/thumbnail-agent.js'),
  import('./lib/media-metadata-agent.js'),
  import('./lib/protection-agent.js')
]);

startThumbnailAgent();
startMediaMetadataAgent();
startProtectionAgent().catch(error => console.error('Protection agent failed', error));
await import('./agent.js');
