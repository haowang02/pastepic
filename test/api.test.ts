import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { buildApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { openDatabase } from '../server/db.ts';
import { purgeExpired, createStorage } from '../server/storage.ts';

type App = Awaited<ReturnType<typeof buildApp>>;

const DAY = 86400_000;
const DAY_S = 86400;

function multipart(file: Buffer, filename: string, type: string) {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#3355ff' } }).png().toBuffer();

function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((c) => c.name === 'sid');
  assert.ok(c, 'session cookie is set');
  return `sid=${c.value}`;
}

describe('image API', () => {
  let app: App;
  let dataDir: string;
  let alice: string;
  let bob: string;

  before(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'pastepic-'));
    const config = loadConfig({ DATA_DIR: dataDir, STATIC_DIR: path.join(dataDir, 'none'), MAX_UPLOAD_MB: '1' });
    app = await buildApp(config);
    alice = sessionCookie(await app.inject({ url: '/api/session' }));
    bob = sessionCookie(await app.inject({ url: '/api/session' }));
    assert.notEqual(alice, bob);
  });

  after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('uploads an image and returns a public link plus a WebP thumbnail', async () => {
    const file = await png(1200, 800);
    const { body, headers } = multipart(file, 'a.png', 'image/png');
    const up = await app.inject({
      method: 'POST',
      url: '/api/images',
      headers: { ...headers, cookie: alice, host: 'img.test', 'x-forwarded-proto': 'https' },
      payload: body,
    });
    assert.equal(up.statusCode, 201, up.body);
    const img = up.json();
    assert.match(img.url, /^https:\/\/img\.test\/i\/[0-9A-Za-z]{10}\.png$/);
    assert.equal(img.width, 1200);
    assert.equal(img.height, 800);
    assert.equal(img.size, file.length);
    assert.ok(img.expiresAt - img.createdAt === 7 * DAY);

    const original = await app.inject({ url: new URL(img.url).pathname });
    assert.equal(original.statusCode, 200);
    assert.equal(original.headers['content-type'], 'image/png');
    assert.equal(original.headers['access-control-allow-origin'], '*');
    assert.equal(original.headers['cache-control'], 'public, no-cache');
    assert.deepEqual(original.rawPayload, file);

    const thumb = await app.inject({ url: img.thumbUrl });
    assert.equal(thumb.statusCode, 200);
    assert.equal(thumb.headers['content-type'], 'image/webp');
    const maxAge = Number(/max-age=(\d+)/.exec(String(thumb.headers['cache-control']))?.[1]);
    assert.ok(maxAge > 6 * DAY_S && maxAge <= 7 * DAY_S, `cache lifetime follows expiry: ${thumb.headers['cache-control']}`);
    assert.match(String(thumb.headers['cache-control']), /immutable/);
    const meta = await sharp(thumb.rawPayload).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 640);

    const wrongExt = await app.inject({ url: `/i/${img.id}.jpg` });
    assert.equal(wrongExt.statusCode, 404);
  });

  test('history is isolated per browser session', async () => {
    const a = (await app.inject({ url: '/api/images', headers: { cookie: alice } })).json();
    const b = (await app.inject({ url: '/api/images', headers: { cookie: bob } })).json();
    assert.equal(a.items.length, 1);
    assert.equal(b.items.length, 0);

    // Links stay public: another session can still open the image.
    const res = await app.inject({ url: `/i/${a.items[0].id}.png`, headers: { cookie: bob } });
    assert.equal(res.statusCode, 200);

    const own = await app.inject({ url: `/api/images/${a.items[0].id}`, headers: { cookie: alice } });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().id, a.items[0].id);
    const other = await app.inject({ url: `/api/images/${a.items[0].id}`, headers: { cookie: bob } });
    assert.equal(other.statusCode, 404);
    assert.equal(other.json().error, 'not_found');

    const summary = (await app.inject({ url: '/api/session', headers: { cookie: alice } })).json();
    assert.equal(summary.count, 1);
    assert.equal(summary.retentionDays, 7);
  });

  test('paginates newest first with a cursor', async () => {
    for (let i = 0; i < 4; i++) {
      const { body, headers } = multipart(await png(100 + i, 100), `${i}.png`, 'image/png');
      const res = await app.inject({ method: 'POST', url: '/api/images', headers: { ...headers, cookie: bob }, payload: body });
      assert.equal(res.statusCode, 201);
    }
    const first = (await app.inject({ url: '/api/images?limit=3', headers: { cookie: bob } })).json();
    assert.equal(first.items.length, 3);
    assert.equal(first.items[0].width, 103);
    assert.ok(first.nextCursor);
    const second = (await app.inject({ url: `/api/images?limit=3&cursor=${first.nextCursor}`, headers: { cookie: bob } })).json();
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].width, 100);
    assert.equal(second.nextCursor, null);
  });

  test('keeps animation in GIF thumbnails and crops very tall images', async () => {
    const frames = await sharp({ create: { width: 64, height: 192, channels: 4, background: '#ff6fae' } })
      .gif()
      .toBuffer();
    const gif = await sharp(frames, { animated: true }).gif().toBuffer();
    const { body, headers } = multipart(gif, 'a.gif', 'image/gif');
    const res = await app.inject({ method: 'POST', url: '/api/images', headers: { ...headers, cookie: alice }, payload: body });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().type, 'image/gif');

    const tall = await png(500, 4000);
    const t = multipart(tall, 'tall.png', 'image/png');
    const up = (await app.inject({ method: 'POST', url: '/api/images', headers: { ...t.headers, cookie: alice }, payload: t.body })).json();
    assert.equal(up.height, 4000);
    const thumb = await app.inject({ url: up.thumbUrl });
    const meta = await sharp(thumb.rawPayload).metadata();
    assert.equal(meta.width, 500);
    assert.equal(meta.height, 1500);
  });

  test('rejects non-images, oversized files and empty requests', async () => {
    const text = multipart(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'a.svg', 'image/svg+xml');
    const svg = await app.inject({ method: 'POST', url: '/api/images', headers: { ...text.headers, cookie: alice }, payload: text.body });
    assert.equal(svg.statusCode, 415);
    assert.equal(svg.json().error, 'unsupported_type');

    const big = multipart(Buffer.alloc(1024 * 1024 + 10, 1), 'big.png', 'image/png');
    const tooBig = await app.inject({ method: 'POST', url: '/api/images', headers: { ...big.headers, cookie: alice }, payload: big.body });
    assert.equal(tooBig.statusCode, 413);
    assert.equal(tooBig.json().error, 'file_too_large');

    const notMultipart = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie: alice }, payload: { a: 1 } });
    assert.equal(notMultipart.statusCode, 415);
  });

  test('viewing the original restarts its countdown, viewing the thumbnail does not', async (t) => {
    const { body, headers } = multipart(await png(80, 60), 'r.png', 'image/png');
    const img = (await app.inject({ method: 'POST', url: '/api/images', headers: { ...headers, cookie: alice }, payload: body })).json();
    const expiresAt = async () => (await app.inject({ url: `/api/images/${img.id}`, headers: { cookie: alice } })).json().expiresAt;

    t.mock.timers.enable({ apis: ['Date'], now: img.createdAt + 3 * DAY });
    await app.inject({ url: img.thumbUrl });
    assert.equal(await expiresAt(), img.expiresAt);

    const first = await app.inject({ url: new URL(img.url).pathname, headers: { cookie: bob } });
    assert.equal(first.statusCode, 200);
    assert.equal(await expiresAt(), img.createdAt + 10 * DAY);

    // A browser revalidating its cached copy counts as a view too.
    t.mock.timers.tick(DAY);
    const revalidated = await app.inject({ url: new URL(img.url).pathname, headers: { 'if-none-match': String(first.headers.etag) } });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(await expiresAt(), img.createdAt + 11 * DAY);
  });

  test('expired images disappear from history, links and disk', async () => {
    const db = openDatabase(path.join(dataDir, 'images.db'));
    const storage = createStorage(dataDir);
    const before = readdirSync(storage.imagesDir).length;
    assert.ok(before > 0);

    const removed = await purgeExpired(db, storage, Date.now() + 30 * DAY);
    db.close();
    assert.equal(removed, before);
    assert.equal(readdirSync(storage.imagesDir).length, 0);
    assert.equal(readdirSync(storage.thumbsDir).length, 0);

    const list = (await app.inject({ url: '/api/images', headers: { cookie: alice } })).json();
    assert.equal(list.items.length, 0);
  });

  test('health checks do not create sessions', async () => {
    const res = await app.inject({ url: '/healthz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cookies.length, 0);
  });
});
