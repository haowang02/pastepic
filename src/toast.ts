import { icon, type IconName } from './icons.ts';

interface ToastOptions {
  tone?: 'success' | 'error' | 'info';
  action?: { label: string; run: () => void };
  duration?: number;
}

const TONE_ICON: Record<NonNullable<ToastOptions['tone']>, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'image',
};

const MAX_VISIBLE = 3;

export function toast(message: string, { tone = 'success', action, duration }: ToastOptions = {}): void {
  const host = document.getElementById('toasts')!;
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.append(icon(TONE_ICON[tone], 18));

  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);

  const dismiss = () => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.run();
      dismiss();
    });
    el.append(btn);
  }

  // A modal dialog sits in the top layer, so toasts must live inside it to stay visible.
  const container = document.querySelector('dialog[open]') ?? document.body;
  if (host.parentElement !== container) container.append(host);
  host.append(el);
  while (host.children.length > MAX_VISIBLE) host.firstElementChild!.remove();
  setTimeout(dismiss, duration ?? (action ? 8000 : tone === 'error' ? 5000 : 2400));
}
