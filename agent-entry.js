import { startThumbnailAgent } from './lib/thumbnail-agent.js';
import { startMediaMetadataAgent } from './lib/media-metadata-agent.js';

startThumbnailAgent();
startMediaMetadataAgent();
await import('./agent.js');
