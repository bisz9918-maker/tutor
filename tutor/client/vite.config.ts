import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  root: '.',
  publicDir: 'public',
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.CLIENT_PORT || '5173'),
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:7896',
      '/doc': 'http://localhost:7896',
      '/static': 'http://localhost:7896',
    },
  },
})
