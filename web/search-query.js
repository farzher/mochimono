const search = document.querySelector('#search');
const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
const SEARCH_INDEX_VERSION = '6';
const SEARCH_INDEX_KEY = 'mochimono-search-index-version';
const nativeFetch = window.fetch.bind(window);

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

function encoded(text) {
  return normalizeText(text).replaceAll(' ', '_');
}

function fieldWords(field, text) {
  return words(text).map(word => `__${field}__${word}`);
}

function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

function fileKind(file) {
  const mime = String(file.mime || '');
  const base = mime.split('/')[0];
  if (base && base !== 'application') return base;
  const ext = extension(file.filename);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (base === 'text') return 'text';
  return base || 'other';
}

function typeFields(file) {
  const kind = fileKind(file);
  const values = [kind];
  if (kind === 'image' || kind === 'video') values.push('media');
  if (kind === 'application' || kind === 'text') values.push('application');
  return [...new Set(values)].map(value => `__type__${encoded(value)}`);
}

function yearFor(file) {
  const date = new Date(file.fileDate || file.createdAt || 0);
  return Number.isNaN(date.getTime()) ? '' : String(date.getFullYear());
}

function augmentCatalogFile(file) {
  const all = normalizeText(`${file.filename || ''} ${file.originalPath || ''} ${file.searchText || ''}`);
  const fields = [
    all,
    ...fieldWords('name', file.filename),
    ...fieldWords('path', `${file.originalPath || ''} ${file.searchText || ''}`),
    ...typeFields(file),
    `__ext__${encoded(extension(file.filename))}`,
    `__year__${encoded(yearFor(file))}`
  ];
  const importIds = Array.isArray(file.importIds)
    ? file.importIds
    : String(file.importIds || '').split(',').filter(Boolean);
  for (const id of importIds) fields.push(`__sourceid__${String(id).trim()}`);
  file.searchText = `${file.searchText || ''} ${fields.filter(Boolean).join(' ')}`.trim();
  return file;
}

window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  if (!response.ok) return response;
  let pathname = '';
  try {
    const input = args[0] instanceof Request ? args[0].url : String(args[0]);
    pathname = new URL(input, location.href).pathname;
  } catch {}
  if (pathname !== '/api/catalog') return response;

  try {
    const data = await response.clone().json();
    if (!Array.isArray(data.files)) return response;
    data.files = data.files.map(augmentCatalogFile);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch {
    return response;
  }
};

