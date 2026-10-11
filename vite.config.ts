import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:3000';

export default defineConfig({
  server: {
    proxy: { '/api': api, '/i/': api, '/t/': api },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
});
