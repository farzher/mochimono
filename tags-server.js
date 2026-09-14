import { db, json, now, readJson } from './lib/server-context.js';
import { validHash } from './lib/store.js';

const MAX_BATCH = 10000;

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw Object.assign(new Error('Tag name is required'), { status:400 });
  return name;
}

function cleanDescription(value) {
  return String(value || '').trim().slice(0, 500);
}

function tag(id) {
  return db.prepare(`
    SELECT id, name, description, ai_enabled AS aiEnabled, builtin,
           created_at AS createdAt, updated_at AS updatedAt
    FROM tags WHERE id = ?
  `).get(Number(id));
}

function cleanHashes(value) {
  if (!Array.isArray(value) || value.length > MAX_BATCH) {
    throw Object.assign(new Error(`hashes must be an array of at most ${MAX_BATCH} SHA-256 hashes`), { status:400 });
  }
  const hashes = [...new Set(value.map(String))];
  if (hashes.some(hash => !validHash(hash))) throw Object.assign(new Error('Invalid SHA-256 hash'), { status:400 });
  return hashes;
}

function listTags() {
  return db.prepare(`
    SELECT t.id, t.name, t.description, t.ai_enabled AS aiEnabled, t.builtin,
           t.created_at AS createdAt, t.updated_at AS updatedAt,
           COUNT(tm.object_hash) AS count,
           COALESCE(SUM(tm.source = 'manual'), 0) AS manualCount,
           COALESCE(SUM(tm.source = 'ai'), 0) AS aiCount,
           COALESCE(SUM(tm.source = 'system'), 0) AS systemCount,
           (SELECT COUNT(*) FROM (
             SELECT object_hash FROM tag_members WHERE tag_id = t.id AND source = 'manual'
             UNION
             SELECT object_hash FROM tag_examples WHERE tag_id = t.id AND polarity = 1
           )) AS positiveExamples,
           (SELECT COUNT(*) FROM (
             SELECT object_hash FROM tag_suppressions WHERE tag_id = t.id
             UNION
             SELECT object_hash FROM tag_examples WHERE tag_id = t.id AND polarity = -1
           )) AS negativeExamples,
           (SELECT COUNT(*) FROM tag_suppressions ts WHERE ts.tag_id = t.id) AS suppressed
    FROM tags t
    LEFT JOIN tag_members tm ON tm.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.builtin DESC, lower(t.name), t.name
  `).all().map(row => ({
    ...row,
    aiEnabled:Boolean(row.aiEnabled), builtin:Boolean(row.builtin),
    count:Number(row.count) || 0, manualCount:Number(row.manualCount) || 0,
    aiCount:Number(row.aiCount) || 0, systemCount:Number(row.systemCount) || 0,
    positiveExamples:Number(row.positiveExamples) || 0,
    negativeExamples:Number(row.negativeExamples) || 0,
    suppressed:Number(row.suppressed) || 0
  }));
}

function fileTags(hash) {
  return db.prepare(`
    SELECT t.id, t.name, tm.source, tm.confidence, tm.added_at AS addedAt
    FROM tag_members tm JOIN tags t ON t.id = tm.tag_id
    WHERE tm.object_hash = ?
    ORDER BY lower(t.name), t.name
  `).all(hash).map(row => ({
    ...row,
    confidence:row.confidence == null ? null : Number(row.confidence)
  }));
}

