import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock,
  Copy,
  Download,
  ExternalLink,
  HardDrive,
  Image as ImageGlyph,
  Images,
  LoaderCircle,
  Moon,
  RotateCw,
  Sun,
  X,
  createElement,
  type IconNode,
} from 'lucide';

const ICONS = {
  check: Check,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  alert: CircleAlert,
  clipboard: ClipboardCheck,
  clock: Clock,
  copy: Copy,
  download: Download,
  external: ExternalLink,
  drive: HardDrive,
  image: ImageGlyph,
  images: Images,
  loader: LoaderCircle,
  moon: Moon,
  retry: RotateCw,
  sun: Sun,
  close: X,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 18): SVGElement {
  const el = createElement(ICONS[name], { width: size, height: size, 'stroke-width': 2, 'aria-hidden': 'true' });
  el.classList.add('icon');
  return el;
}

/** Replaces every `<i data-icon="name">` placeholder in the static markup. */
export function hydrateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('i[data-icon]')) {
    el.replaceWith(icon(el.dataset.icon as IconName, Number(el.dataset.size) || 18));
  }
}
