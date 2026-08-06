import { defineConfig } from 'vite';

export default defineConfig({
  // Cloudflare Pages serves from the site root.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  // rapier3d-compat ships its WebAssembly inlined as base64, so there is no
  // separate .wasm file to serve and no special headers to configure. That is
  // the entire reason we use the "-compat" build instead of plain rapier3d.
  optimizeDeps: {
    exclude: [],
  },
});
