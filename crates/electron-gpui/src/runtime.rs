//! Process-wide GPUI state and the operations behind the generated napi exports.
//!
//! Everything here runs on the main thread: Electron's main-process JS runs there,
//! and so does GPUI. State lives in a thread-local. No borrow of it is held while
//! calling into GPUI, because GPUI can call back into this module synchronously
//! (for example, the window-closed hook fires inside `remove_window`).

use std::{
    any::Any,
    cell::{Cell, RefCell},
    collections::HashMap,
    io::Write as _,
    mem::ManuallyDrop,
    panic::{self, AssertUnwindSafe, PanicHookInfo, catch_unwind},
    path::PathBuf,
    rc::Rc,
    sync::{Mutex, Once},
    time::{SystemTime, UNIX_EPOCH},
};

use gpui::{
    App, AppContext as _, Application, ApplicationHandle, Bounds, TitlebarOptions,
    WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowId, WindowOptions, point, px,
    size,
};
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
    platform,
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
    fn set_always_on_top(
        &self,
        cx: &mut App,
        on_top: bool,
        relative_level: isize,
    ) -> anyhow::Result<()>;
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

    fn set_always_on_top(
        &self,
        cx: &mut App,
        on_top: bool,
        relative_level: isize,
    ) -> anyhow::Result<()> {
        self.update(cx, |_, window, _| {
            crate::set_always_on_top(window, on_top, relative_level)
        })
    }
}

struct OpenedWindow {
    gpui_id: WindowId,
    window: Rc<dyn AnyRootWindow>,
}

struct Runtime {
    platform: Rc<platform::EmbeddedPlatform>,
    app: Rc<ApplicationHandle>,
    registry: Rc<Registry>,
    windows: HashMap<u32, OpenedWindow>,
    next_window_id: u32,
    events: Option<Rc<EventCallback>>,
}

thread_local! {
    // GPUI app/platform state is process-owned. In particular, Linux runs TLS
    // destructors during Electron's exit; dropping GPUI then can call back into
    // already-destroyed thread locals. shutdown closes windows and releases NAPI
    // callbacks, while the app itself stays alive until the OS reclaims it.
    static RUNTIME: RefCell<Option<ManuallyDrop<Runtime>>> = const { RefCell::new(None) };
    /// Set when a panic unwound through GPUI. GPUI isn't unwind-safe (its update
    /// bookkeeping and entity leases are left mid-flight), so further use could
    /// silently stop rendering; every later call fails with this message instead.
    static POISONED: RefCell<Option<String>> = const { RefCell::new(None) };
    /// How many JS-facing calls are running on this thread. A panic on the main
    /// thread outside them (while GPUI draws or handles input for AppKit) can't be
    /// caught and aborts the process.
    static GUARD_DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// Where the panic hook appends a JSON line per panic (`setPanicLog`).
static PANIC_LOG: Mutex<Option<PathBuf>> = Mutex::new(None);

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
    title_bar_style: Option<TitleBarStyle>,
    traffic_light_position: Option<JsPoint>,
    background: Option<Background>,
    always_on_top: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum TitleBarStyle {
    /// The standard titlebar.
    Default,
    /// Content extends under a transparent titlebar without a title; the traffic
    /// lights stay.
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
struct JsPoint {
    x: f32,
    y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Background {
    Opaque,
    Transparent,
    /// Transparent, with the content behind the window blurred.
    Blurred,
}

impl From<Background> for WindowBackgroundAppearance {
    fn from(background: Background) -> Self {
        match background {
            Background::Opaque => Self::Opaque,
            Background::Transparent => Self::Transparent,
            Background::Blurred if cfg!(target_os = "macos") => Self::Blurred,
            Background::Blurred => Self::Transparent,
        }
    }
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
    GUARD_DEPTH.with(|depth| depth.set(depth.get() + 1));
    let result = catch_unwind(AssertUnwindSafe(f));
    GUARD_DEPTH.with(|depth| depth.set(depth.get() - 1));
    let result = result.unwrap_or_else(|payload| {
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

fn is_main_thread() -> bool {
    platform::is_main_thread()
}

/// Install (once) a panic hook that reports panics GPUI can't recover from and
/// appends every panic to the panic log, then runs the previous hook.
fn install_panic_hook() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            report_panic(info);
            previous(info);
        }));
    });
}

fn report_panic(info: &PanicHookInfo<'_>) {
    // Unwinding out of a GPUI callback that AppKit called aborts the process.
    let aborts = is_main_thread() && GUARD_DEPTH.with(Cell::get) == 0;
    if aborts {
        eprintln!(
            "electron-gpui: panic while GPUI was drawing or handling input; it can't be caught, \
             so the process will abort"
        );
    }
    if PANIC_LOG.lock().map_or(true, |log| log.is_none()) {
        return;
    }
    let entry = serde_json::json!({
        "time": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64),
        "message": panic_detail(info.payload()),
        "location": info.location().map(|location| location.to_string()),
        "thread": std::thread::current().name().map(str::to_owned),
        "aborts": aborts,
        "backtrace": std::backtrace::Backtrace::force_capture().to_string(),
    });
    let line = format!("{entry}\n");
    // One write per entry, under the lock, so panics on several threads at once
    // don't interleave. Best effort: the process may be about to abort.
    let Ok(log) = PANIC_LOG.lock() else {
        return;
    };
    if let Some(path) = log.as_ref()
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Append a JSON line to `path` for every native panic (or stop, with `None`),
/// so an app can report crashes GPUI can't recover from on its next launch.
pub fn set_panic_log(path: Option<String>) -> Result<()> {
    install_panic_hook();
    *PANIC_LOG
        .lock()
        .map_err(|_| error("electron-gpui: panic log lock poisoned"))? = path.map(PathBuf::from);
    Ok(())
}

