const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Remaining lifetime in the form “6 天” / “5 小时” / “12 分钟”. */
export function formatRemaining(expiresAt: number, now = Date.now()): string {
  const ms = Math.max(0, expiresAt - now);
  if (ms >= DAY) return `${Math.round(ms / DAY)} 天`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)} 小时`;
  return `${Math.max(1, Math.ceil(ms / 60_000))} 分钟`;
}

export const expiresSoon = (expiresAt: number, now = Date.now()) => expiresAt - now < DAY;

export function formatDateTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts);
}

export function formatType(mime: string): string {
  return mime.replace('image/', '').replace('jpeg', 'jpg').toUpperCase();
}
