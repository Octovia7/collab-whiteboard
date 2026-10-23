import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.WHITEBOARD_SERVER ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev: the browser talks to Vite, which forwards API and WebSocket traffic.
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
});
