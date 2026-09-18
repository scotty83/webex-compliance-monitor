import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In prod the SPA is served single-origin by the backend, so no proxy is
// needed. In dev (Vite :5173 vs backend :4000) we forward API routes so the
// browser never hits a CORS wall.
const API_TARGET = process.env['VITE_API_TARGET'] ?? 'http://localhost:4000'

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/meetings': { target: API_TARGET, changeOrigin: true },
      '/audit':    { target: API_TARGET, changeOrigin: true },
      '/auth':     { target: API_TARGET, changeOrigin: true },
      '/live':     { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
})
