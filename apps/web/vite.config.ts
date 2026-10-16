import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Default build is served by the API server. `--mode single` produces one self-contained
// HTML file that runs the standalone simulation (no server needed) for booth fallback.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  base: './',
  define: { __STANDALONE__: JSON.stringify(mode === 'single') },
  server: {
    proxy: { '/api': { target: 'http://localhost:8080', ws: true } },
  },
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist' },
}));
