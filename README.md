# electron-gpui

Run [GPUI](https://gpui.rs), the GPU-accelerated UI framework behind [Zed](https://zed.dev), inside your Electron app. Write views in Rust, drive them from JavaScript, and edit them with hot reload.

> **Pre-release.** Supports macOS (Apple silicon and Intel), Windows x64 (MSVC), and Linux x64 (GNU/glibc, X11 and Wayland). APIs may change before 1.0.

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

GPUI windows live in Electron's main process alongside your `BrowserWindow`s.

## Quick start

Requires Electron 30+, Node 20.19+ and [Rust](https://rustup.rs) (the toolchain installs itself). Windows builds need Visual Studio's C++ Build Tools and Windows SDK. Linux builds need a C/C++ compiler, pkg-config, and Fontconfig, FreeType, XCB, XKB, Wayland, GLib and OpenSSL development packages; see [the CI setup](.github/actions/setup/action.yml) for Ubuntu packages. Linux uses your current X11 or Wayland session. Windows/Linux ARM64 and musl builds are outside the supported targets.

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
- Patches don't run your crate's static initializers again (`actions!` and `#[derive(Action)]` registrations, `inventory`, `ctor`), so actions you add take effect after the next restart.
- Each patch is built for the running app process. Patches that process didn't apply (it crashed or quit) are discarded, never applied to the next session.
- If your bundler config sets a watch `include` filter, it must keep matching `**/electron-gpui-hot/*/rebuild-trigger`, which the plugin touches to restart the app. The Vite plugin adds it for you; with Rollup or Rolldown, add it yourself.
- Covered windows show the change once they're visible again (GPUI only redraws visible windows).
- Rollup, Rolldown and Vite only; webpack and esbuild restart on every change. Turn it off with `electronGpui({ hot: false })`.

Hot patching uses [Subsecond](https://github.com/DioxusLabs/dioxus/tree/main/packages/subsecond) from the Dioxus team.

## API

**JavaScript** (`electron-gpui`)

|                                                                           |                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createGpui(addon, { app?, panicLog? })`                                  | Start GPUI after `app.whenReady()`. `addon` is `virtual:electron-gpui/addon`, or an absolute path or `file:` URL to a built addon. Returns a singleton, and shuts down on `before-quit` (opt out with `app: null`). `panicLog`: see [Good to know](#good-to-know).                                                                                  |
| `gpui.openWindow(view, options?, props?)`                                 | Open a window for a registered view. `options`: `title`, `width`, `height`, `x`, `y`, `minWidth`, `minHeight`, `resizable`, `focus`, `titleBarStyle` (`"hidden"` puts the content under a transparent titlebar), `trafficLightPosition`, `background` (`"opaque"`, `"transparent"` or `"blurred"`), `alwaysOnTop`. `props` goes to `RootView::new`. |
| `window.setAlwaysOnTop(flag, relativeLevel?)`                             | Keep the window above normal windows, like `BrowserWindow`'s `setAlwaysOnTop(flag, "floating", relativeLevel)`.                                                                                                                                                                                                                                     |
| `window.send(message)` / `window.on("event", fn)`                         | JSON messages to `RootView::on_message`; events from `bridge.emit(...)`.                                                                                                                                                                                                                                                                            |
| `window.close()`, `window.on("closed", fn)`, `window.isClosed`            | Lifecycle (`closed` fires however the window closed).                                                                                                                                                                                                                                                                                               |
| `gpui.windows`, `gpui.windowCount()`, `gpui.on("all-windows-closed", fn)` | Open GPUI windows.                                                                                                                                                                                                                                                                                                                                  |
| `gpui.shutdown()`, `loadAddon(location)`                                  | Close everything; load an addon without starting GPUI.                                                                                                                                                                                                                                                                                              |

`openWindow<Message, Event>(...)` takes type parameters for your message and event shapes.

**Rust** (`electron-gpui` crate): implement `RootView` (`new`, `on_message`) and `Render`, emit events with `WindowBridge::emit`, and register views with `export! { "Name" => View }`. `electron_gpui::gpui` and `electron_gpui::serde_json` re-export the versions the SDK uses. GPUI's macros (`actions!`, `#[derive(IntoElement)]`, `#[derive(Action)]`, ...) expand to `gpui::` paths, so files that use them need `use electron_gpui::gpui;`. `electron_gpui::set_always_on_top(window, flag, relative_level)` works across platforms. The existing `electron_gpui::macos::set_always_on_top` helper remains available on macOS.

**CLI**: `electron-gpui init [dir] [--local <path>]` scaffolds a views crate. `electron-gpui build [dir] [--release] [--universal]` builds `<dir>/index.node` by hand (the plugin does this for you). Without a bundler, pass `new URL("./native/index.node", import.meta.url)` to `createGpui`.

Window options are best effort. Traffic-light placement and hidden transparent titlebars apply on macOS; Windows and Linux use the window system's titlebars. Wayland titlebar availability depends on compositor decoration support. Blurred backgrounds fall back to transparency outside macOS, subject to compositor support. Always-on-top uses Windows topmost and X11 EWMH; ordinary Wayland windows have no portable topmost protocol, so the request is a no-op. `relativeLevel` affects macOS only. Positioning and focus on Wayland also depend on the compositor.

Wayland uses Vulkan when Electron exports its own Wayland implementation (including Electron 30), avoiding a collision with system EGL libraries. Install a working Vulkan driver; Mesa's software Vulkan driver also works for development and CI.

## Shipping

- Production builds (`NODE_ENV=production`, which `vite build` sets) use `--release`. `electronGpui({ universal: true })` is macOS-only and installs both Apple Rust targets before producing one addon for Apple silicon and Intel. Build Windows and Linux addons on their respective platforms.
- For the rest of your app's native modules, use [vite-plugin-native-modules](https://github.com/biw/vite-plugin-native-modules), which bundles `.node` dependencies (`node-gyp-build`, `bindings`, NAPI-RS) the same way.
- Native addons can't load from inside an asar archive, so unpack them (electron-builder: `asarUnpack: ["**/*.node"]`).

## Good to know

- **The main thread is shared.** Long-running main-process JavaScript freezes GPUI windows, and slow `render`s delay Electron. Keep heavy work in workers or GPUI's `cx.background_spawn`. `ELECTRON_GPUI_DEBUG=1` logs how long each JS → GPUI call takes.
- **Panics.** A panic in `on_message` becomes a JS error, and the window keeps working. A panic in `RootView::new` disables electron-gpui until the app relaunches, so validate `props` instead. Panics in `render` or event handlers abort the process, as in any GPUI app, before any JS can run: pass `createGpui(addon, { panicLog: path })` to append each panic to that file as a JSON line (`time`, `message`, `location`, `thread`, `aborts`, `backtrace`), and report it on the next launch.
- **Separate windows.** GPUI draws in its own native windows, not inside a `BrowserWindow`.
- **Quitting.** Electron's `window-all-closed` ignores GPUI windows; use `gpui.windowCount()` or `all-windows-closed`.
- **Menus.** The menu bar is Electron's. Use `Menu` and forward actions with `window.send`.
- **Disk space.** If [`cargo-sweep`](https://github.com/holmgr/cargo-sweep) is installed, builds remove Cargo output unused for 7 days (`ELECTRON_GPUI_NO_SWEEP=1` to skip).

## How it works

GPUI runs in an embedded mode that leaves the application's event loop to Electron. macOS shares `NSApp`; Windows hooks only GPUI window messages and can fall back to Direct3D WARP; Linux dispatches X11 or Wayland events through a nonblocking calloop poll every 8 ms on Electron's main thread. The Linux timer keeps the process alive while GPUI windows are open and stops on shutdown. Older addons without the optional polling export remain compatible.

Your views, GPUI and the SDK compile into one `.node` addon, because Rust has no stable ABI for sharing GPUI between libraries. For hot reload, the plugin keeps a patchable build, recompiles changed code into a Mach-O, ELF or PE library, and has Subsecond redirect calls to it. Development addons use content-addressed filenames. Windows loads a process-owned copy so rebuilding never overwrites a loaded DLL; locked files are cleaned up after their process exits. Applied patch libraries remain loaded for the lifetime of the app.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). GPUI is © Zed Industries, Inc. (Apache-2.0); see [NOTICE](NOTICE).
