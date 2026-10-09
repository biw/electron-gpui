# electron-gpui

## 0.3.0

### Minor Changes

- Add Windows x64 (MSVC) and Linux x64 (GNU/glibc, X11 and native Wayland) support, including in-process hot patching. Preserve macOS ARM64/Intel support and the existing window API. Window chrome and always-on-top options use documented platform-specific fallbacks, with a portable Rust `electron_gpui::set_always_on_top` helper.
- Discover Cargo's actual native library output on each platform and provide portable scaffold loading examples for paths containing spaces, apostrophes, or URL characters.
- Automatically install the runtime and bundler plugin with the project's package manager during `electron-gpui init`. Use `--skip-install` to scaffold without installing dependencies.
- Stop Linux event polling after a native failure while reporting the error once. Preserve window lifecycle events, panic logging and idempotent shutdown.
- Validate builds, scaffolding, dependency licenses and Electron 30/latest smoke tests in the complete cross-platform CI matrix.

## 0.2.0

### Minor Changes

- bf96f2f: Hot reload no longer replays a patch into a later session: patches carry the app process they were built for, the app removes each patch before applying it, and the dev server clears leftovers when it starts. Patches also no longer run the views crate's static initializers again (`actions!`/`#[derive(Action)]` registrations, `inventory`, napi export registration), which could crash the app.

  New window options: `titleBarStyle: "hidden"`, `trafficLightPosition`, `background` (`"opaque"`, `"transparent"`, `"blurred"`) and `alwaysOnTop`, plus `window.setAlwaysOnTop(flag, relativeLevel)` and `electron_gpui::macos::set_always_on_top` in Rust (both need an addon built with this version of the Rust SDK).

  `createGpui(addon, { panicLog })` appends every native panic to a file as a JSON line, so panics that abort the process can be reported on the next launch.

  The Vite plugin keeps the hot-reload restart trigger watched when `build.watch.include` is set, and the runtime's messages no longer contain relative `.node` paths that bundlers and asset checks treat as files to include.

### Patch Changes

- dc336b1: GPUI now comes from a revision of the `biw/zed` fork whose blurred window background works on macOS 27, so `background: "blurred"` (and `WindowBackgroundAppearance::Blurred`) blur what's behind the window again instead of leaving it sharp.
