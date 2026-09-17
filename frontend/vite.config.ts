import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        // Backend now rejects WebSocket upgrades whose Origin doesn't match its own host
        // (see server.on('upgrade') in backend/index.js); make the proxied request look
        // same-origin so `npm run dev` (Vite on :5173) keeps working.
        headers: { Origin: 'http://localhost:3001' },
      },
    },
  },
})
