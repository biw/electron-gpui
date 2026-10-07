//! The counter example's GPUI views. This is the crate an app writes: views
//! implement `RootView`, and `export!` turns them into the `.node` addon.

use electron_gpui::{
    RootView, WindowBridge,
    gpui::{
        Context, Div, FocusHandle, IntoElement, KeyDownEvent, Render, SharedString, Stateful,
        Window, div, prelude::*, px, rgb,
    },
    serde_json::{Value, json},
};
use serde::Deserialize;

struct Counter {
    bridge: WindowBridge,
    count: i64,
    message: SharedString,
    last_key: SharedString,
    focus_handle: FocusHandle,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Incoming {
    /// Show a message from JS.
    SetMessage { text: String },
    /// Reply with `pong`; used by the smoke test.
    Ping,
    /// Panic; the smoke test checks this surfaces as a JS error and the window
    /// keeps working.
    Panic,
}

impl RootView for Counter {
    fn new(
        props: Value,
        bridge: WindowBridge,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window, cx);
        Counter {
            bridge,
            count: props["start"].as_i64().unwrap_or(0),
            message: "(none yet)".into(),
            last_key: "(none yet)".into(),
            focus_handle,
        }
    }

    fn on_message(&mut self, message: Value, _window: &mut Window, cx: &mut Context<Self>) {
        match serde_json_message(message) {
            Some(Incoming::SetMessage { text }) => {
                self.message = text.into();
                cx.notify();
            }
            Some(Incoming::Ping) => {
                self.bridge
                    .emit(json!({ "type": "pong", "theme": counter_theme::NAME }))
                    .ok();
            }
            Some(Incoming::Panic) => panic!("requested by the smoke test"),
            None => {}
        }
    }
}

fn serde_json_message(message: Value) -> Option<Incoming> {
    Incoming::deserialize(message).ok()
}

impl Counter {
    fn change(&mut self, delta: i64, cx: &mut Context<Self>) {
        self.count += delta;
        self.bridge
            .emit(json!({ "type": "count", "count": self.count }))
            .ok();
        cx.notify();
    }
}

fn button(id: &'static str, label: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .px_4()
        .py_2()
        .rounded_md()
        .bg(rgb(counter_theme::ACCENT))
        .hover(|style| style.bg(rgb(0xb4befe)))
        .text_color(rgb(0x1e1e2e))
        .cursor_pointer()
        .child(label)
}

impl Render for Counter {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                let key = event.keystroke.to_string();
                this.bridge.emit(json!({ "type": "key", "key": key })).ok();
                this.last_key = key.into();
                cx.notify();
            }))
            .size_full()
            .flex()
            .flex_col()
            .gap_4()
            .p_6()
            .bg(rgb(0x1e1e2e))
            .text_color(rgb(0xcdd6f4))
            .child(div().text_xl().child("GPUI counter"))
            .child(div().text_3xl().child(self.count.to_string()))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        button("decrement", "−")
                            .w(px(48.))
                            .on_click(cx.listener(|this, _, _, cx| this.change(-1, cx))),
                    )
                    .child(
                        button("increment", "+")
                            .w(px(48.))
                            .on_click(cx.listener(|this, _, _, cx| this.change(1, cx))),
                    ),
            )
            .child(format!("Message from JS: {}", self.message))
            .child(format!("Last key typed here: {}", self.last_key))
    }
}

electron_gpui::export! {
    "Counter" => Counter,
}
