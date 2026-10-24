import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.WHITEBOARD_SERVER ?? 'http://127.0.0.1:3001';

// Same-origin: the browser talks to Vite, which forwards API and WebSocket traffic to the
// server. Used by the dev server and by `vite preview` (E2E serves the built client that way).
const proxy = {
  '/api': SERVER,
  '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
};

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    // window.__board (debug.ts) exists in development and in the E2E build (`--mode e2e`), and
    // never in the production build: there this is the literal `false`, so the bundler drops it.
    __DEBUG_HANDLE__: JSON.stringify(mode !== 'production'),
  },
  build: {
    // The E2E build sits next to the production one instead of replacing it.
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
  },
  server: { port: 5173, proxy },
  preview: { proxy },
}));
