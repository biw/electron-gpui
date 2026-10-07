import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 110,
    sortPackageJson: false,
    ignorePatterns: ["target/**", "**/dist/**", "pnpm-lock.yaml"],
  },
  lint: {
    env: { node: true },
    ignorePatterns: ["target/**", "**/dist/**"],
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
});
