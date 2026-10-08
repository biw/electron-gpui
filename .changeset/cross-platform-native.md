---
"electron-gpui": minor
"electron-gpui-unplugin": minor
---

Add Windows x64 (MSVC) and Linux x64 (GNU/glibc, X11 and native Wayland) support, including in-process hot patching, portable native artifact discovery and Windows-safe development addon loading. Preserve macOS ARM64/Intel support and the existing window API. Window chrome and always-on-top options use documented platform-specific fallbacks. Validate builds, scaffolding and Electron 30/latest smoke tests in the complete cross-platform CI matrix.
