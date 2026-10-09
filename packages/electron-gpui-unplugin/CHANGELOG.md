# electron-gpui-unplugin

## 0.3.0

### Minor Changes

- Support Windows x64 and Linux x64 alongside macOS ARM64/Intel, including in-process hot patching and Windows-safe development addon loading. Protect webpack and esbuild debug addons across Windows rebuilds.
- Close development sessions with their bundler watchers, coalesce Electron restarts, cancel queued patches during shutdown, and require the running addon to match the full build used for patching.
- Restart development apps for layout attributes, type aliases, constants, function signatures, registration changes and inherited Cargo workspace configuration. Keep newly added path dependencies watched, detect configuration saves reliably on macOS, and keep ordinary function-body edits patchable.
- Restrict Electron 30's Wayland import repair to the addon and its graphics driver dependency graph. Validate native builds and repeated hot patches in the complete cross-platform CI matrix.

### Patch Changes

- Update the peer dependency to electron-gpui@0.3.0.

## 0.2.0

### Minor Changes

- bf96f2f: Hot reload no longer replays a patch into a later session: patches carry the app process they were built for, the app removes each patch before applying it, and the dev server clears leftovers when it starts. Patches also no longer run the views crate's static initializers again (`actions!`/`#[derive(Action)]` registrations, `inventory`, napi export registration), which could crash the app.

  New window options: `titleBarStyle: "hidden"`, `trafficLightPosition`, `background` (`"opaque"`, `"transparent"`, `"blurred"`) and `alwaysOnTop`, plus `window.setAlwaysOnTop(flag, relativeLevel)` and `electron_gpui::macos::set_always_on_top` in Rust (both need an addon built with this version of the Rust SDK).

  `createGpui(addon, { panicLog })` appends every native panic to a file as a JSON line, so panics that abort the process can be reported on the next launch.

  The Vite plugin keeps the hot-reload restart trigger watched when `build.watch.include` is set, and the runtime's messages no longer contain relative `.node` paths that bundlers and asset checks treat as files to include.

### Patch Changes

- dc336b1: GPUI now comes from a revision of the `biw/zed` fork whose blurred window background works on macOS 27, so `background: "blurred"` (and `WindowBackgroundAppearance::Blurred`) blur what's behind the window again instead of leaving it sharp.
- Updated dependencies [dc336b1]
- Updated dependencies [bf96f2f]
  - electron-gpui@0.2.0
