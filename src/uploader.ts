import { ApiError, uploadImage, type ImageItem } from './api.ts';
import { copyText, copyWhenReady } from './clipboard.ts';
import { formatBytes } from './format.ts';
import { icon } from './icons.ts';
import { toast } from './toast.ts';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
const ACCEPTED_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;
const BATCH_CONCURRENCY = 3;
/** Errors caused by the file itself; retrying would fail the same way. */
const PERMANENT_ERRORS = new Set(['unsupported_type', 'file_too_large', 'empty_file']);

interface UploaderOptions {
  dropzone: HTMLElement;
  input: HTMLInputElement;
  batch: HTMLElement;
  maxBytes: () => number;
  onUploaded: (item: ImageItem) => void;
}

function validate(file: File, maxBytes: number): string | null {
  const known = ACCEPTED_TYPES.includes(file.type) || (!file.type && ACCEPTED_EXT.test(file.name));
  if (!known) return '仅支持 JPG、PNG、GIF、WebP 和 AVIF 格式';
  if (file.size === 0) return '文件为空';
  if (file.size > maxBytes) return `图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB`;
  return null;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : '未知错误');

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/* ---------- Single-file upload: progress lives in the drop zone ---------- */

class DropzoneProgress {
  private readonly zone: HTMLElement;
  private readonly title: HTMLElement;
  private readonly idleTitle: string;
  private readonly active = new Map<symbol, number>();

  constructor(zone: HTMLElement) {
    this.zone = zone;
    this.title = zone.querySelector('.dz-title')!;
    this.idleTitle = this.title.textContent ?? '';
  }

  start(): symbol {
    const key = Symbol();
    this.active.set(key, 0);
    this.render();
    return key;
  }

  update(key: symbol, ratio: number): void {
    if (!this.active.has(key)) return;
    this.active.set(key, ratio);
    this.render();
  }

  finish(key: symbol): void {
    this.active.delete(key);
    this.render();
  }

  private render(): void {
    const busy = this.active.size > 0;
    const values = [...this.active.values()];
    const ratio = busy ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    this.zone.classList.toggle('is-uploading', busy);
    this.zone.style.setProperty('--progress', String(ratio));
    this.zone.setAttribute('aria-busy', String(busy));
    this.title.textContent = busy ? (ratio >= 1 ? '正在处理…' : `正在上传 ${Math.floor(ratio * 100)}%`) : this.idleTitle;
  }
}

/* ---------- Multi-file upload: a table of results ---------- */

type RowState = 'queued' | 'uploading' | 'done' | 'error';

interface Row {
  file: File;
  state: RowState;
  item?: ImageItem;
  tr: HTMLTableRowElement;
  status: HTMLTableCellElement;
  action: HTMLTableCellElement;
  preview: string;
}

class BatchPanel {
  private readonly el: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly counter: HTMLElement;
  private readonly copyAll: HTMLButtonElement;
  private readonly onUploaded: (item: ImageItem) => void;
  private rows: Row[] = [];
  private running = 0;

  constructor(el: HTMLElement, onUploaded: (item: ImageItem) => void) {
    this.el = el;
    this.body = el.querySelector('tbody')!;
    this.counter = el.querySelector('.batch-count')!;
    this.copyAll = el.querySelector('.batch-copy-all')!;
    this.onUploaded = onUploaded;

    this.copyAll.addEventListener('click', async () => {
      const urls = this.rows.filter((r) => r.item).map((r) => r.item!.url);
      if (!urls.length) return;
      const ok = await copyText(urls.join('\n'));
      toast(ok ? `已复制 ${urls.length} 条链接` : '复制失败，请手动复制', { tone: ok ? 'success' : 'error' });
    });
    el.querySelector('.batch-close')!.addEventListener('click', () => this.close());
  }

