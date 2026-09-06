import './compression-work.js';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR } from './agent-context.js';

const db = new DatabaseSync(join(CONFIG_DIR, 'work.sqlite'), { timeout:5000 });
try {
  const row = db.prepare("SELECT id,options_json FROM compression_presets WHERE media_type='image' AND name='Default Image' AND is_default=1 LIMIT 1").get();
  if (row) {
    let options = {};
    try { options = JSON.parse(row.options_json || '{}'); } catch {}
    const legacy = String(options.format || '') === 'auto' && Number(options.quality) === 90 &&
      String(options.content || 'auto') === 'auto' && Number(options.effort) === 4 &&
      options.lossless !== true && Number(options.resizeMax) === 2560 && !Number(options.resizePercent);
    if (legacy) {
      const next = { format:'avif', quality:69, content:'auto', effort:4, lossless:false, resizeMax:2560, resizePercent:0 };
      db.prepare('UPDATE compression_presets SET options_json=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(next), new Date().toISOString(), row.id);
    }
  }
} finally {
  db.close();
}
