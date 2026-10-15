import { copyFile, mkdir } from 'node:fs/promises'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const base = env.GITHUB_PAGES === 'true' ? '/Billora/' : '/'
const assetUrl = (name: string) => `${base}${name}`

/**
 * ONNX Runtime Web ships its WASM runtime outside the package's `exports` map, so it cannot be
 * imported with `?url`. Copying the two files the engine needs into `public/ort/` keeps every
 * request same-origin, which both cross-origin isolation and offline use require.
 */
function ortRuntimePlugin(): Plugin {
  const files = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']
  const from = fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/', import.meta.url))
  const to = fileURLToPath(new URL('./public/ort/', import.meta.url))
  const copy = async () => {
    await mkdir(to, { recursive: true })
    for (const file of files) await copyFile(join(from, file), join(to, file))
  }
  return {
    name: 'billora-ort-runtime',
    async buildStart() { await copy() },
    async configureServer() { await copy() },
    async configurePreviewServer() { await copy() },
  }
}

/**
 * The offline speech engine runs ONNX Runtime Web with SharedArrayBuffer, which browsers only expose
 * to cross-origin isolated pages. Production sets these headers in `vercel.json`; the dev server
 * (and `vite preview`) need their own copy so `crossOriginIsolated === true` while developing.
 * GitHub Pages cannot send headers, so the engine degrades to a single thread there.
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export default defineConfig({
  base,
  plugins: [
    ortRuntimePlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['billora-icon.svg', 'billora-icon-192.png', 'billora-icon-512.png'],
      manifest: {
        id: base,
        name: 'Billora',
        short_name: 'Billora',
        description: 'فاکتورساز فارسی، رایگان و آفلاین با نگهداری اطلاعات روی دستگاه شما',
        lang: 'fa-IR',
        dir: 'rtl',
        theme_color: '#14594f',
        background_color: '#f6f7f4',
        display: 'standalone',
        orientation: 'any',
        start_url: base,
        scope: base,
        icons: [
          { src: assetUrl('billora-icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: assetUrl('billora-icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: assetUrl('billora-icon.svg'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,txt}'],
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // `/test-shenava.html` is built too, so the offline engine (and the model files) can be
        // checked on a real phone — and on a deployed site — without running a dev server.
        'test-shenava': fileURLToPath(new URL('./test-shenava.html', import.meta.url)),
      },
    },
  },
  // ONNX Runtime Web must be kept out of the dev-time dependency pre-bundling, otherwise the WASM
  // loader and the `?url` assets it needs end up in two different module instances.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
    headers: crossOriginIsolationHeaders,
  },
})
