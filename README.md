# electron-gpui

Run [GPUI](https://gpui.rs), the GPU-accelerated UI framework behind [Zed](https://zed.dev), inside your Electron app. Write views in Rust, drive them from JavaScript, and edit them with hot reload.

> **Pre-release.** macOS only (Apple silicon and Intel). APIs may change before 1.0.

```js
import { app } from "electron";
import { createGpui } from "electron-gpui";
import addon from "virtual:electron-gpui/addon"; // your Rust views, built by the bundler plugin

app.whenReady().then(() => {
  const gpui = createGpui(addon);
  const hello = gpui.openWindow("Hello", { title: "Hello" }, { name: "Electron" });
  hello.on("event", (event) => console.log(event)); // events from Rust
  hello.send({ name: "GPUI" }); // messages to Rust
});
```

GPUI windows live in Electron's main process alongside your `BrowserWindow`s: one app, one Dock icon, one menu bar.

## Quick start

Requires macOS 10.15.7+, Electron 30+, Node 20.19+ and [Rust](https://rustup.rs) (the toolchain installs itself).

**1. Install and scaffold a views crate**

```sh
pnpm add electron-gpui
pnpm add -D electron-gpui-unplugin
npx electron-gpui init   # creates ./native with an example view
```

> Before the first public release, use a local checkout: `pnpm add link:../electron-gpui/packages/electron-gpui`, `pnpm add -D link:../electron-gpui/packages/electron-gpui-unplugin`, then `npx electron-gpui init --local ../electron-gpui`.

**2. Add the plugin to the bundler that builds your main process**

```js
// vite.config.js
import electronGpui from "electron-gpui-unplugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [electronGpui({ electron: true })], // `electron: true` runs the app in watch mode
  build: {
    ssr: "src/main.js",
    rollupOptions: { external: ["electron"], output: { format: "es" } },
  },
});
```

Also available for Rollup, Rolldown/tsdown, webpack and esbuild (`electron-gpui-unplugin/<bundler>`). If electron-vite or Electron Forge already runs your app, drop `electron: true`. For TypeScript, add `"types": ["electron-gpui-unplugin/client"]` to `tsconfig.json`.

**3. Write views** in `native/src/lib.rs`

```rust
use electron_gpui::{RootView, WindowBridge, gpui::{prelude::*, *}, serde_json::{Value, json}};

struct Hello { bridge: WindowBridge, name: String }

impl RootView for Hello {
    fn new(props: Value, bridge: WindowBridge, _: &mut Window, _: &mut Context<Self>) -> Self {
        Hello { bridge, name: props["name"].as_str().unwrap_or("world").into() }
    }

    fn on_message(&mut self, message: Value, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(name) = message["name"].as_str() {
            self.name = name.into();
            cx.notify();
        }
    }
}

impl Render for Hello {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("root")
            .size_full()
            .child(format!("Hello, {}!", self.name))
            .on_click(cx.listener(|this, _, _, _| {
                this.bridge.emit(json!({ "type": "clicked" })).ok();
            }))
    }
}

electron_gpui::export! { "Hello" => Hello }
```

**4. Run** `vite build --watch`, and open views from the main process as in the example at the top.

[`examples/counter`](examples/counter) is a complete app with a `BrowserWindow` and a GPUI window talking to each other.

## Hot reload

In watch mode, saving a Rust file patches the change into the running app within a few seconds, without restarting it, and views keep their state. When a change can't be patched safely, the plugin rebuilds and restarts the app instead:

| Change                                                                 | Result                                       |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| Function bodies, `render`, event handlers, `on_message`, new functions | Hot-patched                                  |
| `struct`, `enum` or `union` definitions                                | Restart                                      |
| `Cargo.toml`, `Cargo.lock`, `build.rs`, added or deleted files         | Restart                                      |
| Other local crates your views crate depends on                         | Restart                                      |
| Code that needs something new from a dependency                        | Restart (the patch fails to link)            |
| Compile errors                                                         | Shown in the terminal; the app keeps running |

- Thread-locals and `static`s in your views crate reset on each patch.
- Covered windows show the change once they're visible again (GPUI only redraws visible windows).
- Rollup, Rolldown and Vite only; webpack and esbuild restart on every change. Turn it off with `electronGpui({ hot: false })`.

Hot patching uses [Subsecond](https://github.com/DioxusLabs/dioxus/tree/main/packages/subsecond) from the Dioxus team.

## API

**JavaScript** (`electron-gpui`)

|                                                                           |                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createGpui(addon, { app? })`                                             | Start GPUI after `app.whenReady()`. `addon` is `virtual:electron-gpui/addon`, or an absolute path or `file:` URL to a built addon. Returns a singleton, and shuts down on `before-quit` (opt out with `app: null`). |
| `gpui.openWindow(view, options?, props?)`                                 | Open a window for a registered view. `options`: `title`, `width`, `height`, `x`, `y`, `minWidth`, `minHeight`, `resizable`, `focus`. `props` goes to `RootView::new`.                                               |
| `window.send(message)` / `window.on("event", fn)`                         | JSON messages to `RootView::on_message`; events from `bridge.emit(...)`.                                                                                                                                            |
| `window.close()`, `window.on("closed", fn)`, `window.isClosed`            | Lifecycle (`closed` fires however the window closed).                                                                                                                                                               |
| `gpui.windows`, `gpui.windowCount()`, `gpui.on("all-windows-closed", fn)` | Open GPUI windows.                                                                                                                                                                                                  |
| `gpui.shutdown()`, `loadAddon(location)`                                  | Close everything; load an addon without starting GPUI.                                                                                                                                                              |

`openWindow<Message, Event>(...)` takes type parameters for your message and event shapes.

**Rust** (`electron-gpui` crate): implement `RootView` (`new`, `on_message`) and `Render`, emit events with `WindowBridge::emit`, and register views with `export! { "Name" => View }`. `electron_gpui::gpui` and `electron_gpui::serde_json` re-export the versions the SDK uses.

**CLI**: `electron-gpui init [dir] [--local <path>]` scaffolds a views crate. `electron-gpui build [dir] [--release] [--universal]` builds `<dir>/index.node` by hand (the plugin does this for you). Without a bundler, pass `new URL("./native/index.node", import.meta.url)` to `createGpui`.

## Shipping

- Production builds (`NODE_ENV=production`, which `vite build` sets) use `--release`. `electronGpui({ universal: true })` produces one addon for Apple silicon and Intel.
- For the rest of your app's native modules, use [vite-plugin-native-modules](https://github.com/biw/vite-plugin-native-modules), which bundles `.node` dependencies (`node-gyp-build`, `bindings`, NAPI-RS) the same way.
- Native addons can't load from inside an asar archive, so unpack them (electron-builder: `asarUnpack: ["**/*.node"]`).

## Good to know

- **The main thread is shared.** Long-running main-process JavaScript freezes GPUI windows, and slow `render`s delay Electron. Keep heavy work in workers or GPUI's `cx.background_spawn`. `ELECTRON_GPUI_DEBUG=1` logs how long each JS → GPUI call takes.
- **Panics.** A panic in `on_message` becomes a JS error, and the window keeps working. A panic in `RootView::new` disables electron-gpui until the app relaunches, so validate `props` instead. Panics in `render` or event handlers abort the process, as in any GPUI app.
- **Separate windows.** GPUI draws in its own native windows, not inside a `BrowserWindow`.
- **Quitting.** Electron's `window-all-closed` ignores GPUI windows; use `gpui.windowCount()` or `all-windows-closed`.
- **Menus.** The menu bar is Electron's. Use `Menu` and forward actions with `window.send`.
- **Disk space.** If [`cargo-sweep`](https://github.com/holmgr/cargo-sweep) is installed, builds remove Cargo output unused for 7 days (`ELECTRON_GPUI_NO_SWEEP=1` to skip).

## How it works

GPUI normally owns the whole macOS app. electron-gpui runs it in an embedded mode (a small patch to GPUI's macOS platform) that leaves `NSApp`, the menu bar and the run loop to Electron. Your views, GPUI and the SDK compile into one `.node` addon, because Rust has no stable ABI for sharing GPUI between libraries. That addon is called directly from Electron's main thread. For hot reload, the plugin keeps a patchable build of your crate, recompiles changed code into a small library on each save, and has Subsecond redirect calls to it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). GPUI is © Zed Industries, Inc. (Apache-2.0); see [NOTICE](NOTICE).
