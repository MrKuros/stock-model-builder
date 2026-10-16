import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // changeOrigin off: the API refuses POSTs whose Origin doesn't match Host
  server: { proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 8000}`, changeOrigin: false } } },
})
