//! Host [GPUI](https://gpui.rs) windows inside an Electron app's main process.
//!
//! Electron owns `NSApp` and the run loop. GPUI runs embedded in it and opens its
//! own native windows, each rendering a [`RootView`] you register with [`export!`].
//! The `electron-gpui` npm package loads the resulting `.node` addon and gives
//! Electron's main process a typed API for opening windows and exchanging JSON
//! messages with them.
//!
//! ```ignore
//! use electron_gpui::{RootView, WindowBridge, gpui::*};
//!
//! struct Hello { bridge: WindowBridge }
//!
//! impl RootView for Hello {
//!     fn new(_props: serde_json::Value, bridge: WindowBridge, _: &mut Window, _: &mut Context<Self>) -> Self {
//!         Hello { bridge }
//!     }
//! }
//!
//! impl Render for Hello {
//!     fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
//!         div().child("Hello from GPUI")
//!     }
//! }
//!
//! electron_gpui::export! { "Hello" => Hello }
//! ```
//!
//! GPUI's macros (`actions!`, `#[derive(IntoElement)]`, `#[derive(Action)]`, ...)
//! expand to `gpui::` paths, so files that use them need the re-export in scope:
//! `use electron_gpui::gpui;`.

mod bridge;
mod export;
mod hot;
pub mod macos;
mod runtime;

pub use bridge::WindowBridge;
pub use gpui;
pub use runtime::Registry;
pub use serde_json;

/// Version of this crate, reported to the JS runtime.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Version of the JS <-> native protocol. The JS runtime refuses to load an addon
/// built against a different protocol version.
pub const PROTOCOL_VERSION: u32 = 1;

/// The root view of a GPUI window opened from JS.
pub trait RootView: gpui::Render + Sized + 'static {
    /// Build the view when JS opens a window for it. `props` is the JSON value
    /// passed to `openWindow` (or `null`). Keep `bridge` to send events to JS.
    ///
    /// Don't panic here: GPUI can't recover from a panic in the middle of opening
    /// a window, so `openWindow` throws and electron-gpui disables itself until
    /// the app relaunches. Validate `props` and fall back to defaults instead.
    fn new(
        props: serde_json::Value,
        bridge: WindowBridge,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> Self;

    /// Handle a JSON message sent from JS with `window.send(...)`.
    ///
    /// A panic here is caught before it reaches GPUI: `send` throws a JS error and
    /// the window keeps working.
    fn on_message(
        &mut self,
        message: serde_json::Value,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) {
        let _ = (message, window, cx);
    }
}

#[doc(hidden)]
pub mod __private {
    pub use crate::runtime::{
        apply_hot_patch, close, hot_anchor, init, open_window, send, set_always_on_top,
        set_event_callback, set_panic_log, shutdown, window_count,
    };
    pub use napi;
    pub use napi_derive;
}
