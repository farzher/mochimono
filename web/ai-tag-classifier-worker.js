const DB_NAME = 'mochimono-ai';
const DB_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const EMBEDDING_SCHEMA = 3;
const DINO_INDEX_VERSION = 'dinov3-vitb16-v2';
const CLASSIFIER_VERSION = 'exact-v1';
const MAX_MATCHES = 10000;

const running = new Map();

function post(id, type, payload = {}) { self.postMessage({ id, type, ...payload }); }
function progress(id, done, total, detail) { post(id, 'progress', { stage:'classify', done, total, detail }); }
function aborted(id) { if (running.get(id)?.aborted) throw new DOMException('Aborted', 'AbortError'); }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('AI database transaction aborted'));
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function embeddingId(hash) { return `${DINO_INDEX_VERSION}:${hash}`; }

function record(row) {
  if (!row?.vector || Number(row.schema) !== EMBEDDING_SCHEMA || Number(row.normSq) <= 0) return null;
  return {
    data:row.vector instanceof Int8Array ? row.vector : Int8Array.from(row.vector),
    normSq:Number(row.normSq)
  };
}

function dot(left, right) {
  if (!left || !right) return -1;
  const a = left.data;
  const b = right.data;
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index++) total += a[index] * b[index];
  return total / Math.sqrt(left.normSq * right.normSq);
}

function insertTop(top, value, limit = 4) {
  if (!Number.isFinite(value)) return;
  let index = 0;
  while (index < top.length && top[index] >= value) index++;
  if (index >= limit) return;
  top.splice(index, 0, value);
  if (top.length > limit) top.length = limit;
}

