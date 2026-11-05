import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/, dev stays on the root
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/lustre-car-wash-3d/' : '/',
}));
