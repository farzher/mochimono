import { basename } from 'node:path';
import { localDisplayDate } from './local-date.js';
import { mimeFor } from './mime.js';

const listeners = new Set();
const pending = new Map();
let resetPending = false;
let flushTimer = null;

function catalogFile(change) {
  const rootPath = String(change.rootPath || '');
  const originalPath = String(change.relativePath || '').replaceAll('\\', '/');
  const hash = String(change.hash || '');
  if (!rootPath || !originalPath || !/^[a-f0-9]{64}$/.test(hash)) return null;
  const mtimeMs = Math.trunc(Number(change.mtimeMs) || 0);
  const timeline = localDisplayDate(originalPath, mtimeMs);
  const date = new Date(timeline.ms).toISOString();
  const importId = Number(change.importId) || 0;
  const importIds = importId ? [importId] : [];
  return {
    hash,
    size:Math.max(0, Number(change.size) || 0),
    mime:mimeFor(originalPath),
    createdAt:date,
    filename:basename(originalPath),
    originalPath,
    fileDate:date,
    addedAt:date,
    dateSource:timeline.source,
    searchText:`${rootPath} ${originalPath}`,
    rootPath,
    localAvailable:true,
    localManaged:true,
    importIds,
    exactImportIds:importIds
  };
}

function flush() {
  flushTimer = null;
  if (!listeners.size) {
    pending.clear();
    resetPending = false;
    return;
  }
  const files = [...pending.values()];
  pending.clear();
  const reset = resetPending;
  resetPending = false;
  const payload = { files, reset };
  for (const listener of [...listeners]) {
    try { listener(payload); } catch {}
  }
}

function scheduleFlush() {
  if (flushTimer || !listeners.size) return;
  flushTimer = setTimeout(flush, 35);
  flushTimer.unref?.();
}

export const hasLocalCatalogSubscribers = () => listeners.size > 0;

export function publishLocalCatalogChange(change) {
  if (!listeners.size) return;
  const file = catalogFile(change);
  if (!file) return;
  const key = `${String(change.rootPath || '')}\0${file.originalPath}`;
  pending.set(key, file);
  scheduleFlush();
}

export function publishLocalCatalogReset() {
  if (!listeners.size) return;
  resetPending = true;
  scheduleFlush();
}

export function subscribeLocalCatalogChanges(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      pending.clear();
      resetPending = false;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
    }
  };
}
