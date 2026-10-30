import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'TAWNY_');
  return {
  main: {
    define: {
      __TAWNY_FIREBASE_API_KEY__: JSON.stringify(env.TAWNY_FIREBASE_API_KEY ?? ''),
      __TAWNY_GOOGLE_CLIENT_ID__: JSON.stringify(env.TAWNY_GOOGLE_CLIENT_ID ?? ''),
      __TAWNY_GOOGLE_CLIENT_SECRET__: JSON.stringify(env.TAWNY_GOOGLE_CLIENT_SECRET ?? '')
    },
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
  };
});
