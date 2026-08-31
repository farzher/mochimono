const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['m4v','mp4','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const AUDIO_EXTENSIONS = new Set(['mp3','m4a','aac','wav','flac','ogg','opus']);
const TYPE_ALIASES = new Map([
  ['photo','image'],['photos','image'],['picture','image'],['pictures','image'],['images','image'],
  ['videos','video'],['movies','video'],['music','audio'],
  ['document','application'],['documents','application'],['docs','application']
]);

export function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

export function fileKind(file) {
  const base = String(file?.mime || '').split('/')[0];
  if (base && base !== 'application') return base;
  const ext = extension(file?.filename);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (base === 'text') return 'text';
  return base || 'other';
}

export function normalizeText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = text => normalizeText(text).split(' ').filter(Boolean);
const encoded = text => normalizeText(text).replaceAll(' ', '_');
const fieldWords = (field, text) => words(text).map(word => `__${field}__${word}`);
const typeAlias = value => TYPE_ALIASES.get(normalizeText(value)) || normalizeText(value);

function pathQuery(text) {
  const raw = String(text || '').trim();
  if (!/^[a-z]:[\\/]/i.test(raw) && !/^[\\/]{1,2}/.test(raw)) return raw;
  return raw.split(/[\\/]+/).map(part => part.trim()).filter(Boolean).at(-1) || raw;
}

function tokens(raw) {
  const result = [];
  const regex = /(?:^|\s)(?:(name|path|source|type|ext|year):(?:"([^"]*)"|'([^']*)'|([^\s]+))|"([^"]*)"|'([^']*)'|([^\s]+))/giu;
  let match;
  while ((match = regex.exec(String(raw || '')))) {
    const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? '';
    if (text.trim()) result.push({ field: match[1]?.toLowerCase() || '', text: text.trim() });
  }
  return result;
}

export function buildSearchText(file, sourceNames = new Map()) {
  const kind = fileKind(file);
  const year = new Date(file.fileDate || file.createdAt || 0).getFullYear();
  const values = [
    normalizeText(`${file.filename || ''} ${file.originalPath || ''} ${file.searchText || ''}`),
    ...fieldWords('name', file.filename),
    ...fieldWords('path', `${file.originalPath || ''} ${file.searchText || ''}`),
    `__type__${encoded(kind)}`,
    ...(['image','video'].includes(kind) ? ['__type__media'] : []),
    ...(['application','text'].includes(kind) ? ['__type__application'] : []),
    `__ext__${encoded(extension(file.filename))}`,
    ...(Number.isFinite(year) ? [`__year__${year}`] : [])
  ];
  for (const id of file.importIds || []) {
    values.push(`__sourceid__${id}`);
    values.push(normalizeText(sourceNames.get(Number(id)) || ''));
  }
  return values.filter(Boolean).join(' ');
}

export function queryTerms(raw, sourceOptions = []) {
  const sourceToken = text => {
    const wanted = normalizeText(text);
    const options = [...sourceOptions].filter(option => option.value);
    const exact = options.find(option => normalizeText(option.textContent) === wanted);
    if (exact) return `__sourceid__${exact.value}`;
    const matches = options.filter(option => normalizeText(option.textContent).includes(wanted));
    return matches.length === 1 ? `__sourceid__${matches[0].value}` : `__sourceid__missing_${encoded(wanted)}`;
  };

  const result = [];
  for (const token of tokens(raw)) {
    if (token.field === 'name') result.push(...fieldWords('name', token.text));
    else if (token.field === 'path') result.push(...fieldWords('path', pathQuery(token.text)));
    else if (token.field === 'source') result.push(sourceToken(token.text));
    else if (token.field === 'type') result.push(`__type__${encoded(typeAlias(token.text))}`);
    else if (token.field === 'ext') result.push(`__ext__${encoded(token.text.replace(/^\./, ''))}`);
    else if (token.field === 'year') result.push(`__year__${encoded(token.text)}`);
    else result.push(...words(/[\\/]/.test(token.text) ? pathQuery(token.text) : token.text));
  }
  return result.filter(Boolean);
}

function sourcePath(source) {
  const root = String(source.rootPath || '').replace(/[\\/]+$/, '');
  const relative = String(source.path || '').replace(/^[\\/]+/, '');
  if (!root) return relative;
  if (!relative) return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function detailsFields(details) {
  const object = details?.object || {};
  const sources = Array.isArray(details?.sources) ? details.sources : [];
  const names = sources.map(item => item.filename || '');
  const paths = sources.flatMap(item => [sourcePath(item), item.path || '', item.rootPath || '']);
  const sourceNames = sources.map(item => normalizeText(item.sourceName || item.deviceName || '')).filter(Boolean);
  const filename = names[0] || object.filename || '';
  const date = new Date(details?.date?.fileDate || object.createdAt || 0);
  return {
    all: normalizeText(`${names.join(' ')} ${paths.join(' ')} ${sourceNames.join(' ')}`),
    name: normalizeText(names.join(' ')),
    path: normalizeText(paths.join(' ')),
    source: sourceNames.join(' '),
    sourceNames,
    type: normalizeText(fileKind({ filename, mime: object.mime })),
    ext: normalizeText(extension(filename)),
    year: Number.isNaN(date.getTime()) ? '' : String(date.getFullYear())
  };
}

export function matchesDetails(raw, details) {
  const fields = detailsFields(details);
  return tokens(raw).every(token => {
    if (token.field === 'type') {
      const wanted = typeAlias(token.text);
      if (wanted === 'media') return ['image','video'].includes(fields.type);
      if (wanted === 'application') return ['application','text'].includes(fields.type);
      return fields.type === wanted;
    }
    const text = token.field === 'path' || (!token.field && /[\\/]/.test(token.text)) ? pathQuery(token.text) : token.text;
    const field = token.field && fields[token.field] !== undefined ? token.field : 'all';
    return words(text).every(term => String(fields[field] || '').includes(term));
  });
}

export function matchesSmart(details, spec = {}) {
  const fields = detailsFields(details);
  if (spec.type) {
    const wanted = typeAlias(spec.type);
    const matches = wanted === 'media' ? ['image','video'].includes(fields.type)
      : wanted === 'application' ? ['application','text'].includes(fields.type)
      : fields.type === wanted;
    if (!matches) return false;
  }
  if (spec.sourceName && !fields.sourceNames.includes(normalizeText(spec.sourceName))) return false;
  return matchesDetails(spec.query || '', details);
}
