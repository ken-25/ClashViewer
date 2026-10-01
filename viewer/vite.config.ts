import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: process.env.CV_OUT_DIR || "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 10000,
    sourcemap: false,
    // PoC 中は不具合を追いやすいよう圧縮しない
    minify: false,
  },
  worker: { format: "es" },
});
