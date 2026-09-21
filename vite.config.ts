import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The built-in llama.cpp server (electron/model.cjs) speaks the OpenAI API on
// 127.0.0.1:8757 — override with ATOMIC_URL.
const ATOMIC = process.env.ATOMIC_URL ?? 'http://127.0.0.1:8757'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // xterm and the WebContainer client are only needed once the workspace
        // is in use; splitting them keeps the first paint (header + composer)
        // on a much smaller chunk.
        manualChunks: {
          react: ['react', 'react-dom'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
          webcontainer: ['@webcontainer/api'],
        },
      },
    },
  },
  server: {
    port: 5273,
    headers: {
      // WebContainer needs SharedArrayBuffer, which needs cross-origin isolation.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // Same-origin proxy: avoids CORS *and* the COEP restrictions that
      // cross-origin isolation would otherwise impose on calls to the model server.
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