function affinity(top) {
  if (!top.length) return -1;
  const weights = [.55, .25, .13, .07];
  let total = 0;
  let weight = 0;
  for (let index = 0; index < top.length; index++) {
    const current = weights[index] ?? .04;
    total += top[index] * current;
    weight += current;
  }
  return total / Math.max(.0001, weight);
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = clamp(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function scoresAgainst(candidate, examples, skipHash = '') {
  const top = [];
  let bestHash = '';
  let best = -1;
  for (const example of examples) {
    if (skipHash && example.hash === skipHash) continue;
    const similarity = dot(candidate, example.record);
    if (similarity > best) { best = similarity; bestHash = example.hash; }
    insertTop(top, similarity);
  }
  return { best, bestHash, affinity:affinity(top), top };
}

async function loadExamples(db, hashes) {
  const wanted = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!wanted.length) return [];
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const store = tx.objectStore(EMBEDDINGS);
  const rows = await Promise.all(wanted.map(hash => requestResult(store.get(embeddingId(hash))).then(row => ({ hash, row }))));
  await transactionDone(tx).catch(() => {});
  return rows.map(({ hash, row }) => {
    const value = record(row);
    return value ? { hash, record:value } : null;
  }).filter(Boolean);
}

function calibrate(positives, negatives) {
  if (positives.length === 1) {
    return {
      nearestFloor:.62,
      affinityFloor:.62,
      nearestMarginFloor:negatives.length ? .01 : null,
      affinityMarginFloor:negatives.length ? .01 : null
    };
  }

  const nearest = [];
  const affinities = [];
  const nearestMargins = [];
  const affinityMargins = [];

  for (const positive of positives) {
    const positiveScore = scoresAgainst(positive.record, positives, positive.hash);
    if (positiveScore.best >= 0) nearest.push(positiveScore.best);
    if (positiveScore.affinity >= 0) affinities.push(positiveScore.affinity);

    if (negatives.length) {
      const negativeScore = scoresAgainst(positive.record, negatives);
      if (positiveScore.best >= 0 && negativeScore.best >= 0) nearestMargins.push(positiveScore.best - negativeScore.best);
      if (positiveScore.affinity >= 0 && negativeScore.affinity >= 0) affinityMargins.push(positiveScore.affinity - negativeScore.affinity);
    }
  }

  // Learn the low edge of the positive class, then leave some room for unseen
  // members. Hard negatives, when supplied, are the main precision boundary.
  return {
    nearestFloor:clamp((quantile(nearest, .01) ?? .64) - .08, .30, .86),
    affinityFloor:clamp((quantile(affinities, .01) ?? .60) - .08, .28, .84),
    nearestMarginFloor:negatives.length
      ? clamp((quantile(nearestMargins, .05) ?? .01) - .04, -.03, .12)
      : null,
    affinityMarginFloor:negatives.length
      ? clamp((quantile(affinityMargins, .05) ?? .01) - .04, -.03, .12)
      : null
  };
}

async function classify(id, payload) {
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const allowed = new Set(media.map(file => String(file?.hash || '')).filter(hash => /^[a-f0-9]{64}$/.test(hash)));
  const positiveHashes = [...new Set((payload?.positives || []).map(String).filter(hash => allowed.has(hash)))];
  const positiveSet = new Set(positiveHashes);
  const negativeHashes = [...new Set((payload?.negatives || []).map(String).filter(hash => allowed.has(hash) && !positiveSet.has(hash)))];
  if (!positiveHashes.length) return { matches:[], stats:{ version:CLASSIFIER_VERSION, positiveExamples:0, negativeExamples:negativeHashes.length, scanned:0 } };

  const db = await openDb();
  try {
    progress(id, 0, 3, `Visual AI ${CLASSIFIER_VERSION} · loading all labeled examples…`);
    const [positives, negatives] = await Promise.all([
      loadExamples(db, positiveHashes),
      loadExamples(db, negativeHashes)
    ]);
    aborted(id);
    if (!positives.length) throw new Error('None of the positive examples have a DINO visual index.');

    const thresholds = calibrate(positives, negatives);
    progress(id, 1, 3,
      `Visual AI ${CLASSIFIER_VERSION} · ${positives.length.toLocaleString()} positive · ${negatives.length.toLocaleString()} negative · exact all-example scan`);

    const excluded = new Set([...positiveHashes, ...negativeHashes]);
    const matches = [];
    let scanned = 0;
    const tx = db.transaction(EMBEDDINGS, 'readonly');
    const cursorRequest = tx.objectStore(EMBEDDINGS).index('model').openCursor(IDBKeyRange.only(DINO_INDEX_VERSION));

    await new Promise((resolve, reject) => {
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        try {
          aborted(id);
          const cursor = cursorRequest.result;
          if (!cursor) return resolve();
          const row = cursor.value;
          const hash = String(row?.hash || '');
          if (!allowed.has(hash) || excluded.has(hash)) {
            cursor.continue();
            return;
          }
          const candidate = record(row);
          if (!candidate) {
            cursor.continue();
            return;
          }

          const positive = scoresAgainst(candidate, positives);
          const broadPositive = positive.affinity >= thresholds.affinityFloor;
          const nearestPositive = positive.best >= thresholds.nearestFloor;
          scanned++;

          if (broadPositive || nearestPositive) {
            const negative = negatives.length ? scoresAgainst(candidate, negatives) : { best:-1, affinity:-1 };
            const nearestMargin = negatives.length ? positive.best - negative.best : null;
            const affinityMargin = negatives.length ? positive.affinity - negative.affinity : null;
            const broadContrast = !negatives.length || (broadPositive && affinityMargin >= thresholds.affinityMarginFloor);
            const nearestContrast = !negatives.length || (nearestPositive && nearestMargin >= thresholds.nearestMarginFloor);

            // A hard negative that is clearly closer than every positive wins.
            if ((broadContrast || nearestContrast) && (!negatives.length || negative.best <= positive.best + .01)) {
              const positiveStrength = Math.max(
                clamp((positive.best - thresholds.nearestFloor) / Math.max(.08, 1 - thresholds.nearestFloor)),
                clamp((positive.affinity - thresholds.affinityFloor) / Math.max(.08, 1 - thresholds.affinityFloor))
              );
              const contrastStrength = negatives.length
                ? Math.max(
                    clamp((nearestMargin - thresholds.nearestMarginFloor) / .14),
                    clamp((affinityMargin - thresholds.affinityMarginFloor) / .14)
                  )
                : .5;
              const confidence = clamp(.55 + positiveStrength * .31 + contrastStrength * .13, .55, .99);
              matches.push({
                hash,
                confidence,
                similarity:positive.best,
                affinity:positive.affinity,
                nearestPositive:positive.bestHash,
                negativeAffinity:negatives.length ? negative.affinity : null,
                nearestMargin,
                affinityMargin
              });
            }
          }

          if (scanned && scanned % 500 === 0) {
            progress(id, 2, 3,
              `Visual AI ${CLASSIFIER_VERSION} · checked ${scanned.toLocaleString()} media · ${matches.length.toLocaleString()} matches`);
          }
          cursor.continue();
        } catch (error) { reject(error); }
      };
    });
    await transactionDone(tx).catch(() => {});
    aborted(id);

    matches.sort((a, b) => b.confidence - a.confidence || b.similarity - a.similarity || a.hash.localeCompare(b.hash));
    const truncated = matches.length > MAX_MATCHES;
    const resultMatches = matches.slice(0, MAX_MATCHES);
    const stats = {
      version:CLASSIFIER_VERSION,
      positiveExamples:positives.length,
      negativeExamples:negatives.length,
      scanned,
      matches:resultMatches.length,
      truncated,
      nearestFloor:Number(thresholds.nearestFloor.toFixed(3)),
      affinityFloor:Number(thresholds.affinityFloor.toFixed(3)),
      nearestMarginFloor:thresholds.nearestMarginFloor == null ? null : Number(thresholds.nearestMarginFloor.toFixed(3)),
      affinityMarginFloor:thresholds.affinityMarginFloor == null ? null : Number(thresholds.affinityMarginFloor.toFixed(3))
    };
    progress(id, 3, 3,
      `Visual AI ${CLASSIFIER_VERSION} · ${resultMatches.length.toLocaleString()} matches · checked every indexed file against all ${positives.length.toLocaleString()} positive${negatives.length ? ` + ${negatives.length.toLocaleString()} negative` : ''} examples${truncated ? ' · capped at 10,000' : ''}`);
    return { matches:resultMatches, stats };
  } finally {
    db.close();
  }
}

self.onmessage = async event => {
  const data = event.data || {};
  const id = String(data.id || '');
  if (!id) return;
  if (data.action === 'cancel') {
    const job = running.get(String(data.cancelId || id));
    if (job) job.aborted = true;
    return;
  }
  running.set(id, { aborted:false });
  try {
    if (data.action !== 'classify') throw new Error(`Unknown AI tag classifier action: ${data.action}`);
    const result = await classify(id, data.payload || {});
    aborted(id);
    post(id, 'result', { result });
  } catch (error) {
    post(id, 'error', {
      error:error?.name === 'AbortError' ? 'Canceled' : (error?.message || String(error)),
      aborted:error?.name === 'AbortError'
    });
  } finally {
    running.delete(id);
  }
};
