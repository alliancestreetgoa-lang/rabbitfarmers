import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * The web dashboard.
 *
 * Two things here are not defaults and both matter.
 *
 * The `@` alias is what shadcn/ui generates imports against, so it has to agree
 * with components.json and tsconfig.app.json. Three files, one path — a
 * mismatch shows up as an import that resolves in the editor and fails in the
 * build.
 *
 * The /api proxy exists because a deploy serves this app and the API from ONE
 * origin (netlify.toml), so the app calls a relative /api and never needs to
 * know an address. Locally there are two processes, so the dev server has to
 * pretend. Point it at the port `scripts/localhost.sh` gave the API.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:3007',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
