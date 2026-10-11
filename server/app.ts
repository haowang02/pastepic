import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';
import { openDatabase, type ImageRecord } from './db.ts';
import { processImage, UnsupportedImageError } from './imaging.ts';
import { createStorage, removeQuietly, scheduleCleanup, writeAtomic } from './storage.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** SHA-256 of the browser's session token; the raw token never touches the database. */
    sessionKey: string;
  }
}

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE_S = 365 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 10;
const FILE_PATTERN = /^([0-9A-Za-z]{10})\.([a-z0-9]{2,5})$/;
const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 60;
const MAX_CONCURRENT_JOBS = 2;

const HTML_SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function newImageId(): string {
  let id = '';
  while (id.length < ID_LENGTH) {
    for (const byte of randomBytes(16)) {
      // 248 = 62 * 4; discarding higher bytes keeps the distribution uniform.
      if (byte < 248) id += ID_ALPHABET[byte % 62];
      if (id.length === ID_LENGTH) break;
    }
  }
  return id;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

/** Caps how many images are decoded at once so a burst of uploads cannot exhaust memory. */
function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function apiError(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export async function buildApp(config: Config, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Trust exactly the configured number of reverse proxies; trusting more would let clients
    // spoof X-Forwarded-For and dodge the upload rate limit.
    trustProxy: (_address: string, hop: number) => hop < config.trustedProxies,
    bodyLimit: 1024 * 1024,
  });

  const db = openDatabase(path.join(config.dataDir, 'images.db'));
  const storage = createStorage(config.dataDir);
  const limit = createLimiter(MAX_CONCURRENT_JOBS);
  const retentionDays = Math.round(config.retentionMs / 86_400_000);

  const origin = (req: FastifyRequest) => config.publicUrl || `${req.protocol}://${req.host}`;
  const toDto = (img: ImageRecord, base: string) => ({
    id: img.id,
    url: `${base}/i/${img.id}.${img.ext}`,
    thumbUrl: `/t/${img.id}.webp`,
    type: img.mime,
    size: img.size,
    width: img.width,
    height: img.height,
    createdAt: img.createdAt,
    expiresAt: img.expiresAt,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10, parts: 11 },
  });
  await app.register(rateLimit, { global: false });
  await app.register(fastifyStatic, {
    root: existsSync(config.staticDir) ? config.staticDir : config.dataDir,
    serve: existsSync(config.staticDir),
    wildcard: false,
    setHeaders(res, filePath) {
      const rel = path.relative(config.staticDir, filePath);
      // Uploaded images are also sent through this plugin but set their own caching headers.
      if (rel.startsWith('..')) return;
      if (rel.startsWith(`assets${path.sep}`)) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (rel.endsWith('.html')) {
        res.header('Cache-Control', 'no-cache');
      } else {
        res.header('Cache-Control', 'public, max-age=86400');
      }
    },
  });

  // Every browser gets an anonymous session on its first visit; uploads and history are scoped to it.
  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?', 1)[0];
    const isDocument = pathname === '/' || pathname === '/index.html';
    if (!isDocument && !pathname.startsWith('/api/')) return;

    let token = req.cookies[SESSION_COOKIE];
    const valid = token !== undefined && TOKEN_PATTERN.test(token);
    if (!valid) token = randomBytes(24).toString('base64url');
    // Refresh on page loads so an active browser never loses its history to cookie expiry.
    if (!valid || isDocument) {
      reply.setCookie(SESSION_COOKIE, token!, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: req.protocol === 'https',
        maxAge: SESSION_MAX_AGE_S,
      });
    }
    req.sessionKey = hashToken(token!);
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) reply.headers(HTML_SECURITY_HEADERS);
    return payload;
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/session', async (req) => {
    const { count, bytes } = db.summary(req.sessionKey, Date.now());
    return { count, bytes, retentionDays, maxUploadBytes: config.maxUploadBytes };
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/api/images', async (req) => {
    const pageSize = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const cursor = Number(req.query.cursor) > 0 ? Number(req.query.cursor) : Number.MAX_SAFE_INTEGER;
    const rows = db.listImages(req.sessionKey, Date.now(), cursor, pageSize + 1);
    const page = rows.slice(0, pageSize);
    const base = origin(req);
    return {
      items: page.map((img) => toDto(img, base)),
      nextCursor: rows.length > pageSize ? page[page.length - 1].seq : null,
    };
  });

  app.get<{ Params: { id: string } }>('/api/images/:id', async (req, reply) => {
    const img = db.getImage(req.params.id);
    if (!img || img.sessionId !== req.sessionKey || img.expiresAt <= Date.now()) {
      return apiError(reply, 404, 'not_found', '图片不存在或已删除');
    }
    return toDto(img, origin(req));
  });

  app.post(
    '/api/images',
    {
      config: {
        rateLimit: { max: config.uploadRateMax, timeWindow: config.uploadRateWindowMs },
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return apiError(reply, 415, 'not_multipart', '请使用 multipart/form-data 上传');
      }
      const part = await req.file();
      if (!part) return apiError(reply, 400, 'missing_file', '请求中没有文件');

      const data = await part.toBuffer();
      if (data.length === 0) return apiError(reply, 400, 'empty_file', '文件为空');

      let processed;
      try {
        processed = await limit(() => processImage(data));
      } catch (err) {
        if (err instanceof UnsupportedImageError) {
          return apiError(reply, 415, 'unsupported_type', '仅支持 JPG、PNG、GIF、WebP 和 AVIF 格式');
        }
        throw err;
      }

      let id = newImageId();
      while (db.hasImage(id)) id = newImageId();

      const imagePath = path.join(storage.imagesDir, storage.imageFile(id, processed.ext));
      const thumbPath = path.join(storage.thumbsDir, storage.thumbFile(id));
      const now = Date.now();
      try {
        await writeAtomic(thumbPath, processed.thumbnail);
        await writeAtomic(imagePath, data);
        const record = db.insertImage({
          id,
          sessionId: req.sessionKey,
          ext: processed.ext,
          mime: processed.mime,
          size: data.length,
          width: processed.width,
          height: processed.height,
          createdAt: now,
          expiresAt: now + config.retentionMs,
        });
        req.log.info({ id, size: data.length, type: processed.mime }, 'image stored');
        return reply.code(201).send(toDto(record, origin(req)));
      } catch (err) {
        await Promise.all([removeQuietly(imagePath), removeQuietly(thumbPath)]);
        throw err;
      }
    },
  );

  const serveStored = (dir: string, kind: 'image' | 'thumb') =>
    async (req: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
      const match = FILE_PATTERN.exec(req.params.file);
      const img = match ? db.getImage(match[1]) : undefined;
      const ext = kind === 'image' ? img?.ext : 'webp';
      const now = Date.now();
      if (!match || !img || match[2] !== ext || img.expiresAt <= now) {
        return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
      }
      // Every view of an original restarts its countdown, so browsers must check back on each view
      // (a 304 when unchanged) for views from their cache to count. Thumbnails don't count as views,
      // and an expiry only ever moves later, so they can be cached until the one known now.
      let caching: string;
      if (kind === 'image') {
        db.renewImage(img.id, now + config.retentionMs);
        caching = 'no-cache';
      } else {
        caching = `max-age=${Math.floor((img.expiresAt - now) / 1000)}, immutable`;
      }
      reply.headers({
        'Cache-Control': `public, ${caching}`,
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      return reply.sendFile(req.params.file, dir, { cacheControl: false });
    };

  app.get('/i/:file', serveStored(storage.imagesDir, 'image'));
  app.get('/t/:file', serveStored(storage.thumbsDir, 'thumb'));

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return apiError(reply, 404, 'not_found', '接口不存在');
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
      return apiError(reply, 413, 'file_too_large', `图片超过 ${mb} MB`);
    }
    if (err.code === 'FST_FILES_LIMIT' || err.code === 'FST_PARTS_LIMIT') {
      return apiError(reply, 400, 'too_many_files', '每次请求只能上传一个文件');
    }
    if (status === 429) return apiError(reply, 429, 'rate_limited', '上传过于频繁，请稍后再试');
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return apiError(reply, 500, 'internal_error', '服务器出错，请稍后重试');
    }
    return apiError(reply, status, err.code ?? 'bad_request', err.message);
  });

  const stopCleanup = scheduleCleanup(db, storage, config.cleanupIntervalMs, app.log);
  app.addHook('onClose', async () => {
    stopCleanup();
    db.close();
  });

  return app;
}
