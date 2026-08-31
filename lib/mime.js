import { extname } from 'node:path';

const MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.heic', 'image/heic'], ['.heif', 'image/heif'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'], ['.mpg', 'video/mpeg'], ['.mpeg', 'video/mpeg'], ['.m2v', 'video/mpeg'], ['.mts', 'video/mp2t'], ['.m2ts', 'video/mp2t'], ['.3gp', 'video/3gpp'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.flac', 'audio/flac'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.csv', 'text/csv'], ['.html', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'],
  ['.json', 'application/json'], ['.pdf', 'application/pdf'], ['.zip', 'application/zip'], ['.7z', 'application/x-7z-compressed'], ['.rar', 'application/vnd.rar']
]);

export function mimeFor(path, supplied = '') {
  return String(supplied || '').trim() || MIME.get(extname(path).toLowerCase()) || 'application/octet-stream';
}