function pathTail(text, count = 2) {
  const parts = String(text || '').split(/[\\/]+/).map(part => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(-count).join(' ') : String(text || '');
}

function tokenize(raw) {
  const tokens = [];
  const regex = /(?:^|\s)(?:(name|path|source|type|ext|year):(?:"([^"]*)"|'([^']*)'|([^\s]+))|"([^"]*)"|'([^']*)'|([^\s]+))/giu;
  let match;
  while ((match = regex.exec(String(raw || '')))) {
    const field = match[1]?.toLowerCase() || '';
    const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? '';
    if (text.trim()) tokens.push({ field, text: text.trim() });
  }
  return tokens;
}

function sourceToken(text) {
  const wanted = normalizeText(text);
  if (!wanted) return '';
  const select = document.querySelector('#source');
  const options = select ? [...select.options].filter(option => option.value) : [];
  const exact = options.find(option => normalizeText(option.textContent) === wanted);
  if (exact) return `__sourceid__${exact.value}`;
  const matches = options.filter(option => normalizeText(option.textContent).includes(wanted));
  if (matches.length === 1) return `__sourceid__${matches[0].value}`;
  if (options.length) return `__sourceid__missing_${encoded(wanted)}`;
  return wanted;
}

function typeToken(text) {
  const aliases = new Map([
    ['photo', 'image'], ['photos', 'image'], ['picture', 'image'], ['pictures', 'image'], ['images', 'image'],
    ['videos', 'video'], ['movies', 'video'], ['music', 'audio'], ['documents', 'application'], ['document', 'application'], ['docs', 'application']
  ]);
  const normalized = normalizeText(text);
  return aliases.get(normalized) || normalized;
}

function queryTerms(raw) {
  const result = [];
  for (const token of tokenize(raw)) {
    if (token.field === 'name') {
      result.push(...fieldWords('name', token.text));
      continue;
    }
    if (token.field === 'path') {
      result.push(...fieldWords('path', pathTail(token.text, 2)));
      continue;
    }
    if (token.field === 'source') {
      result.push(sourceToken(token.text));
      continue;
    }
    if (token.field === 'type') {
      result.push(`__type__${encoded(typeToken(token.text))}`);
      continue;
    }
    if (token.field === 'ext') {
      result.push(`__ext__${encoded(String(token.text).replace(/^\./, ''))}`);
      continue;
    }
    if (token.field === 'year') {
      result.push(`__year__${encoded(token.text)}`);
      continue;
    }

    const searchable = /[\\/]/.test(token.text) ? pathTail(token.text, 2) : token.text;
    result.push(...words(searchable));
  }
  return result.filter(Boolean);
}

function transformedQuery(raw) {
  return queryTerms(raw).join(' ');
}

function rawSearch() {
  return search && valueDescriptor?.get ? valueDescriptor.get.call(search) : '';
}

function setRawSearch(text, notify = true) {
  if (!search || !valueDescriptor?.set) return;
  valueDescriptor.set.call(search, String(text || ''));
  if (notify) search.dispatchEvent(new Event('input', { bubbles: true }));
}

function detailsHaystacks(details) {
  const object = details?.object || {};
  const sources = Array.isArray(details?.sources) ? details.sources : [];
  const names = sources.map(item => item.filename || '');
  const paths = sources.map(item => item.path || '');
  const sourceNames = sources.map(item => normalizeText(item.sourceName || '')).filter(Boolean);
  const representative = names[0] || object.filename || '';
  const kind = fileKind({ filename: representative, mime: object.mime });
  const ext = extension(representative);
  const dates = sources.map(item => new Date(item.mtime || 0).getTime()).filter(Number.isFinite);
  const date = dates.length ? new Date(Math.max(...dates)) : new Date(object.createdAt || 0);
  const year = Number.isNaN(date.getTime()) ? '' : String(date.getFullYear());
  return {
    all: normalizeText(`${names.join(' ')} ${paths.join(' ')} ${sourceNames.join(' ')}`),
    name: normalizeText(names.join(' ')),
    path: normalizeText(paths.join(' ')),
    source: sourceNames.join(' '),
    sourceNames,
    type: normalizeText(kind),
    ext: normalizeText(ext),
    year
  };
}

function queryMatchesDetails(raw, details) {
  const hay = detailsHaystacks(details);
  return tokenize(raw).every(token => {
    let wanted = token.text;
    if (token.field === 'type') {
      const type = typeToken(wanted);
      if (type === 'media') return ['image', 'video'].includes(hay.type);
      if (type === 'application') return ['application', 'text'].includes(hay.type);
      return hay.type === type;
    }
    if (token.field === 'path') wanted = pathTail(wanted, 2);
    if (!token.field && /[\\/]/.test(wanted)) wanted = pathTail(wanted, 2);
    const terms = words(wanted);
    const field = token.field && hay[token.field] !== undefined ? token.field : 'all';
    return terms.every(term => String(hay[field] || '').includes(term));
  });
}

function matchesSmart(details, spec = {}) {
  const hay = detailsHaystacks(details);
  if (spec.type) {
    const wanted = typeToken(spec.type);
    if (wanted === 'media') {
      if (!['image', 'video'].includes(hay.type)) return false;
    } else if (wanted === 'application') {
      if (!['application', 'text'].includes(hay.type)) return false;
    } else if (hay.type !== wanted) return false;
  }
  if (spec.sourceName && !hay.sourceNames.includes(normalizeText(spec.sourceName))) return false;
  return queryMatchesDetails(spec.query || '', details);
}

async function refreshIndexOnce() {
  if (!('indexedDB' in window) || localStorage.getItem(SEARCH_INDEX_KEY) === SEARCH_INDEX_VERSION) return;
  await new Promise(resolve => {
    const request = indexedDB.deleteDatabase('mochimono-catalog');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  localStorage.setItem(SEARCH_INDEX_KEY, SEARCH_INDEX_VERSION);
}

await refreshIndexOnce();

if (search && valueDescriptor?.get && valueDescriptor?.set) {
  Object.defineProperty(search, 'value', {
    configurable: true,
    get() {
      return transformedQuery(rawSearch());
    },
    set(next) {
      valueDescriptor.set.call(this, next);
    }
  });
}

window.mochimonoSearch = {
  raw: rawSearch,
  setRaw: setRawSearch,
  normalize: normalizeText,
  matchesDetails: queryMatchesDetails,
  matchesSmart
};
