//! Process-wide GPUI state and the operations behind the generated napi exports.
//!
//! Everything here runs on the main thread: Electron's main-process JS runs there,
//! and so does GPUI. State lives in a thread-local. No borrow of it is held while
//! calling into GPUI, because GPUI can call back into this module synchronously
//! (for example, the window-closed hook fires inside `remove_window`).

use std::{
    any::Any,
    cell::RefCell,
    collections::HashMap,
    ffi::c_int,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};

use gpui::{
    App, AppContext as _, Application, ApplicationHandle, Bounds, TitlebarOptions, WindowBounds,
    WindowHandle, WindowId, WindowOptions, point, px, size,
};
use gpui_macos::MacPlatform;
use napi::{
    Error, Result, Status,
    bindgen_prelude::Function,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    RootView, WindowBridge,
    hot::{self, HotRoot},
};

type EventCallback = ThreadsafeFunction<String, (), String, Status, false>;
type Factory =
    Box<dyn Fn(&mut App, WindowOptions, Value, WindowBridge) -> anyhow::Result<OpenedWindow>>;

/// The set of root views an addon exposes to JS, keyed by name. Built by
/// [`export!`](crate::export).
#[derive(Default)]
pub struct Registry {
    views: HashMap<String, Factory>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Make `V` openable from JS as `openWindow(name, ...)`.
    pub fn register<V: RootView>(&mut self, name: &str) {
        let factory: Factory = Box::new(|cx, options, props, bridge| {
            let handle: WindowHandle<HotRoot<V>> = cx.open_window(options, move |window, cx| {
                let view = cx.new(|cx| hot::new_view(props, bridge, window, cx));
                cx.new(|cx| HotRoot::new(view, cx))
            })?;
            Ok(OpenedWindow {
                gpui_id: handle.window_id(),
                window: Rc::new(handle),
            })
        });
        self.views.insert(name.to_owned(), factory);
    }

    fn names(&self) -> Vec<&str> {
        let mut names: Vec<_> = self.views.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }
}

/// Type-erased operations on a window whose root view type is only known at
/// registration time.
trait AnyRootWindow {
    fn send(&self, cx: &mut App, message: Value) -> anyhow::Result<()>;
    fn close(&self, cx: &mut App) -> anyhow::Result<()>;
}

impl<V: RootView> AnyRootWindow for WindowHandle<HotRoot<V>> {
    fn send(&self, cx: &mut App, message: Value) -> anyhow::Result<()> {
        // Catch panics right around the user's code, inside GPUI's update, so
        // GPUI itself never unwinds and stays consistent.
        self.update(cx, |root, window, cx| {
            root.view.update(cx, |view, cx| {
                catch_unwind(AssertUnwindSafe(|| {
                    hot::on_message(view, message, window, cx)
                }))
            })
        })?
        .map_err(|payload| {
            anyhow::anyhow!(
                "RootView::on_message panicked: {}",
                panic_detail(payload.as_ref())
            )
        })
    }

    fn close(&self, cx: &mut App) -> anyhow::Result<()> {
        self.update(cx, |_, window, _| window.remove_window())
    }
}

struct OpenedWindow {
    gpui_id: WindowId,
    window: Rc<dyn AnyRootWindow>,
}

struct Runtime {
    app: Rc<ApplicationHandle>,
    registry: Rc<Registry>,
    windows: HashMap<u32, OpenedWindow>,
    next_window_id: u32,
    events: Option<Rc<EventCallback>>,
}

thread_local! {
    static RUNTIME: RefCell<Option<Runtime>> = const { RefCell::new(None) };
    /// Set when a panic unwound through GPUI. GPUI isn't unwind-safe (its update
    /// bookkeeping and entity leases are left mid-flight), so further use could
    /// silently stop rendering; every later call fails with this message instead.
    static POISONED: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn debug_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("ELECTRON_GPUI_DEBUG").is_ok_and(|value| !value.is_empty() && value != "0")
    })
}

