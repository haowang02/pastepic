import { DatabaseSync } from 'node:sqlite';

export interface ImageRecord {
  seq: number;
  id: string;
  sessionId: string;
  ext: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
  expiresAt: number;
}

type NewImage = Omit<ImageRecord, 'seq'>;

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS images (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT    NOT NULL UNIQUE,
    session_id TEXT    NOT NULL,
    ext        TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS images_by_session ON images (session_id, seq DESC);
  CREATE INDEX IF NOT EXISTS images_by_expiry ON images (expires_at);
`;

const IMAGE_COLUMNS = `seq, id, session_id AS sessionId, ext, mime, size, width, height,
  created_at AS createdAt, expires_at AS expiresAt`;

export type Database = ReturnType<typeof openDatabase>;

export function openDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const q = {
    insertImage: db.prepare(`
      INSERT INTO images (id, session_id, ext, mime, size, width, height, created_at, expires_at)
      VALUES (:id, :sessionId, :ext, :mime, :size, :width, :height, :createdAt, :expiresAt)`),
    getImage: db.prepare(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ?`),
    listImages: db.prepare(`
      SELECT ${IMAGE_COLUMNS} FROM images
      WHERE session_id = ? AND expires_at > ? AND seq < ?
      ORDER BY seq DESC LIMIT ?`),
    summary: db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM images
      WHERE session_id = ? AND expires_at > ?`),
    expiredImages: db.prepare('SELECT id, ext FROM images WHERE expires_at <= ? LIMIT ?'),
    deleteImage: db.prepare('DELETE FROM images WHERE id = ?'),
    hasImage: db.prepare('SELECT 1 FROM images WHERE id = ?'),
  };

  return {
    insertImage(image: NewImage): ImageRecord {
      const result = q.insertImage.run({ ...image });
      return { ...image, seq: Number(result.lastInsertRowid) };
    },
    getImage(id: string): ImageRecord | undefined {
      return q.getImage.get(id) as ImageRecord | undefined;
    },
    hasImage(id: string): boolean {
      return q.hasImage.get(id) !== undefined;
    },
    listImages(sessionId: string, now: number, beforeSeq: number, limit: number): ImageRecord[] {
      return q.listImages.all(sessionId, now, beforeSeq, limit) as unknown as ImageRecord[];
    },
    summary(sessionId: string, now: number): { count: number; bytes: number } {
      return q.summary.get(sessionId, now) as { count: number; bytes: number };
    },
    expiredImages(now: number, limit: number): { id: string; ext: string }[] {
      return q.expiredImages.all(now, limit) as { id: string; ext: string }[];
    },
    deleteImage(id: string): void {
      q.deleteImage.run(id);
    },
    close(): void {
      db.close();
    },
  };
}
