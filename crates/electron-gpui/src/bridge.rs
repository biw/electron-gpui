use serde::Serialize;

use crate::runtime;

/// A view's connection back to JS. Cheap to clone; keep it in your view.
#[derive(Clone, Debug)]
pub struct WindowBridge {
    window_id: u32,
}

impl WindowBridge {
    pub(crate) fn new(window_id: u32) -> Self {
        Self { window_id }
    }

    /// The id JS uses for this window.
    pub fn window_id(&self) -> u32 {
        self.window_id
    }

    /// Send an event to this window's JS listeners (`window.on("event", ...)`).
    ///
    /// Delivery is queued onto Node's event loop, so listeners never run while
    /// GPUI is in the middle of an update.
    pub fn emit(&self, payload: impl Serialize) -> serde_json::Result<()> {
        let payload = serde_json::to_value(payload)?;
        runtime::emit(serde_json::json!({
            "windowId": self.window_id,
            "type": "event",
            "payload": payload,
        }));
        Ok(())
    }
}