function tagState(id) {
  const current = tag(id);
  if (!current) return null;
  const members = db.prepare(`
    SELECT object_hash AS hash, source, confidence, added_at AS addedAt
    FROM tag_members
    WHERE tag_id = ?
    ORDER BY source, confidence DESC, added_at DESC
  `).all(current.id).map(row => ({
    ...row,
    confidence:row.confidence == null ? null : Number(row.confidence)
  }));

  // Manual membership is a positive teaching decision; suppression is a
  // negative correction. Synthesize them with explicit examples so tagging a
  // file once is enough to teach the AI.
  const exampleMap = new Map();
  for (const row of db.prepare(`
    SELECT object_hash AS hash, polarity, added_at AS addedAt
    FROM tag_examples WHERE tag_id = ? ORDER BY added_at
  `).all(current.id)) exampleMap.set(row.hash, row);
  for (const member of members) {
    if (member.source === 'manual' && !exampleMap.has(member.hash)) {
      exampleMap.set(member.hash, { hash:member.hash, polarity:1, addedAt:member.addedAt });
    }
  }

  const suppressedRows = db.prepare(`
    SELECT object_hash AS hash, created_at AS addedAt
    FROM tag_suppressions WHERE tag_id = ? ORDER BY created_at
  `).all(current.id);
  for (const row of suppressedRows) {
    exampleMap.set(row.hash, { hash:row.hash, polarity:-1, addedAt:row.addedAt });
  }

  return {
    tag:{ ...current, aiEnabled:Boolean(current.aiEnabled), builtin:Boolean(current.builtin) },
    members,
    examples:[...exampleMap.values()],
    suppressed:suppressedRows.map(row => row.hash)
  };
}