/// JSON shape of `openWindow`'s options.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsWindowOptions {
    title: Option<String>,
    width: Option<f32>,
    height: Option<f32>,
    x: Option<f32>,
    y: Option<f32>,
    min_width: Option<f32>,
    min_height: Option<f32>,
    resizable: Option<bool>,
    focus: Option<bool>,
}

fn error(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}

/// Run the body of a JS-facing call: refuse to run after a poisoning panic, turn
/// panics into JS errors instead of unwinding into Node, and (with
/// `ELECTRON_GPUI_DEBUG=1`) report how long the call held the main thread.
fn guard<T>(name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    if let Some(reason) = POISONED.with(|poisoned| poisoned.borrow().clone()) {
        return Err(error(reason));
    }
    let started = std::time::Instant::now();
    let result = catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|payload| {
        let reason = format!(
            "electron-gpui: native panic in {name}: {}. GPUI can't recover from a panic \
             that unwinds through it, so electron-gpui is disabled until the app relaunches \
             (app.relaunch()).",
            panic_detail(payload.as_ref())
        );
        POISONED.with(|poisoned| *poisoned.borrow_mut() = Some(reason.clone()));
        Err(error(reason))
    });
    if debug_enabled() {
        let elapsed = started.elapsed();
        let note = if elapsed.as_millis() >= 16 {
            " (longer than a frame)"
        } else {
            ""
        };
        eprintln!("[electron-gpui] {name} held the main thread for {elapsed:.1?}{note}");
    }
    result
}

