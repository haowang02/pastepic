import { fetchImage, fetchImages, fileName, type ImageItem } from './api.ts';
import { expiresSoon, formatRemaining } from './format.ts';
import { icon, type IconName } from './icons.ts';

const MIN_COLUMN_WIDTH = 220;
const MAX_COLUMNS = 6;
/** Tall images (long screenshots) are cropped to this height/width ratio in the grid. */
const MAX_TILE_RATIO = 2.4;
/** Approximate vertical gap in "column widths", used only to balance column heights. */
const GAP_RATIO = 0.06;

interface GalleryHandlers {
  open(index: number): void;
  copy(item: ImageItem): void;
  /** Fires whenever items are added or removed; `expired` counts images dropped because they expired. */
  change(expired: number): void;
}

const tileRatio = (item: ImageItem) => Math.min(item.height / item.width, MAX_TILE_RATIO);

function tileAction<K extends 'a' | 'button'>(tag: K, label: string, glyph: IconName): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = 'tile-action';
  el.setAttribute('aria-label', label);
  el.title = label;
  el.append(icon(glyph, 16));
  return el;
}

export class Gallery {
  readonly items: ImageItem[] = [];
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly handlers: GalleryHandlers;
  private readonly tiles = new Map<string, HTMLElement>();
  private columns: HTMLElement[] = [];
  private heights: number[] = [];
  private cursor: number | null = null;
  private finished = false;
  private failed = false;
  private pending: Promise<void> | null = null;

