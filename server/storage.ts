import { mkdirSync } from 'node:fs';
import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './db.ts';

export interface Storage {
  imagesDir: string;
  thumbsDir: string;
  imageFile(id: string, ext: string): string;
  thumbFile(id: string): string;
}

export function createStorage(dataDir: string): Storage {
  const imagesDir = path.join(dataDir, 'images');
  const thumbsDir = path.join(dataDir, 'thumbs');
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(thumbsDir, { recursive: true });
  return {
    imagesDir,
    thumbsDir,
    imageFile: (id, ext) => `${id}.${ext}`,
    thumbFile: (id) => `${id}.webp`,
  };
}

/** Writes via a temp file + rename so a crash never leaves a half-written file under a public name. */
export async function writeAtomic(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function removeQuietly(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

interface Logger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export async function purgeExpired(db: Database, storage: Storage, now: number): Promise<number> {
  let images = 0;
  for (;;) {
    const batch = db.expiredImages(now, 200);
    if (batch.length === 0) break;
    for (const { id, ext } of batch) {
      await removeQuietly(path.join(storage.imagesDir, storage.imageFile(id, ext)));
      await removeQuietly(path.join(storage.thumbsDir, storage.thumbFile(id)));
      db.deleteImage(id);
      images++;
    }
  }
  return images;
}

/** Removes files that have no database row (e.g. left behind by a crash mid-upload). */
export async function sweepOrphans(db: Database, storage: Storage, olderThan: number): Promise<number> {
  let removed = 0;
  for (const dir of [storage.imagesDir, storage.thumbsDir]) {
    for (const name of await readdir(dir)) {
      const id = name.split('.')[0];
      if (db.hasImage(id) && !name.endsWith('.tmp')) continue;
      const file = path.join(dir, name);
      if ((await stat(file)).mtimeMs > olderThan) continue;
      await removeQuietly(file);
      removed++;
    }
  }
  return removed;
}

export function scheduleCleanup(
  db: Database,
  storage: Storage,
  intervalMs: number,
  log: Logger,
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await purgeExpired(db, storage, Date.now());
      if (removed) log.info({ removed }, 'expired images removed');
    } catch (err) {
      log.error({ err }, 'cleanup failed');
    } finally {
      running = false;
    }
  };

  void sweepOrphans(db, storage, Date.now() - 60 * 60 * 1000)
    .then((removed) => removed && log.info({ removed }, 'orphan files removed'))
    .catch((err) => log.error({ err }, 'orphan sweep failed'));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
