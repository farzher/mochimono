let compressionPromise = null;
let cloudImagePromise = null;
let imagePromise = null;
let videoPromise = null;

async function compressionModule() {
  await import('./compression-defaults.js');
  return import('./compression-work.js');
}

export async function handleCompressionWorkApi(...args) {
  compressionPromise ||= compressionModule();
  return (await compressionPromise).handleCompressionWorkApi(...args);
}

export async function handleCloudImageOptimizeApi(...args) {
  cloudImagePromise ||= import('./image-optimize-cloud.js');
  return (await cloudImagePromise).handleCloudImageOptimizeApi(...args);
}

export async function handleImageOptimizeApi(...args) {
  imagePromise ||= import('./image-optimize.js');
  return (await imagePromise).handleImageOptimizeApi(...args);
}

export async function handleVideoOptimizeApi(...args) {
  videoPromise ||= import('./video-optimize.js');
  return (await videoPromise).handleVideoOptimizeApi(...args);
}
