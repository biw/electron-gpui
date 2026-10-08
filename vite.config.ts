import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 110,
    sortPackageJson: false,
    ignorePatterns: [".context/**", "target/**", "**/dist/**", "pnpm-lock.yaml"],
  },
  lint: {
    env: { node: true },
    ignorePatterns: [".context/**", "target/**", "**/dist/**"],
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
