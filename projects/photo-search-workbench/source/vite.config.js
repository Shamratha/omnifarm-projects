import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_ORIGIN || 'http://localhost:3001',
      '/photos': process.env.API_ORIGIN || 'http://localhost:3001',
    },
  },
});
