import { readdir, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.mochimono', 'provider-thumbs');
const THUMB_VERSION = 3;
const LEGACY_THUMB = /^([a-f0-9]{64})\.webp$/;
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

async function metadata(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return { width:Number(value.width) || 0, height:Number(value.height) || 0 };
  } catch {
    return { width:0, height:0 };
  }
}

export async function migrateLegacyProviderThumbCache() {
  const entries = await readdir(DIR, { withFileTypes:true }).catch(() => []);
  let migrated = 0;
  let removedDuplicates = 0;
  let scanned = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LEGACY_THUMB.exec(entry.name);
    if (!match) continue;
    const hash = match[1];
    const source = join(DIR, entry.name);
    const legacyInfo = join(DIR, `${hash}.json`);
    const bucket = join(DIR, hash.slice(0, 2));
    const target = join(bucket, `${hash}.webp`);
    const targetInfo = join(bucket, `${hash}.json`);

    const sourceStat = await stat(source).catch(() => null);
    if (!sourceStat?.isFile() || !sourceStat.size) continue;
    const info = await metadata(legacyInfo);

    await mkdir(bucket, { recursive:true });
    const targetStat = await stat(target).catch(() => null);
    if (targetStat?.isFile() && targetStat.size) {
      await Promise.all([
        rm(source, { force:true }),
        rm(legacyInfo, { force:true })
      ]);
      removedDuplicates++;
    } else {
      try {
        await rename(source, target);
        await writeFile(targetInfo, `${JSON.stringify({ version:THUMB_VERSION, ...info })}\n`);
        await rm(legacyInfo, { force:true });
        migrated++;
      } catch {
        // Leave the legacy pair intact if migration fails; a future startup can retry.
      }
    }

    scanned++;
    if (scanned % 128 === 0) await yieldTurn();
  }

  return { scanned, migrated, removedDuplicates };
}
