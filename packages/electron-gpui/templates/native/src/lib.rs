use electron_gpui::{
    RootView, WindowBridge,
    gpui::{Context, IntoElement, Render, Window, div, prelude::*, rgb},
    serde_json::{Value, json},
};

/// A root view JS can open with `gpui.openWindow("Hello")`.
struct Hello {
    bridge: WindowBridge,
    name: String,
}

impl RootView for Hello {
    fn new(props: Value, bridge: WindowBridge, _window: &mut Window, _cx: &mut Context<Self>) -> Self {
        let name = props["name"].as_str().unwrap_or("world").to_owned();
        Hello { bridge, name }
    }

    fn on_message(&mut self, message: Value, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(name) = message["name"].as_str() {
            self.name = name.to_owned();
            cx.notify();
        }
    }
}

impl Render for Hello {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("root")
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgb(0x1e1e2e))
            .text_color(rgb(0xcdd6f4))
            .text_xl()
            .child(format!("Hello, {}!", self.name))
            .on_click(cx.listener(|this, _, _, _| {
                this.bridge.emit(json!({ "type": "clicked" })).ok();
            }))
    }
}

electron_gpui::export! {
    "Hello" => Hello,
}
