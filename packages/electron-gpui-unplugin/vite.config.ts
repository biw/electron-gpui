import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  pack: {
    entry: [
      "src/index.ts",
      "src/vite.ts",
      "src/rollup.ts",
      "src/rolldown.ts",
      "src/webpack.ts",
      "src/esbuild.ts",
    ],
    format: ["esm", "cjs"],
    platform: "node",
    target: "node20",
    fixedExtension: true,
    dts: { generator: "tsgo" },
    deps: { neverBundle: true },
  },
});
