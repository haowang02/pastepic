import './styles.css';
import { fetchSession, type ImageItem } from './api.ts';
import { copyText } from './clipboard.ts';
import { Gallery } from './gallery.ts';
import { hydrateIcons } from './icons.ts';
import { initThemeToggle } from './theme.ts';
import { toast } from './toast.ts';
import { initUploader } from './uploader.ts';
import { Viewer } from './viewer.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

hydrateIcons();
initThemeToggle($('theme-toggle'));

let maxUploadBytes = 25 * 1024 * 1024;
let total = 0;
const countEl = $('library-count');
const renderCount = () => {
  countEl.textContent = total > 0 ? `${total} 张` : '';
};

const copyLink = async (item: ImageItem) => {
  const ok = await copyText(item.url);
  toast(ok ? '链接已复制' : '复制失败，请手动复制', { tone: ok ? 'success' : 'error' });
};

const gallery = new Gallery($('gallery'), $('gallery-status'), {
  open: (index) => viewer.open(index),
  copy: copyLink,
  change: (expired) => {
    total = Math.max(gallery.items.length, total - expired);
    renderCount();
  },
});
const viewer = new Viewer($<HTMLDialogElement>('viewer'), gallery, copyLink);

initUploader({
  dropzone: $('dropzone'),
  input: $<HTMLInputElement>('file-input'),
  batch: $('batch'),
  maxBytes: () => maxUploadBytes,
  onUploaded: (item) => {
    total++;
    gallery.add(item);
  },
});

fetchSession()
  .then((session) => {
    maxUploadBytes = session.maxUploadBytes;
    total = Math.max(total, session.count);
    renderCount();
    $('limit-size').textContent = `单张最大 ${Math.round(session.maxUploadBytes / 1024 / 1024)} MB`;
    $('limit-days').textContent = `${session.retentionDays} 天无人访问后删除`;
  })
  .catch(() => undefined);

void gallery.loadMore();
