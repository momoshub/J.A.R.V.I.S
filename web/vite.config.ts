import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SPA served by the Bun dashboard at `/`; assets are emitted to `dist/`.
// In dev, proxy the JSON API to the running bot so `vite` works standalone.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://localhost:2001", changeOrigin: true },
    },
  },
});
