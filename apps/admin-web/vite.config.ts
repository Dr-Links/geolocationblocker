import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the admin API runs on :3001; in production the admin process serves
// both the built files and /admin/api from the same origin.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/admin/api': 'http://localhost:3001' } },
  build: { outDir: 'dist', sourcemap: false },
});