  constructor(root: HTMLElement, status: HTMLElement, handlers: GalleryHandlers) {
    this.root = root;
    this.status = status;
    this.handlers = handlers;

    new ResizeObserver(() => this.layout()).observe(root);
    new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void this.loadMore(), {
      rootMargin: '0px 0px 1200px 0px',
    }).observe(status);
    // Keep countdowns current and catch images that expire while the page stays open.
    setInterval(() => void this.tick(), 60_000);
  }

  get hasMore(): boolean {
    return !this.finished;
  }

  indexOf(id: string): number {
    return this.items.findIndex((item) => item.id === id);
  }

  loadMore(): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.pending ??= this.fetchPage().finally(() => {
      this.pending = null;
      // A short page can leave the loader on screen without triggering another intersection.
      requestAnimationFrame(() => {
        if (!this.finished && !this.failed && this.statusInView()) void this.loadMore();
      });
    });
    return this.pending;
  }

  /** Adds a freshly uploaded image to the top of the grid. */
  add(item: ImageItem): void {
    if (this.tiles.has(item.id)) return;
    this.items.unshift(item);
    this.layout(true);
    this.renderStatus();
    this.handlers.change(0);
  }

  private async fetchPage(): Promise<void> {
    this.failed = false;
    this.renderStatus(true);
    try {
      const page = await fetchImages(this.cursor);
      this.cursor = page.nextCursor;
      this.finished = page.nextCursor === null;
      const fresh = page.items.filter((item) => !this.tiles.has(item.id));
      this.items.push(...fresh);
      if (this.columns.length === 0) this.layout(true);
      else for (const item of fresh) this.place(item);
      if (fresh.length) this.handlers.change(0);
    } catch {
      this.failed = true;
    }
    this.renderStatus();
  }

  private columnCount(): number {
    const width = this.root.clientWidth || window.innerWidth;
    const gap = parseFloat(getComputedStyle(this.root).columnGap) || 14;
    return Math.max(2, Math.min(MAX_COLUMNS, Math.floor((width + gap) / (MIN_COLUMN_WIDTH + gap))));
  }

  private layout(force = false): void {
    const count = this.columnCount();
    if (!force && count === this.columns.length) return;
    this.columns = Array.from({ length: count }, () => {
      const col = document.createElement('div');
      col.className = 'masonry-col';
      return col;
    });
    this.heights = new Array(count).fill(0);
    for (const item of this.items) this.place(item);
    this.root.replaceChildren(...this.columns);
  }

  private place(item: ImageItem): void {
    const shortest = this.heights.indexOf(Math.min(...this.heights));
    this.columns[shortest].append(this.tileFor(item));
    this.heights[shortest] += tileRatio(item) + GAP_RATIO;
  }

  private tileFor(item: ImageItem): HTMLElement {
    const existing = this.tiles.get(item.id);
    if (existing) return existing;

    const tile = document.createElement('figure');
    tile.className = 'tile';
    tile.style.aspectRatio = `1 / ${tileRatio(item)}`;

    const link = document.createElement('a');
    link.className = 'tile-link';
    link.href = item.url;
    link.setAttribute('aria-label', `查看大图（${item.width} × ${item.height}）`);
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      this.handlers.open(this.indexOf(item.id));
    });

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 640;
    img.height = Math.round(640 * tileRatio(item));
    img.addEventListener('load', () => tile.classList.add('is-loaded'), { once: true });
    img.addEventListener('error', () => tile.classList.add('is-broken'), { once: true });
    img.src = item.thumbUrl;
    link.append(img);

    const copy = tileAction('button', '复制链接', 'copy');
    copy.type = 'button';
    copy.addEventListener('click', () => this.handlers.copy(item));

    const download = tileAction('a', '下载原图', 'download');
    download.href = item.url;
    download.download = fileName(item);

    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    actions.append(copy, download);

    tile.append(link, actions);
    this.tiles.set(item.id, tile);
    this.renderBadge(item);
    return tile;
  }

  private renderBadge(item: ImageItem, now = Date.now()): void {
    const tile = this.tiles.get(item.id);
    if (!tile) return;
    tile.querySelector('.tile-badge')?.remove();
    if (!expiresSoon(item.expiresAt, now)) return;
    const badge = document.createElement('span');
    badge.className = 'tile-badge';
    badge.title = '即将自动删除';
    badge.append(icon('clock', 13), document.createTextNode(`剩 ${formatRemaining(item.expiresAt, now)}`));
    tile.append(badge);
  }

  /**
   * Re-reads images from the server. Anyone viewing an original restarts its countdown, so the expiry
   * known here is only a lower bound: an image is dropped once the server has deleted it, not before.
   */
  async refresh(items: ImageItem[]): Promise<void> {
    const results = await Promise.allSettled(items.map((item) => fetchImage(item.id)));
    const deleted = new Set<string>();
    results.forEach((result, i) => {
      // A failed request leaves the image as it is; the next tick asks again.
      if (result.status === 'rejected') return;
      if (result.value === null) {
        deleted.add(items[i].id);
      } else {
        items[i].expiresAt = result.value.expiresAt;
        this.renderBadge(items[i]);
      }
    });

    const kept = this.items.filter((item) => !deleted.has(item.id));
    if (kept.length === this.items.length) return;
    for (const id of deleted) this.tiles.delete(id);
    const expired = this.items.length - kept.length;
    this.items.splice(0, this.items.length, ...kept);
    this.layout(true);
    this.renderStatus();
    this.handlers.change(expired);
  }

  private tick(): Promise<void> {
    const now = Date.now();
    for (const item of this.items) this.renderBadge(item, now);
    return this.refresh(this.items.filter((item) => item.expiresAt <= now));
  }

  private statusInView(): boolean {
    return this.status.getBoundingClientRect().top < window.innerHeight + 1200;
  }

  private renderStatus(loading = false): void {
    const empty = this.finished && this.items.length === 0;
    this.root.hidden = empty;
    this.root.setAttribute('aria-busy', String(loading));
    this.status.dataset.state = loading ? 'loading' : this.failed ? 'error' : empty ? 'empty' : this.finished ? 'end' : 'idle';

    if (loading) {
      this.status.replaceChildren(icon('loader', 22));
      this.status.lastElementChild!.classList.add('spin');
      this.status.setAttribute('aria-label', '正在加载');
    } else if (this.failed) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.append(icon('retry', 16), '重新加载');
      retry.addEventListener('click', () => void this.loadMore());
      this.status.replaceChildren(document.createTextNode('加载失败'), retry);
      this.status.removeAttribute('aria-label');
    } else if (empty) {
      const glyph = icon('images', 32);
      const text = document.createElement('p');
      text.textContent = '上传的图片会显示在这里';
      this.status.replaceChildren(glyph, text);
      this.status.removeAttribute('aria-label');
    } else {
      // Only mark the end of a list long enough to have been scrolled.
      this.status.replaceChildren(this.finished && this.items.length > 30 ? '没有更多了' : '');
      this.status.removeAttribute('aria-label');
    }
  }
}
