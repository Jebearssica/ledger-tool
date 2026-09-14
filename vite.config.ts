import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Chunks that are only ever reached through a dynamic `import()`.
 *
 * They must NOT be precached: precaching them would make installing the PWA
 * download ~570 KB before the user sees anything, which is exactly what the
 * lazy-loading strategy in AGENTS.md §2.1 exists to avoid. They are cached on
 * demand instead, so they still work offline after first use.
 */
const LAZY_CHUNK_PATTERNS = ['**/pdf-*.js', '**/universal-*.js', '**/pdf.worker*'];

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // The heavy parsers (pdfjs-dist, read-excel-file, fflate) are only reached
    // through dynamic import(), so Rollup splits them out automatically.
    // Do NOT add them to manualChunks.
    chunkSizeWarningLimit: 700,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '记账工具 / Ledger Tool',
        short_name: '记账',
        description: 'Local-first expense tracker. Import Alipay / WeChat / bank statements.',
        lang: 'zh-CN',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        globIgnores: LAZY_CHUNK_PATTERNS,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/assets\/(pdf|universal)-[^/]*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'lazy-parsers',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
});
