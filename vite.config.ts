import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `base` doit correspondre au chemin de publication GitHub Pages
// (https://<user>.github.io/smart_planning/).
//
// La meme valeur est utilisee en dev, en preview ET en build : `vite preview`
// s'execute avec command === 'serve', donc une base conditionnelle servirait
// les fichiers a la racine alors qu'ils referencent /smart_planning/, et la
// preview afficherait une page blanche.
// Pour un hebergement a la racine d'un domaine : APP_BASE=/ npm run build
const BASE = process.env.APP_BASE ?? '/smart_planning/';

export default defineConfig(() => ({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      workbox: {
        // pdf.js et le bundle React depassent la limite par defaut de 2 Mio.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // L'API Groq ne doit jamais etre mise en cache.
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: 'Smart Planning',
        short_name: 'Planning',
        description: "Ton planning et celui de tes collegues, extraits d'une photo ou d'un PDF.",
        lang: 'fr',
        theme_color: '#1a73e8',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          // pdf.js est lourd : on l'isole pour ne pas bloquer le premier rendu.
          pdfjs: ['pdfjs-dist'],
        },
      },
    },
  },
}));
