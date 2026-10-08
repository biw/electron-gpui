//! AppKit window settings that GPUI's `Window` doesn't expose.

use gpui::Window;
use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSWindow};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// `NSNormalWindowLevel`.
const NORMAL_WINDOW_LEVEL: isize = 0;
/// `NSFloatingWindowLevel`, the level Electron's `setAlwaysOnTop(true)` uses.
const FLOATING_WINDOW_LEVEL: isize = 3;

fn ns_window(window: &Window) -> Option<Retained<NSWindow>> {
    let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window).ok()?.as_raw()
    else {
        return None;
    };
    // SAFETY: GPUI's macOS window hands out its live content view; callers run on
    // the main thread, inside a GPUI update, while the window is open.
    let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.window()
}

/// Keep `window` above normal windows, like Electron's
/// `win.setAlwaysOnTop(flag, "floating", relativeLevel)`: with `on_top`, the
/// window moves to the floating level plus `relative_level`; otherwise back to
/// the normal level.
pub fn set_always_on_top(window: &Window, on_top: bool, relative_level: isize) {
    if let Some(ns_window) = ns_window(window) {
        ns_window.setLevel(if on_top {
            FLOATING_WINDOW_LEVEL + relative_level
        } else {
            NORMAL_WINDOW_LEVEL
        });
    }
}
