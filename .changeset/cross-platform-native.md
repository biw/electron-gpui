---
"electron-gpui": minor
"electron-gpui-unplugin": minor
---

Add Windows x64 (MSVC) and Linux x64 (GNU/glibc, X11 and native Wayland) support, including in-process hot patching, portable native artifact discovery and Windows-safe development addon loading. Preserve macOS ARM64/Intel support and the existing window API. Window chrome and always-on-top options use documented platform-specific fallbacks. Validate builds, scaffolding and Electron 30/latest smoke tests in the complete cross-platform CI matrix.

Close development sessions with their bundler watchers, coalesce Electron restarts, cancel queued patches during shutdown, and require the running addon to match the full build used for patching.

Print portable scaffold loading examples and quote crate paths containing spaces, apostrophes, or URL characters.

Restart development apps for layout attributes, type aliases, constants, function signatures, registration changes and inherited Cargo workspace configuration. Keep newly added path dependencies watched, detect configuration saves reliably on macOS, keep ordinary function-body edits patchable and restrict Electron 30's Wayland import repair to the addon and its graphics driver dependency graph.
