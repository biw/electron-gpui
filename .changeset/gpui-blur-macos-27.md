---
"electron-gpui": patch
"electron-gpui-unplugin": patch
---

GPUI now comes from a revision of the `biw/zed` fork whose blurred window background works on macOS 27, so `background: "blurred"` (and `WindowBackgroundAppearance::Blurred`) blur what's behind the window again instead of leaving it sharp.
