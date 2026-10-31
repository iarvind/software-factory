import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5282,
    proxy: { "/api": { target: process.env.API_TARGET || "http://127.0.0.1:8282", changeOrigin: false } },
  },
});