fn ensure_main_thread() -> Result<()> {
    if is_main_thread() {
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
        platform::record_main_thread();
        ensure_main_thread()?;
        install_panic_hook();
        if RUNTIME.with(|runtime| runtime.borrow().is_some()) {
            return Ok(());
        }

        let platform = Rc::new(platform::new()?);
        let app = Application::with_platform(platform.clone())
            .with_quit_mode(gpui::QuitMode::Explicit)
            .run_embedded(|cx| {
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
            *runtime.borrow_mut() = Some(ManuallyDrop::new(Runtime {
                platform,
                app: Rc::new(app),
                registry: Rc::new(registry()),
                windows: HashMap::new(),
                next_window_id: 1,
                events: None,
            }))
        });
        Ok(())
    })
}

/// Dispatch Linux's pending platform events without blocking Electron.
pub fn poll_events() -> Result<()> {
    guard("pollEvents", || {
        ensure_main_thread()?;
        let platform = with_runtime(|runtime| Ok(runtime.platform.clone()))?;
        platform::poll(&platform)
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
                        appears_transparent: cfg!(target_os = "macos")
                            && options.title_bar_style == Some(TitleBarStyle::Hidden),
                        traffic_light_position: options
                            .traffic_light_position
                            .filter(|_| cfg!(target_os = "macos"))
                            .map(|position| point(px(position.x), px(position.y))),
                    }),
                    window_background: options.background.map(Into::into).unwrap_or_default(),
                    focus: options.focus.unwrap_or(true),
                    is_resizable: options.resizable.unwrap_or(true),
                    window_min_size: min_size,
                    ..Default::default()
                };
                let opened = (registry.views[&view])(
                    cx,
                    window_options,
                    props,
                    WindowBridge::new(window_id),
                )?;
                if options.always_on_top == Some(true) {
                    opened.window.set_always_on_top(cx, true, 0)?;
                }
                anyhow::Ok(opened)
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

/// Keep a window above normal windows (see [`crate::set_always_on_top`]).
pub fn set_always_on_top(window_id: u32, on_top: bool, relative_level: Option<i32>) -> Result<()> {
    guard("setAlwaysOnTop", || {
        ensure_main_thread()?;
        let window = window(window_id)?;
        app()?
            .update(|cx| window.set_always_on_top(cx, on_top, relative_level.unwrap_or(0) as isize))
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
    fn window_chrome_options_parse() {
        let options: JsWindowOptions = parse_json(
            Some(
                r#"{"titleBarStyle":"hidden","trafficLightPosition":{"x":20,"y":16},"background":"blurred","alwaysOnTop":true}"#
                    .into(),
            ),
            "options",
        )
        .unwrap();
        assert_eq!(options.title_bar_style, Some(TitleBarStyle::Hidden));
        assert_eq!(
            options.traffic_light_position,
            Some(JsPoint { x: 20., y: 16. })
        );
        assert_eq!(
            WindowBackgroundAppearance::from(options.background.unwrap()),
            if cfg!(target_os = "macos") {
                WindowBackgroundAppearance::Blurred
            } else {
                WindowBackgroundAppearance::Transparent
            }
        );
        assert_eq!(options.always_on_top, Some(true));

        let err = parse_json::<JsWindowOptions>(
            Some(r#"{"background":"frosted"}"#.into()),
            "window options",
        )
        .unwrap_err();
        assert!(err.reason.contains("frosted"), "{}", err.reason);
    }

    /// One test, because the panic log is process-wide.
    #[test]
    fn panic_log_records_each_panic_as_a_json_line() {
        let path =
            std::env::temp_dir().join(format!("electron-gpui-panics-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        set_panic_log(Some(path.display().to_string())).unwrap();
        let _ = std::thread::Builder::new()
            .name("panicky".into())
            .spawn(|| panic!("logged"))
            .unwrap()
            .join();
        // Panics on several threads at once still log whole lines.
        let threads: Vec<_> = (0..8)
            .map(|i| std::thread::spawn(move || panic!("concurrent {i}")))
            .collect();
        for thread in threads {
            let _ = thread.join();
        }
        set_panic_log(None).unwrap();

        let log = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        // Other tests may panic while the log is set.
        let entries: Vec<Value> = log
            .lines()
            .map(|line| serde_json::from_str(line).expect("a whole JSON line"))
            .collect();
        let entry = entries
            .iter()
            .find(|entry| entry["message"] == "logged")
            .expect("the panic was logged");
        assert_eq!(entry["thread"], "panicky");
        // Off the main thread, a panic only ends that thread.
        assert_eq!(entry["aborts"], false);
        assert!(entry["location"].as_str().unwrap().contains("runtime.rs"));
        let concurrent = entries
            .iter()
            .filter(|entry| {
                entry["message"]
                    .as_str()
                    .is_some_and(|message| message.starts_with("concurrent "))
            })
            .count();
        assert_eq!(concurrent, 8, "{log}");
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
