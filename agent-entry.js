import './agent-folder-stats.js';
import './agent-backup-policy.js';
import './client-import.js';
import './client-gateway.js';
import { startThumbnailAgent } from './lib/thumbnail-agent.js';
import { startMediaMetadataAgent } from './lib/media-metadata-agent.js';

startThumbnailAgent();
startMediaMetadataAgent();
await import('./agent.js');