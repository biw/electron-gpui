# electron-gpui-unplugin

An [unplugin](https://unplugin.unjs.io) for [electron-gpui](https://github.com/biw/electron-gpui). Add it to the bundler that builds your Electron main process and you never run a separate Rust build step:

- Before each build it runs your project's `electron-gpui build` on your views crate (incremental, via Cargo).
- It emits the `.node` addon next to your bundle.
- It provides `virtual:electron-gpui/addon`, which loads that addon from the right path in ESM or CommonJS output.
- In watch mode it hot-patches Rust changes into the running app, and rebuilds and restarts it when a change can't be patched (see [Hot reload](https://github.com/biw/electron-gpui#hot-reload)). With `electron: true` it also launches the app.

```sh
pnpm add electron-gpui
pnpm add -D electron-gpui-unplugin
npx electron-gpui init   # scaffold ./native
```

```js
// vite.config.js
import electronGpui from "electron-gpui-unplugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [electronGpui({ electron: true })], // run `vite build --watch` while developing
  build: {
    ssr: "src/main.js",
    rollupOptions: { external: ["electron"], output: { format: "es" } },
  },
});
```

```js
// src/main.js
import { app } from "electron";
import { createGpui } from "electron-gpui";
import addon from "virtual:electron-gpui/addon";

app.whenReady().then(() => {
  const gpui = createGpui(addon);
  gpui.openWindow("Hello", { title: "Hello" });
});
```

For TypeScript, add `"types": ["electron-gpui-unplugin/client"]` to `compilerOptions` in `tsconfig.json`.

## Other bundlers

Every entry point is a default-exported plugin factory:

```js
import electronGpui from "electron-gpui-unplugin/rolldown"; // tsdown, Rolldown
// or "electron-gpui-unplugin/rollup", "/webpack", "/esbuild", "/vite"
```

Rollup, Rolldown and Vite compute the path from each output chunk to the addon, so any output layout works. With webpack and esbuild the addon is loaded from the directory of the bundle that imports it: if that bundle isn't at the root of the output directory, set `assetDirectory` to its subdirectory. esbuild needs `outdir` or `outfile`; with `outfile` the addon always goes beside that file.

## Options

| Option           | Default                                           |                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crate`          | `"native"`                                        | Your views crate, relative to `cwd`                                                                                                                                                                               |
| `cwd`            | `process.cwd()`                                   | Project directory (contains `package.json`)                                                                                                                                                                       |
| `build`          | `true`                                            | Run `electron-gpui build` before bundling. Set `false` if another step builds the addon (it must exist at `<crate>/index.node`).                                                                                  |
| `release`        | `NODE_ENV === "production"`, except in watch mode | Build with `--release` (`vite build` sets `NODE_ENV=production`)                                                                                                                                                  |
| `electron`       | `false`                                           | In watch mode, launch the app after the first build and restart it after rebuilds. Leave off if electron-vite or Forge runs your app. `{ args }` passes extra Electron arguments. Rollup, Rolldown and Vite only. |
| `hot`            | `true`                                            | In watch mode, hot-patch Rust changes instead of restarting when possible. Rollup, Rolldown and Vite only.                                                                                                        |
| `universal`      | `false`                                           | Build one addon for Apple silicon and Intel                                                                                                                                                                       |
| `fileName`       | `"electron-gpui.node"`                            | Name of the emitted addon                                                                                                                                                                                         |
| `assetDirectory` | output root                                       | Output subdirectory for the addon                                                                                                                                                                                 |

With hot reload, the plugin restarts the app by touching `**/electron-gpui-hot/*/rebuild-trigger`, which it adds to the bundle's watch files. A watch `include` filter also applies to those files: the Vite plugin extends `build.watch.include` for you, and with Rollup or Rolldown you need to add the pattern to `watch.include` yourself.

The plugin runs the `electron-gpui` CLI installed in your project directly, never through `npx`. It's meant for Node outputs such as Electron's main process, not browser bundles; Vite SSR asset emission is turned on automatically.

## License

MIT
