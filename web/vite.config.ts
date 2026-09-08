import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

declare const process: {
  env: Record<string, string | undefined>;
};

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to IPv4 because some Windows environments deny the IPv6 localhost
    // listener. 5173 is also commonly inside a Windows TCP excluded range, so
    // keep the default outside that range while allowing local overrides.
    host: "127.0.0.1",
    port: Number(process.env.VITE_PORT ?? 5373),
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true
  }
});
