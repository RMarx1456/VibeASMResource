import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During local `vite dev`, proxy /api to the API container/host so the
// frontend code can always call relative "/api" URLs (same as in production
// where nginx proxies /api to the api service).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