fn panic_detail(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

fn ensure_main_thread() -> Result<()> {
    unsafe extern "C" {
        fn pthread_main_np() -> c_int;
    }
    if unsafe { pthread_main_np() } == 1 {
        Ok(())
    } else {
        Err(error(
            "electron-gpui must be used from Electron's main process (main thread)",
        ))
    }
}

/// Borrow the runtime briefly. Never call into GPUI from inside `f`.
fn with_runtime<R>(f: impl FnOnce(&mut Runtime) -> Result<R>) -> Result<R> {
    RUNTIME.with(|runtime| match runtime.borrow_mut().as_mut() {
        Some(runtime) => f(runtime),
        None => Err(error("electron-gpui is not initialized; call init() first")),
    })
}

fn app() -> Result<Rc<ApplicationHandle>> {
    with_runtime(|runtime| Ok(runtime.app.clone()))
}

fn parse_json<T: for<'de> Deserialize<'de> + Default>(
    json: Option<String>,
    what: &str,
) -> Result<T> {
    match json {
        None => Ok(T::default()),
        Some(json) => {
            serde_json::from_str(&json).map_err(|err| error(format!("invalid {what}: {err}")))
        }
    }
}

pub(crate) fn emit(event: Value) {
    let callback = RUNTIME.with(|runtime| {
        runtime
            .borrow()
            .as_ref()
            .and_then(|runtime| runtime.events.clone())
    });
    if let Some(callback) = callback {
        callback.call(event.to_string(), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Start GPUI inside Electron. Idempotent.
pub fn init(registry: impl FnOnce() -> Registry) -> Result<()> {
    guard("init", || {
        ensure_main_thread()?;
        if RUNTIME.with(|runtime| runtime.borrow().is_some()) {
            return Ok(());
        }

        let platform = Rc::new(MacPlatform::new_embedded());
        let app = Application::with_platform(platform).run_embedded(|cx| {
            // Covers windows closed by the user as well as by `close()`.
            cx.on_window_closed(|_, gpui_id| {
                let window_id = RUNTIME.with(|runtime| {
                    let mut runtime = runtime.borrow_mut();
                    let runtime = runtime.as_mut()?;
                    let window_id = runtime
                        .windows
                        .iter()
                        .find_map(|(id, window)| (window.gpui_id == gpui_id).then_some(*id))?;
                    runtime.windows.remove(&window_id);
                    Some(window_id)
                });
                if let Some(window_id) = window_id {
                    emit(serde_json::json!({ "windowId": window_id, "type": "closed" }));
                }
            })
            .detach();
        });

        RUNTIME.with(|runtime| {
            *runtime.borrow_mut() = Some(Runtime {
                app: Rc::new(app),
                registry: Rc::new(registry()),
                windows: HashMap::new(),
                next_window_id: 1,
                events: None,
            })
        });
        Ok(())
    })
}

/// Register the JS handler that receives every event as a JSON string.
pub fn set_event_callback(callback: Function<String, ()>) -> Result<()> {
    guard("onEvent", || {
        ensure_main_thread()?;
        let callback = callback
            .build_threadsafe_function::<String>()
            .callee_handled::<false>()
            .build()?;
        with_runtime(|runtime| {
            runtime.events = Some(Rc::new(callback));
            Ok(())
        })
    })
}

/// Open a window rendering the registered view `view`. Returns its id.
pub fn open_window(
    view: String,
    options_json: Option<String>,
    props_json: Option<String>,
) -> Result<u32> {
    guard("openWindow", || {
        ensure_main_thread()?;
        let options: JsWindowOptions = parse_json(options_json, "window options")?;
        let props: Value = match props_json {
            None => Value::Null,
            Some(json) => {
                serde_json::from_str(&json).map_err(|err| error(format!("invalid props: {err}")))?
            }
        };

        let (app, registry, window_id) = with_runtime(|runtime| {
            if !runtime.registry.views.contains_key(&view) {
                return Err(error(format!(
                    "no GPUI view named {view:?}; registered views: {:?}",
                    runtime.registry.names()
                )));
            }
            let window_id = runtime.next_window_id;
            runtime.next_window_id += 1;
            Ok((runtime.app.clone(), runtime.registry.clone(), window_id))
        })?;

        let opened = app
            .update(|cx| {
                let window_size = size(
                    px(options.width.unwrap_or(800.)),
                    px(options.height.unwrap_or(600.)),
                );
                let bounds = match (options.x, options.y) {
                    (Some(x), Some(y)) => Bounds::new(point(px(x), px(y)), window_size),
                    _ => Bounds::centered(None, window_size, cx),
                };
                let min_size = match (options.min_width, options.min_height) {
                    (None, None) => None,
                    (w, h) => Some(size(px(w.unwrap_or(0.)), px(h.unwrap_or(0.)))),
                };
                let window_options = WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions {
                        title: options.title.map(Into::into),
                        ..Default::default()
                    }),
                    focus: options.focus.unwrap_or(true),
                    is_resizable: options.resizable.unwrap_or(true),
                    window_min_size: min_size,
                    ..Default::default()
                };
                (registry.views[&view])(cx, window_options, props, WindowBridge::new(window_id))
            })
            .map_err(|err| error(format!("failed to open GPUI window: {err:#}")))?;

        with_runtime(|runtime| {
            runtime.windows.insert(window_id, opened);
            Ok(window_id)
        })
    })
}

fn window(window_id: u32) -> Result<Rc<dyn AnyRootWindow>> {
    with_runtime(|runtime| {
        runtime
            .windows
            .get(&window_id)
            .map(|window| window.window.clone())
            .ok_or_else(|| error(format!("no open GPUI window with id {window_id}")))
    })
}

/// Deliver a JSON message to a window's [`RootView::on_message`].
pub fn send(window_id: u32, message_json: String) -> Result<()> {
    guard("send", || {
        ensure_main_thread()?;
        let message: Value = serde_json::from_str(&message_json)
            .map_err(|err| error(format!("invalid message: {err}")))?;
        let window = window(window_id)?;
        app()?
            .update(|cx| window.send(cx, message))
            .map_err(|err| error(format!("{err:#}")))
    })
}

/// Close a window. Its `closed` event follows.
pub fn close(window_id: u32) -> Result<()> {
    guard("close", || {
        ensure_main_thread()?;
        let window = window(window_id)?;
        app()?
            .update(|cx| window.close(cx))
            .map_err(|err| error(format!("{err:#}")))
    })
}

/// Number of open GPUI windows.
pub fn window_count() -> Result<u32> {
    guard("windowCount", || {
        RUNTIME.with(|runtime| {
            Ok(runtime
                .borrow()
                .as_ref()
                .map_or(0, |runtime| runtime.windows.len() as u32))
        })
    })
}

/// Close every window and stop delivering events. Call before the app quits.
///
/// GPUI itself stays loaded: tearing down its app state while the process keeps
/// running isn't supported by GPUI, and the process is about to exit anyway.
pub fn shutdown() -> Result<()> {
    // Runs during app quit: after a poisoning panic, skip GPUI instead of throwing.
    if POISONED.with(|poisoned| poisoned.borrow().is_some()) {
        return Ok(());
    }
    guard("shutdown", || {
        ensure_main_thread()?;
        let Some((app, windows)) = RUNTIME.with(|runtime| {
            let runtime = runtime.borrow();
            let runtime = runtime.as_ref()?;
            let windows: Vec<_> = runtime.windows.values().map(|w| w.window.clone()).collect();
            Some((runtime.app.clone(), windows))
        }) else {
            return Ok(());
        };

        app.update(|cx| {
            for window in windows {
                window.close(cx).ok();
            }
        });

        RUNTIME.with(|runtime| {
            if let Some(runtime) = runtime.borrow_mut().as_mut() {
                runtime.windows.clear();
                runtime.events = None;
            }
        });
        Ok(())
    })
}

/// The addon's anchor address in this process, for the hot-patch builder.
pub fn hot_anchor() -> Result<String> {
    Ok(hot::anchor_address())
}

/// Apply a hot patch (a Subsecond jump table as JSON) and redraw every window.
pub fn apply_hot_patch(table_json: String) -> Result<()> {
    guard("applyHotPatch", || {
        ensure_main_thread()?;
        hot::apply_patch(&table_json)
            .map_err(|err| error(format!("failed to apply hot patch: {err:#}")))?;
        app()?.update(|cx| cx.refresh_windows());
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_options_accept_camel_case_and_defaults() {
        let options: JsWindowOptions = parse_json(
            Some(r#"{"title":"t","minWidth":10,"resizable":false}"#.into()),
            "options",
        )
        .unwrap();
        assert_eq!(options.title.as_deref(), Some("t"));
        assert_eq!(options.min_width, Some(10.));
        assert_eq!(options.resizable, Some(false));
        assert!(options.width.is_none());

        let defaults: JsWindowOptions = parse_json(None, "options").unwrap();
        assert!(defaults.title.is_none());
    }

    #[test]
    fn invalid_json_is_a_js_error() {
        let err = parse_json::<JsWindowOptions>(Some("{".into()), "window options").unwrap_err();
        assert!(
            err.reason.contains("invalid window options"),
            "{}",
            err.reason
        );
    }

    #[test]
    fn panics_become_js_errors_and_disable_later_calls() {
        let err = guard::<()>("send", || panic!("boom")).unwrap_err();
        assert!(
            err.reason.contains("native panic in send: boom"),
            "{}",
            err.reason
        );
        assert!(err.reason.contains("relaunch"), "{}", err.reason);

        let later = guard("windowCount", || Ok(1)).unwrap_err();
        assert_eq!(later.reason, err.reason);
        // Quitting still works.
        assert!(shutdown().is_ok());
    }

    #[test]
    fn calls_before_init_fail_cleanly() {
        let err = window(1).err().expect("no runtime yet");
        assert!(err.reason.contains("not initialized"), "{}", err.reason);
        assert_eq!(window_count().unwrap(), 0);
    }
}
