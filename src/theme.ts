import { icon } from './icons.ts';

type Theme = 'light' | 'dark';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function current(): Theme {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return media.matches ? 'dark' : 'light';
}

export function initThemeToggle(button: HTMLButtonElement): void {
  const render = () => {
    const theme = current();
    button.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon', 20));
    const label = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    button.setAttribute('aria-label', label);
    button.title = label;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1230' : '#f3f5fd');
  };

  button.addEventListener('click', () => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    // Choosing the system theme again clears the override so the page keeps following the OS.
    const systemTheme: Theme = media.matches ? 'dark' : 'light';
    if (next === systemTheme) {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem('theme');
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem('theme', next);
    }
    render();
  });
  media.addEventListener('change', render);
  render();
}
