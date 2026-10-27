import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@orbit/domain": fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url)),
    },
  },
});