function addMembers(id, hashes, source = 'manual', confidence = null) {
  const current = tag(id);
  if (!current) throw Object.assign(new Error('Tag not found'), { status:404 });
  hashes = cleanHashes(hashes);
  source = ['manual','ai','system'].includes(source) ? source : 'manual';
  const insert = db.prepare(`
    INSERT INTO tag_members(tag_id, object_hash, source, confidence, added_at) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(tag_id, object_hash) DO UPDATE SET
      source=CASE WHEN tag_members.source = 'manual' AND excluded.source != 'manual' THEN 'manual' ELSE excluded.source END,
      confidence=CASE WHEN tag_members.source = 'manual' AND excluded.source != 'manual' THEN tag_members.confidence ELSE excluded.confidence END,
      added_at=CASE WHEN tag_members.source = 'manual' AND excluded.source != 'manual' THEN tag_members.added_at ELSE excluded.added_at END
  `);
  const unsuppress = db.prepare('DELETE FROM tag_suppressions WHERE tag_id = ? AND object_hash = ?');
  const teachPositive = db.prepare(`
    INSERT INTO tag_examples(tag_id, object_hash, polarity, added_at) VALUES(?, ?, 1, ?)
    ON CONFLICT(tag_id, object_hash) DO UPDATE SET polarity=1, added_at=excluded.added_at
  `);
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const hash of hashes) {
      if (source === 'manual') {
        unsuppress.run(current.id, hash);
        teachPositive.run(current.id, hash, timestamp);
      }
      insert.run(
        current.id,
        hash,
        source,
        confidence == null ? null : Math.max(0, Math.min(1, Number(confidence) || 0)),
        timestamp
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return hashes.length;
}

function replaceAiMembers(id, matches, source = 'ai') {
  const current = tag(id);
  if (!current) throw Object.assign(new Error('Tag not found'), { status:404 });
  if (!Array.isArray(matches) || matches.length > MAX_BATCH) {
    throw Object.assign(new Error(`matches must be an array of at most ${MAX_BATCH} items`), { status:400 });
  }
  source = source === 'system' ? 'system' : 'ai';
  const hashes = cleanHashes(matches.map(item => item?.hash));
  const allowed = new Set(hashes);
  const suppression = new Set(
    db.prepare('SELECT object_hash AS hash FROM tag_suppressions WHERE tag_id = ?')
      .all(current.id).map(row => row.hash)
  );
  const confidence = new Map(matches.map(item => [
    String(item?.hash || ''),
    Math.max(0, Math.min(1, Number(item?.confidence) || 0))
  ]));
  const remove = db.prepare("DELETE FROM tag_members WHERE tag_id = ? AND source IN ('ai', 'system')");
  const insert = db.prepare(`
    INSERT INTO tag_members(tag_id, object_hash, source, confidence, added_at) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(tag_id, object_hash) DO UPDATE SET
      source=CASE WHEN tag_members.source = 'manual' THEN 'manual' ELSE excluded.source END,
      confidence=CASE WHEN tag_members.source = 'manual' THEN tag_members.confidence ELSE excluded.confidence END,
      added_at=CASE WHEN tag_members.source = 'manual' THEN tag_members.added_at ELSE excluded.added_at END
  `);
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    remove.run(current.id);
    for (const hash of allowed) {
      if (suppression.has(hash)) continue;
      insert.run(current.id, hash, source, confidence.get(hash) ?? null, timestamp);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return Number(db.prepare('SELECT COUNT(*) AS count FROM tag_members WHERE tag_id = ? AND source = ?').get(current.id, source)?.count) || 0;
}

function removeMembers(id, hashes, suppress) {
  const current = tag(id);
  if (!current) throw Object.assign(new Error('Tag not found'), { status:404 });
  hashes = cleanHashes(hashes);
  const remove = db.prepare('DELETE FROM tag_members WHERE tag_id = ? AND object_hash = ?');
  const block = db.prepare('INSERT OR REPLACE INTO tag_suppressions(tag_id, object_hash, created_at) VALUES(?, ?, ?)');
  const teachNegative = db.prepare(`
    INSERT INTO tag_examples(tag_id, object_hash, polarity, added_at) VALUES(?, ?, -1, ?)
    ON CONFLICT(tag_id, object_hash) DO UPDATE SET polarity=-1, added_at=excluded.added_at
  `);
  const forgetPositive = db.prepare('DELETE FROM tag_examples WHERE tag_id = ? AND object_hash = ? AND polarity = 1');
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const hash of hashes) {
      remove.run(current.id, hash);
      if (suppress) {
        block.run(current.id, hash, timestamp);
        teachNegative.run(current.id, hash, timestamp);
      } else {
        forgetPositive.run(current.id, hash);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return hashes.length;
}

function setExamples(id, positive, negative) {
  const current = tag(id);
  if (!current) throw Object.assign(new Error('Tag not found'), { status:404 });
  positive = cleanHashes(positive || []);
  negative = cleanHashes(negative || []);
  const positives = new Set(positive);
  negative = negative.filter(hash => !positives.has(hash));
  const clear = db.prepare('DELETE FROM tag_examples WHERE tag_id = ?');
  const insert = db.prepare('INSERT INTO tag_examples(tag_id, object_hash, polarity, added_at) VALUES(?, ?, ?, ?)');
  const manual = db.prepare(`
    INSERT INTO tag_members(tag_id, object_hash, source, confidence, added_at) VALUES(?, ?, 'manual', NULL, ?)
    ON CONFLICT(tag_id, object_hash) DO UPDATE SET source='manual', confidence=NULL, added_at=excluded.added_at
  `);
  const remove = db.prepare('DELETE FROM tag_members WHERE tag_id = ? AND object_hash = ?');
  const suppress = db.prepare('INSERT OR REPLACE INTO tag_suppressions(tag_id, object_hash, created_at) VALUES(?, ?, ?)');
  const unsuppress = db.prepare('DELETE FROM tag_suppressions WHERE tag_id = ? AND object_hash = ?');
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    clear.run(current.id);
    for (const hash of positive) {
      insert.run(current.id, hash, 1, timestamp);
      manual.run(current.id, hash, timestamp);
      unsuppress.run(current.id, hash);
    }
    for (const hash of negative) {
      insert.run(current.id, hash, -1, timestamp);
      remove.run(current.id, hash);
      suppress.run(current.id, hash, timestamp);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { positive:positive.length, negative:negative.length };
}

export async function handleTags(req, res, url) {
  if (!url.pathname.startsWith('/api/tags')) return false;

  if (req.method === 'GET' && url.pathname === '/api/tags') {
    json(res, 200, { tags:listTags() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tags') {
    const body = await readJson(req, 32 * 1024);
    const name = cleanName(body.name);
    const timestamp = now();
    try {
      const result = db.prepare(`
        INSERT INTO tags(name, description, ai_enabled, builtin, created_at, updated_at)
        VALUES(?, ?, ?, 0, ?, ?)
      `).run(name, cleanDescription(body.description), body.aiEnabled ? 1 : 0, timestamp, timestamp);
      json(res, 201, { tag:tag(Number(result.lastInsertRowid)) });
    } catch (error) {
      if (/unique/i.test(String(error?.message || ''))) json(res, 409, { error:'A tag with that name already exists' });
      else throw error;
    }
    return true;
  }

  const fileMatch = /^\/api\/tags\/file\/([a-f0-9]{64})$/.exec(url.pathname);
  if (fileMatch && req.method === 'GET') {
    json(res, 200, { tags:fileTags(fileMatch[1]) });
    return true;
  }

  const tagMatch = /^\/api\/tags\/(\d+)$/.exec(url.pathname);
  if (tagMatch && req.method === 'GET') {
    const state = tagState(tagMatch[1]);
    json(res, state ? 200 : 404, state || { error:'Tag not found' });
    return true;
  }
  if (tagMatch && req.method === 'POST') {
    const current = tag(tagMatch[1]);
    if (!current) { json(res, 404, { error:'Tag not found' }); return true; }
    const body = await readJson(req, 32 * 1024);
    const name = body.name == null ? current.name : cleanName(body.name);
    const description = body.description == null ? current.description : cleanDescription(body.description);
    const aiEnabled = body.aiEnabled == null ? Number(current.aiEnabled) : (body.aiEnabled ? 1 : 0);
    try {
      db.prepare('UPDATE tags SET name = ?, description = ?, ai_enabled = ?, updated_at = ? WHERE id = ?')
        .run(name, description, aiEnabled, now(), current.id);
      json(res, 200, { tag:tag(current.id) });
    } catch (error) {
      if (/unique/i.test(String(error?.message || ''))) json(res, 409, { error:'A tag with that name already exists' });
      else throw error;
    }
    return true;
  }
  if (tagMatch && req.method === 'DELETE') {
    const current = tag(tagMatch[1]);
    if (!current) { json(res, 404, { error:'Tag not found' }); return true; }
    if (current.builtin) { json(res, 400, { error:'Built-in tags cannot be deleted' }); return true; }
    db.prepare('DELETE FROM tags WHERE id = ?').run(current.id);
    json(res, 200, { ok:true });
    return true;
  }

  const membersMatch = /^\/api\/tags\/(\d+)\/members$/.exec(url.pathname);
  if (membersMatch && req.method === 'POST') {
    const body = await readJson(req, 2 * 1024 * 1024);
    json(res, 200, {
      ok:true,
      count:addMembers(membersMatch[1], body.hashes || [], String(body.source || 'manual'), body.confidence)
    });
    return true;
  }

  const aiMatch = /^\/api\/tags\/(\d+)\/ai-members$/.exec(url.pathname);
  if (aiMatch && req.method === 'POST') {
    const body = await readJson(req, 4 * 1024 * 1024);
    json(res, 200, {
      ok:true,
      count:replaceAiMembers(aiMatch[1], body.matches || [], String(body.source || 'ai'))
    });
    return true;
  }

  const removeMatch = /^\/api\/tags\/(\d+)\/remove$/.exec(url.pathname);
  if (removeMatch && req.method === 'POST') {
    const body = await readJson(req, 2 * 1024 * 1024);
    json(res, 200, {
      ok:true,
      count:removeMembers(removeMatch[1], body.hashes || [], body.suppress === true)
    });
    return true;
  }

  const examplesMatch = /^\/api\/tags\/(\d+)\/examples$/.exec(url.pathname);
  if (examplesMatch && req.method === 'POST') {
    const body = await readJson(req, 2 * 1024 * 1024);
    json(res, 200, { ok:true, ...setExamples(examplesMatch[1], body.positive, body.negative) });
    return true;
  }

  json(res, 405, { error:'Method not allowed' });
  return true;
}
