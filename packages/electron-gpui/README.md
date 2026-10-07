# electron-gpui

Run [GPUI](https://gpui.rs) — the UI framework behind the [Zed](https://zed.dev) editor — inside your Electron app. macOS only, pre-release.

```sh
pnpm add electron-gpui
pnpm add -D electron-gpui-unplugin   # builds and bundles your Rust views
npx electron-gpui init               # scaffold ./native, a Rust crate for your GPUI views
```

Add `electronGpui()` from `electron-gpui-unplugin/vite` (or `/rollup`, `/rolldown`, `/webpack`, `/esbuild`) to the bundler that builds your main process, then:

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
