import { libraryDemanded } from './library-demand.js';
import { previewState } from './preview-state.js';

let actual = null;
let loading = null;

function load() {
  if (actual) return Promise.resolve(actual);
  if (loading) return loading;
  loading = import('./thumbnail-agent.js').then(module => {
    actual = module;
    module.startThumbnailAgent();
    return module;
  }).finally(() => { loading = null; });
  return loading;
}

export function queueLocalThumbnail(record) {
  load().then(module => module.queueLocalThumbnail(record)).catch(() => {});
  return true;
}

export function setThumbnailIngestBusy(value) {
  load().then(module => module.setThumbnailIngestBusy(value)).catch(() => {});
}

export function thumbnailAgentStatus() {
  if (actual) return actual.thumbnailAgentStatus();
  if (libraryDemanded()) load().catch(() => {});
  return {
    workers:0,
    videoWorkers:0,
    ingestBusy:false,
    urgent:0,
    priority:0,
    queued:0,
    active:0,
    activeVideo:0,
    waitingForIdle:false,
    failed:0,
    pendingUploads:Number(previewState.uploadStats().pending) || 0,
    cloudWaiting:true,
    dormant:true
  };
}

if (previewState.uploadStats().pending) load().catch(error => console.warn('Preview upload resume failed:', error.message));
