import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Backend (FastAPI) runs on :8000 in dev.
      // Frontend calls /api/* and Vite forwards to the backend to avoid CORS pain.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  }
});