  add(files: File[], maxBytes: number): void {
    if (this.el.hidden) this.reset();
    this.el.hidden = false;
    for (const file of files) {
      const row = this.createRow(file);
      this.rows.push(row);
      this.body.append(row.tr);
      const problem = validate(file, maxBytes);
      if (problem) this.fail(row, problem, false);
    }
    this.render();
    this.pump();
    this.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private close(): void {
    this.el.hidden = true;
    this.reset();
  }

  private reset(): void {
    for (const row of this.rows) URL.revokeObjectURL(row.preview);
    // Uploads still in flight keep going; their results land in the gallery.
    this.rows = [];
    this.body.replaceChildren();
  }

  private createRow(file: File): Row {
    const tr = document.createElement('tr');
    const preview = URL.createObjectURL(file);

    const thumbCell = tr.insertCell();
    thumbCell.className = 'b-thumb';
    const img = document.createElement('img');
    img.src = preview;
    img.alt = '';
    img.decoding = 'async';
    img.onerror = () => img.replaceWith(icon('image', 20));
    thumbCell.append(img);

    const fileCell = tr.insertCell();
    fileCell.className = 'b-file';
    const name = document.createElement('span');
    name.className = 'b-name';
    name.textContent = file.name || '粘贴的图片';
    name.title = file.name;
    const size = document.createElement('span');
    size.className = 'b-size';
    size.textContent = formatBytes(file.size);
    fileCell.append(name, size);

    const status = tr.insertCell();
    status.className = 'b-status';
    const action = tr.insertCell();
    action.className = 'b-action';

    const row: Row = { file, state: 'queued', tr, status, action, preview };
    this.setState(row, 'queued');
    return row;
  }

  private setState(row: Row, state: RowState): void {
    row.state = state;
    row.tr.dataset.state = state;
    if (state === 'queued') {
      row.status.replaceChildren(Object.assign(document.createElement('span'), { className: 'b-muted', textContent: '等待上传' }));
      row.action.replaceChildren();
    } else if (state === 'uploading') {
      const bar = document.createElement('div');
      bar.className = 'progress';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', '上传进度');
      bar.append(document.createElement('span'));
      row.status.replaceChildren(bar);
      const spinner = icon('loader', 18);
      spinner.classList.add('spin', 'b-muted');
      row.action.replaceChildren(spinner);
    }
    this.render();
  }

  private progress(row: Row, ratio: number): void {
    const bar = row.status.querySelector<HTMLElement>('.progress');
    if (!bar) return;
    bar.style.setProperty('--p', String(ratio));
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  private succeed(row: Row, item: ImageItem): void {
    row.item = item;
    this.setState(row, 'done');

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link-chip';
    link.textContent = item.url;
    link.title = '点击复制链接';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'icon-btn';
    copyBtn.setAttribute('aria-label', '复制链接');
    copyBtn.title = '复制链接';
    copyBtn.append(icon('copy', 18));

    const copy = async () => {
      const ok = await copyText(item.url);
      toast(ok ? '链接已复制' : '复制失败，请手动复制', { tone: ok ? 'success' : 'error' });
      if (!ok) return;
      copyBtn.replaceChildren(icon('check', 18));
      copyBtn.classList.add('is-done');
      setTimeout(() => {
        copyBtn.replaceChildren(icon('copy', 18));
        copyBtn.classList.remove('is-done');
      }, 1600);
    };
    link.addEventListener('click', copy);
    copyBtn.addEventListener('click', copy);
    row.status.replaceChildren(link);
    row.action.replaceChildren(copyBtn);
  }

  private fail(row: Row, message: string, retryable: boolean): void {
    this.setState(row, 'error');
    const msg = document.createElement('span');
    msg.className = 'b-error';
    msg.append(icon('alert', 16), message);
    row.status.replaceChildren(msg);
    row.action.replaceChildren();
    if (retryable) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'icon-btn';
      retry.setAttribute('aria-label', '重试');
      retry.title = '重试';
      retry.append(icon('retry', 18));
      retry.addEventListener('click', () => {
        this.setState(row, 'queued');
        this.pump();
      });
      row.action.append(retry);
    }
  }

  private pump(): void {
    while (this.running < BATCH_CONCURRENCY) {
      const row = this.rows.find((r) => r.state === 'queued');
      if (!row) return;
      this.running++;
      this.setState(row, 'uploading');
      uploadImage(row.file, (ratio) => this.progress(row, ratio))
        .then((item) => {
          this.onUploaded(item);
          this.succeed(row, item);
        })
        .catch((err) => {
          const permanent = err instanceof ApiError && PERMANENT_ERRORS.has(err.code);
          this.fail(row, errorMessage(err), !permanent);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private render(): void {
    const done = this.rows.filter((r) => r.state === 'done').length;
    const failed = this.rows.filter((r) => r.state === 'error').length;
    const settled = done + failed === this.rows.length;
    this.counter.textContent = settled && failed
      ? `成功 ${done} 张，失败 ${failed} 张`
      : `${done} / ${this.rows.length}`;
    this.copyAll.disabled = done === 0;
  }
}

/* ---------- Wiring: picker, paste, drag and drop ---------- */

export function initUploader({ dropzone, input, batch, maxBytes, onUploaded }: UploaderOptions): void {
  const progress = new DropzoneProgress(dropzone);
  const panel = new BatchPanel(batch, onUploaded);

  const uploadSingle = async (file: File) => {
    const problem = validate(file, maxBytes());
    if (problem) return toast(problem, { tone: 'error' });

    const key = progress.start();
    const upload = uploadImage(file, (ratio) => progress.update(key, ratio));
    // Start the clipboard write now, while the paste/drop/click still counts as a user gesture.
    const copied = copyWhenReady(upload.then((item) => item.url));
    try {
      const item = await upload;
      progress.update(key, 1);
      onUploaded(item);
      if (await copied) {
        toast('上传成功，链接已复制');
      } else {
        toast('上传成功', {
          action: {
            label: '复制链接',
            run: () => void copyText(item.url).then((ok) => toast(ok ? '链接已复制' : '复制失败', { tone: ok ? 'success' : 'error' })),
          },
        });
      }
    } catch (err) {
      toast(`上传失败：${errorMessage(err)}`, { tone: 'error' });
    } finally {
      progress.finish(key);
    }
  };

  const handleFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (files.length === 1) void uploadSingle(files[0]);
    else panel.add(files, maxBytes());
  };

  const openPicker = () => input.click();
  dropzone.addEventListener('click', openPicker);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });
  input.addEventListener('change', () => {
    handleFiles([...(input.files ?? [])]);
    input.value = '';
  });

  document.addEventListener('paste', (e) => {
    if (isEditable(e.target) || document.querySelector('dialog[open]')) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) {
      if (e.clipboardData?.types.includes('text/plain')) toast('剪贴板中没有图片', { tone: 'info' });
      return;
    }
    e.preventDefault();
    handleFiles(files);
  });

  // The whole window accepts drops; the drop zone lights up while files hover anywhere over the page.
  let depth = 0;
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  const setDragging = (on: boolean) => document.body.classList.toggle('is-dragging', on);

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    setDragging(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setDragging(false);
    handleFiles([...(e.dataTransfer?.files ?? [])]);
  });
}
