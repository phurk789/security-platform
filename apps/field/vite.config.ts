import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the API server at /field/.
export default defineConfig({
  plugins: [react()],
  base: '/field/',
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:8080', ws: true } },
  },
  build: { outDir: 'dist' },
});
