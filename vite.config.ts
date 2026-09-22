import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The built-in llama.cpp server (electron/model.cjs) speaks the OpenAI API on
// 127.0.0.1:8757, override with JEMERO_URL.
const ATOMIC = process.env.JEMERO_URL ?? 'http://127.0.0.1:8757'

// Installed packs (electron/pack-routes.cjs), on the loopback server the
// Electron shell starts before Vite. Absent in `npm run web`: no packs.
const PACK_ROUTES = process.env.JEMERO_PACK_ROUTES

/**
 * The canvas (public/kits/stage.html) runs in a sandboxed iframe with an opaque
 * origin, so to it the kit bundles are cross-origin, and module scripts need
 * CORS to load. electron/serve.cjs does the same in the packaged app.
 */
const kitsCors = (): Plugin => ({
  name: 'jemero-kits-cors',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/kits/')) res.setHeader('Access-Control-Allow-Origin', '*')
      next()
    })
  },
})

export default defineConfig({
  plugins: [react(), kitsCors()],
  build: {
    rollupOptions: {
      output: {
        // The compiler is only needed once there's a component to render;
        // splitting it keeps the first paint on a smaller chunk.
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client'],
          compiler: ['sucrase'],
        },
      },
    },
  },
  server: {
    port: 5273,
    // An end-to-end run (scripts/e2e-offline.mjs) must not be hot-reloaded by
    // edits made while it runs.
    ...(process.env.JEMERO_E2E ? { hmr: false, watch: { ignored: ['**/*'] } } : {}),
    proxy: {
      ...(PACK_ROUTES ? { '/packs': { target: PACK_ROUTES, changeOrigin: true } } : {}),
      // Same-origin proxy: the page never has to make a cross-origin call to
      // the model server.
      '/llm': {
        target: ATOMIC,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/llm/, '/v1'),
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[atomic proxy]', err.message))
        },
      },
    },
  },
})
