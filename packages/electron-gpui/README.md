# electron-gpui

Run [GPUI](https://gpui.rs) — the UI framework behind the [Zed](https://zed.dev) editor — inside your Electron app. Supports macOS ARM64/Intel, Windows x64 (MSVC), and Linux x64 (GNU/glibc, X11 and Wayland).

```sh
npx electron-gpui init
```

The CLI detects pnpm, npm, Yarn or Bun, installs the runtime and bundler plugin, and scaffolds `./native`, a Rust crate for your GPUI views. Use `--skip-install` to scaffold without installing dependencies.

Add `electronGpui()` from `electron-gpui-unplugin/vite` to the bundler that builds your main process. Adapters are also available for Rollup, Rolldown/tsdown, webpack and esbuild.

If electron-vite or Electron Forge already runs your app, omit `electron: true`. For TypeScript, add `electron-gpui-unplugin/client` to `compilerOptions.types` in `tsconfig.json`.

Then open a GPUI window:

```js
import { app } from "electron";
import { createGpui } from "electron-gpui";
import addon from "virtual:electron-gpui/addon";

app.whenReady().then(() => {
  const gpui = createGpui(addon);
  const hello = gpui.openWindow("Hello", { title: "Hello" }, { name: "Electron" });
  hello.on("event", (event) => console.log(event));
  hello.send({ name: "GPUI" });
});
```

Without a bundler, run `npx electron-gpui build` and pass `new URL("./native/index.node", import.meta.url)` to `createGpui`.

Docs, API reference and limitations: https://github.com/biw/electron-gpui#readme

Licensed under MIT. GPUI is © Zed Industries, Inc. (Apache-2.0); see NOTICE.
