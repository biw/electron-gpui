//! Shared look for the counter's views. A separate local crate, so the example
//! shows (and `pnpm smoke:hot` tests) that changes outside the views crate
//! rebuild and restart the app.

/// Reported in pong events, so tests can see which build is running.
pub const NAME: &str = "mocha";

/// Button background.
pub const ACCENT: u32 = 0x89b4fa;
