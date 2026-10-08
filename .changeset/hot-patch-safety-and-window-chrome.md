---
"electron-gpui": minor
"electron-gpui-unplugin": minor
---

Hot reload no longer replays a patch into a later session: patches carry the app process they were built for, the app removes each patch before applying it, and the dev server clears leftovers when it starts. Patches also no longer run the views crate's static initializers again (`actions!`/`#[derive(Action)]` registrations, `inventory`, napi export registration), which could crash the app.

New window options: `titleBarStyle: "hidden"`, `trafficLightPosition`, `background` (`"opaque"`, `"transparent"`, `"blurred"`) and `alwaysOnTop`, plus `window.setAlwaysOnTop(flag, relativeLevel)` and `electron_gpui::macos::set_always_on_top` in Rust (both need an addon built with this version of the Rust SDK).

`createGpui(addon, { panicLog })` appends every native panic to a file as a JSON line, so panics that abort the process can be reported on the next launch.

The Vite plugin keeps the hot-reload restart trigger watched when `build.watch.include` is set, and the runtime's messages no longer contain relative `.node` paths that bundlers and asset checks treat as files to include.
