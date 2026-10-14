import { env } from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const base = env.GITHUB_PAGES === 'true' ? '/Billora/' : '/'
const assetUrl = (name: string) => `${base}${name}`

export default defineConfig({
  base,
  plugins: [
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
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
})
