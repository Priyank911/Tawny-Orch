import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), daemon: resolve('src/main/daemon/index.ts') },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    build: { rollupOptions: { input: resolve('src/main/preload.ts') } },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    publicDir: resolve('public'),
    resolve: { alias: { '@renderer': resolve('src/renderer') } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()]
  }
});
