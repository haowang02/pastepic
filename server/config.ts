import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  staticDir: string;
  /** Origin used to build image links, e.g. https://img.example.com. Derived from the request when empty. */
  publicUrl: string;
  /** How long an image is kept after its upload or the last view of its original. */
  retentionMs: number;
  maxUploadBytes: number;
  cleanupIntervalMs: number;
  /** Number of reverse proxies in front of the app whose X-Forwarded-* headers are trusted. */
  trustedProxies: number;
  /** Uploads allowed per client IP within `uploadRateWindowMs`. */
  uploadRateMax: number;
  uploadRateWindowMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || '0.0.0.0',
    port: positive(env.PORT, 3000),
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    staticDir: path.resolve(env.STATIC_DIR || 'dist'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    retentionMs: positive(env.RETENTION_DAYS, 7) * DAY,
    maxUploadBytes: Math.round(positive(env.MAX_UPLOAD_MB, 25) * 1024 * 1024),
    cleanupIntervalMs: 10 * 60 * 1000,
    trustedProxies: env.TRUST_PROXY === '0' ? 0 : positive(env.TRUST_PROXY, 1),
    uploadRateMax: positive(env.UPLOAD_RATE_MAX, 120),
    uploadRateWindowMs: 10 * 60 * 1000,
  };
}
