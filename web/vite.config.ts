import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // foliate-js's pdf.js pulls in the vendored pdfjs build, which trips
      // Vite's import-glob scanner. Moth does not support PDFs, so the import
      // is redirected to a stub and the pdfjs subtree stays out of the graph.
      {
        find: /^\.\/pdf\.js$/,
        replacement: "/src/reader/pdf-stub.js",
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true
  }
});
