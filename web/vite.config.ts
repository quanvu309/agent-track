import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: { outDir: '../src/agenttrack/static', emptyOutDir: true },
  server: { proxy: { '/api': process.env.AGENT_TRACK_API ?? 'http://127.0.0.1:3874' } },
})
