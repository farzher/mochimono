const MIN_REAL_DATE_MS = Date.UTC(1981, 0, 1);
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

function validDate(year, month, day, hour = 12, minute = 0, second = 0) {
  const nowYear = new Date().getFullYear();
  if (year < 1990 || year > nowYear + 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return 0;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return 0;
  return date.getTime();
}

function filenameDate(value) {
  const text = String(value || '');
  let match = text.match(/(?:^|[^0-9])((?:19|20)\d{2})(\d{2})(\d{2})(?:[^0-9]?(\d{2})(\d{2})(\d{2}))?(?:[^0-9]|$)/);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 12), Number(match[5] ?? 0), Number(match[6] ?? 0));
  match = text.match(/(?:^|[^0-9])((?:19|20)\d{2})[-_.](\d{2})[-_.](\d{2})(?:[ T_-](\d{2})[-_.:](\d{2})(?:[-_.:](\d{2}))?)?(?:[^0-9]|$)/);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 12), Number(match[5] ?? 0), Number(match[6] ?? 0));
  return 0;
}

function plausible(ms) {
  ms = Number(ms) || 0;
  return ms >= MIN_REAL_DATE_MS && ms <= Date.now() + MAX_FUTURE_MS ? ms : 0;
}

export function localDisplayDate(value, mtimeMs, birthtimeMs = 0) {
  const modified = plausible(mtimeMs);
  if (modified) return { ms: modified, source: 'filesystem.mtime' };

  const named = filenameDate(value);
  if (named) return { ms: named, source: 'filename' };

  const created = plausible(birthtimeMs);
  if (created) return { ms: created, source: 'filesystem.created' };

  const raw = Number(mtimeMs) || Number(birthtimeMs) || Date.now();
  return { ms: raw, source: 'filesystem.unknown' };
}
