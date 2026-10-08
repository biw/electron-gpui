import electronGpui from "electron-gpui-unplugin/vite";
import { defineConfig } from "vite-plus";

// Bundles Electron's main process. The electron-gpui plugin builds the Rust
// views in ./native first and emits the addon next to dist/main.js. With
// `vp build --watch` it also runs the app and restarts it after changes.
export default defineConfig({
  plugins: [
    electronGpui({
      electron: { args: process.env.ELECTRON_GPUI_ELECTRON_ARGS?.split(" ").filter(Boolean) ?? [] },
    }),
  ],
  build: {
    ssr: "src/main.js",
    outDir: "dist",
    target: "node20",
    rollupOptions: {
      external: ["electron"],
      output: { format: "es", entryFileNames: "main.js" },
    },
  },
});
