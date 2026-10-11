import { fileName, type ImageItem } from './api.ts';
import { formatBytes, formatDateTime, formatRemaining, formatType } from './format.ts';
import type { Gallery } from './gallery.ts';

export class Viewer {
  private readonly dialog: HTMLDialogElement;
  private readonly gallery: Gallery;
  private readonly onCopy: (item: ImageItem) => void;
  private readonly img: HTMLImageElement;
  private readonly stage: HTMLElement;
  private readonly link: HTMLInputElement;
  private readonly open_: HTMLAnchorElement;
  private readonly download: HTMLAnchorElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly dims: HTMLElement;
  private readonly type: HTMLElement;
  private readonly size: HTMLElement;
  private readonly expiry: HTMLElement;
  private index = -1;

  constructor(dialog: HTMLDialogElement, gallery: Gallery, onCopy: (item: ImageItem) => void) {
    this.dialog = dialog;
    this.gallery = gallery;
    this.onCopy = onCopy;
    const $ = <T extends HTMLElement>(sel: string) => dialog.querySelector<T>(sel)!;
    this.img = $('.viewer-img');
    this.stage = $('.viewer-stage');
    this.link = $('.viewer-url');
    this.open_ = $('.viewer-open');
    this.download = $('.viewer-download');
    this.prevBtn = $('.viewer-prev');
    this.nextBtn = $('.viewer-next');
    this.dims = $('.viewer-dims');
    this.type = $('.viewer-type');
    this.size = $('.viewer-size');
    this.expiry = $('.viewer-expiry');

    $('.viewer-close').addEventListener('click', () => dialog.close());
    $('.viewer-copy').addEventListener('click', () => this.current && this.onCopy(this.current));
    this.prevBtn.addEventListener('click', () => this.step(-1));
    this.nextBtn.addEventListener('click', () => void this.step(1));
    this.link.addEventListener('focus', () => this.link.select());

    // Clicking the dimmed area around the image closes the viewer.
    this.stage.addEventListener('click', (e) => e.target === this.stage && dialog.close());
    dialog.addEventListener('keydown', (e) => {
      if (e.target === this.link) return;
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') void this.step(1);
    });
    let touchX: number | null = null;
    this.stage.addEventListener('touchstart', (e) => {
      touchX = e.touches.length === 1 ? e.touches[0].clientX : null;
    }, { passive: true });
    this.stage.addEventListener('touchend', (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 50) void this.step(dx < 0 ? 1 : -1);
    });
    dialog.addEventListener('close', () => {
      this.img.removeAttribute('src');
      this.index = -1;
    });
  }

  private get current(): ImageItem | undefined {
    return this.gallery.items[this.index];
  }

  open(index: number): void {
    if (index < 0) return;
    this.index = index;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector<HTMLButtonElement>('.viewer-copy')!.focus();
  }

  private async step(delta: number): Promise<void> {
    const target = this.index + delta;
    if (target < 0) return;
    if (target >= this.gallery.items.length) {
      if (!this.gallery.hasMore) return;
      await this.gallery.loadMore();
      if (target >= this.gallery.items.length) return;
    }
    this.index = target;
    this.render();
  }

  private render(): void {
    const item = this.current;
    if (!item) return this.dialog.close();

    this.img.width = item.width;
    this.img.height = item.height;
    void this.showOriginal(item);

    this.link.value = item.url;
    this.open_.href = item.url;
    this.download.href = item.url;
    this.download.download = fileName(item);
    this.dims.textContent = `${item.width} × ${item.height}`;
    this.type.textContent = formatType(item.type);
    this.size.textContent = formatBytes(item.size);
    this.renderExpiry(item);

    this.prevBtn.disabled = this.index === 0;
    this.nextBtn.disabled = this.index >= this.gallery.items.length - 1 && !this.gallery.hasMore;
  }

  /** Shows the cached thumbnail immediately, then swaps in the original once it has decoded. */
  private async showOriginal(item: ImageItem): Promise<void> {
    this.img.src = item.thumbUrl;
    this.stage.classList.add('is-loading');
    const full = new Image();
    full.src = item.url;
    const decoded = await full.decode().then(() => true, () => false);
    if (this.current?.id === item.id) {
      this.stage.classList.remove('is-loading');
      if (decoded) this.img.src = item.url;
    }
    if (!decoded) return;

    // Loading the original restarted its countdown on the server.
    await this.gallery.refresh([item]);
    if (this.current?.id === item.id) this.renderExpiry(item);
  }

  private renderExpiry(item: ImageItem): void {
    this.expiry.textContent = `${formatRemaining(item.expiresAt)}后删除`;
    this.expiry.title = `上传于 ${formatDateTime(item.createdAt)}，若无人访问将于 ${formatDateTime(item.expiresAt)} 自动删除`;
  }
}
