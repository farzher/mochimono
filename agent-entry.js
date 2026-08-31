import './runtime-fixes.js';
import './agent-folder-stats.js';
import './agent-backup-policy.js';
import './client-import.js';
import './client-preview-worker.js';
import './client-gateway.js';

const { startThumbnailAgent } = await import('./lib/thumbnail-agent.js');
const { startMediaMetadataAgent } = await import('./lib/media-metadata-agent.js');

startThumbnailAgent();
startMediaMetadataAgent();
await import('./agent.js');