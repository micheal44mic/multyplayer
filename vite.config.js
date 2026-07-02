import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { handleGeminiFillRequest, handleGeminiGenerateRequest } from './server/gemini_fill.mjs';

export default defineConfig({
  base: './',
  server: {
    configureServer(server) {
      server.middlewares.use('/api/ai/fill', async (req, res) => {
        await handleGeminiFillRequest(req, res);
      });
      server.middlewares.use('/api/ai/generate', async (req, res) => {
        await handleGeminiGenerateRequest(req, res);
      });
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
        privacy: resolve(import.meta.dirname, 'privacy.html'),
        terms: resolve(import.meta.dirname, 'terms.html'),
        support: resolve(import.meta.dirname, 'support.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
