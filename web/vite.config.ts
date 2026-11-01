import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.QUENDA_API ?? "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  build: {
    sourcemap: false,
    license: { fileName: "licenses/dependencies.md" },
  },
});
