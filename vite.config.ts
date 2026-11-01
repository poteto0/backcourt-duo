import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  root: 'src/web',
  plugins: [solid()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
  },
});
