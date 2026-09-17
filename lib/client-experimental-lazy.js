let compressionPromise = null;
let cloudImagePromise = null;
let imagePromise = null;
let videoPromise = null;

export async function handleCompressionWorkApi(...args) {
  compressionPromise ||= import('./compression-work.js');
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
