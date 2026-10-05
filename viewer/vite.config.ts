import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: process.env.KASANE_OUT_DIR || "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 10000,
    sourcemap: false,
    // 配布サイズを抑えるため圧縮する（19 MB → 15 MB）
    minify: true,
  },
  worker: { format: "es" },
});
