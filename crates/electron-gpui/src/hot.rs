//! Hot-patching support for dev builds, built on [Subsecond](https://docs.rs/subsecond).
//!
//! Subsecond redirects calls made through [`HotFn`] to the newest version of a
//! function in a jump table. GPUI calls a view's `render` directly, so the window
//! root is a [`HotRoot`] that renders the user's view through `HotFn`; view
//! construction and `on_message` go through `HotFn` too. These helpers are
//! generic over the view, so they're compiled into the app's crate — the crate
//! that gets patched. In release builds (`debug_assertions` off) `HotFn` calls the
//! function directly.

use gpui::{AnyElement, Context, Entity, IntoElement, Render, Subscription, Window};
use serde_json::Value;
use subsecond::HotFn;

use crate::{RootView, WindowBridge};

/// Anchor for locating this addon in memory: the patch builder compares its
/// address in the running process with its address in the built `.node` file.
#[unsafe(no_mangle)]
#[inline(never)]
pub extern "C" fn electron_gpui_hot_anchor() {}

/// The address of [`electron_gpui_hot_anchor`] in this process, as hex.
pub(crate) fn anchor_address() -> String {
    format!("{:#x}", electron_gpui_hot_anchor as *const () as usize)
}

/// A window's root view: renders the user's view through `HotFn` so a patched
/// `render` takes effect on the next frame, without losing the view's state.
pub(crate) struct HotRoot<V: RootView> {
    pub(crate) view: Entity<V>,
    _observe_view: Subscription,
}

impl<V: RootView> HotRoot<V> {
    pub(crate) fn new(view: Entity<V>, cx: &mut Context<Self>) -> Self {
        // The view renders inside this root, so re-render when it notifies.
        let observe_view = cx.observe(&view, |_, _, cx| cx.notify());
        Self {
            view,
            _observe_view: observe_view,
        }
    }
}

impl<V: RootView> Render for HotRoot<V> {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.view.update(cx, |view, cx| {
            HotFn::current(render_view::<V>).call((view, window, cx))
        })
    }
}

fn render_view<V: RootView>(view: &mut V, window: &mut Window, cx: &mut Context<V>) -> AnyElement {
    view.render(window, cx).into_any_element()
}

fn construct_view<V: RootView>(
    props: Value,
    bridge: WindowBridge,
    window: &mut Window,
    cx: &mut Context<V>,
) -> V {
    V::new(props, bridge, window, cx)
}

fn deliver_message<V: RootView>(
    view: &mut V,
    message: Value,
    window: &mut Window,
    cx: &mut Context<V>,
) {
    view.on_message(message, window, cx)
}

/// `V::new`, through the jump table.
pub(crate) fn new_view<V: RootView>(
    props: Value,
    bridge: WindowBridge,
    window: &mut Window,
    cx: &mut Context<V>,
) -> V {
    HotFn::current(construct_view::<V>).call((props, bridge, window, cx))
}

/// `V::on_message`, through the jump table.
pub(crate) fn on_message<V: RootView>(
    view: &mut V,
    message: Value,
    window: &mut Window,
    cx: &mut Context<V>,
) {
    HotFn::current(deliver_message::<V>).call((view, message, window, cx))
}

/// Apply a jump table produced by the patch builder. Its keys are already
/// absolute addresses in this process (the builder knows our anchor), so the
/// table is marked as relative to Subsecond's own reference, making its
/// adjustment a no-op.
pub(crate) fn apply_patch(table_json: &str) -> anyhow::Result<()> {
    let mut table: subsecond::JumpTable = serde_json::from_str(table_json)?;
    table.aslr_reference = subsecond::aslr_reference() as u64;
    unsafe { subsecond::apply_patch(table) }.map_err(|err| anyhow::anyhow!("{err:?}"))
}
