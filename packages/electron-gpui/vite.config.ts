import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  pack: [
    {
      entry: { index: "src/index.ts" },
      format: ["esm", "cjs"],
      platform: "node",
      target: "node20",
      fixedExtension: true,
      dts: { generator: "tsgo" },
      shims: true,
      deps: { neverBundle: ["electron"] },
    },
    {
      entry: { cli: "src/cli.ts" },
      format: ["esm"],
      platform: "node",
      target: "node20",
      fixedExtension: true,
      dts: false,
    },
  ],
});
