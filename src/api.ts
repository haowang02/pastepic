export interface ImageItem {
  id: string;
  url: string;
  thumbUrl: string;
  type: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
  expiresAt: number;
}

/** Name the original is saved under, e.g. `Ab3dE6gH9k.png`. */
export const fileName = (item: ImageItem) => item.url.slice(item.url.lastIndexOf('/') + 1);

export interface ImagePage {
  items: ImageItem[];
  nextCursor: number | null;
}

export interface SessionInfo {
  count: number;
  bytes: number;
  retentionDays: number;
  maxUploadBytes: number;
}

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? 'http_error', body?.message ?? `请求失败（${res.status}）`);
  return body as T;
}

export const fetchSession = () => getJson<SessionInfo>('/api/session');

export function fetchImages(cursor: number | null, limit = 30): Promise<ImagePage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));
  return getJson<ImagePage>(`/api/images?${params}`);
}

/** Resolves to `null` once the image has been deleted. */
export async function fetchImage(id: string): Promise<ImageItem | null> {
  try {
    return await getJson<ImageItem>(`/api/images/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  }
}

/** Uses XHR rather than fetch because fetch still cannot report upload progress. */
export function uploadImage(file: File, onProgress?: (ratio: number) => void): Promise<ImageItem> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/images');
    xhr.responseType = 'json';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response;
      if (xhr.status === 201 && body) return resolve(body as ImageItem);
      reject(new ApiError(body?.error ?? 'http_error', body?.message ?? `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new ApiError('network', '网络连接失败，请检查网络后重试'));
    xhr.ontimeout = () => reject(new ApiError('timeout', '上传超时，请重试'));
    const form = new FormData();
    form.append('file', file, file.name || 'image');
    xhr.send(form);
  });
}
