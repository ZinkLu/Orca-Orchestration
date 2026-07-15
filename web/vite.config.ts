import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app talks to the local Express server (server/) over /api.
// Vite proxies those calls in dev so the browser hits a single origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
