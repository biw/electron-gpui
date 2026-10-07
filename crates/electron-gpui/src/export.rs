/// Generate the addon's napi exports for a set of [`RootView`](crate::RootView)s.
///
/// Call it once at the root of your addon crate (a `cdylib`):
///
/// ```ignore
/// electron_gpui::export! {
///     "Counter" => Counter,
///     "Settings" => settings::SettingsView,
/// }
/// ```
///
/// The names are what JS passes to `gpui.openWindow(name, ...)`.
#[macro_export]
macro_rules! export {
    ($($name:literal => $view:ty),+ $(,)?) => {
        #[doc(hidden)]
        mod __electron_gpui_exports {
            #[allow(unused_imports)]
            use super::*;
            use $crate::__private::napi;
            use $crate::__private::napi_derive::napi;

            fn registry() -> $crate::Registry {
                let mut registry = $crate::Registry::new();
                $(registry.register::<$view>($name);)+
                registry
            }

            // napi's macros compile the exports out of `cfg(test)` builds; keep
            // the registry (and so the user's views) alive there too.
            #[used]
            static __KEEP_REGISTRY: fn() -> $crate::Registry = registry;

            #[napi]
            pub fn version() -> String {
                $crate::VERSION.to_owned()
            }

            #[napi]
            pub fn protocol_version() -> u32 {
                $crate::PROTOCOL_VERSION
            }

            #[napi]
            pub fn init() -> napi::Result<()> {
                $crate::__private::init(registry)
            }

            #[napi(ts_args_type = "callback: (eventJson: string) => void")]
            pub fn on_event(callback: napi::bindgen_prelude::Function<String, ()>) -> napi::Result<()> {
                $crate::__private::set_event_callback(callback)
            }

            #[napi]
            pub fn open_window(
                view: String,
                options_json: Option<String>,
                props_json: Option<String>,
            ) -> napi::Result<u32> {
                $crate::__private::open_window(view, options_json, props_json)
            }

            #[napi]
            pub fn send(window_id: u32, message_json: String) -> napi::Result<()> {
                $crate::__private::send(window_id, message_json)
            }

            #[napi]
            pub fn close(window_id: u32) -> napi::Result<()> {
                $crate::__private::close(window_id)
            }

            #[napi]
            pub fn window_count() -> napi::Result<u32> {
                $crate::__private::window_count()
            }

            #[napi]
            pub fn shutdown() -> napi::Result<()> {
                $crate::__private::shutdown()
            }

            #[napi]
            pub fn hot_anchor() -> napi::Result<String> {
                $crate::__private::hot_anchor()
            }

            #[napi]
            pub fn apply_hot_patch(table_json: String) -> napi::Result<()> {
                $crate::__private::apply_hot_patch(table_json)
            }
        }
    };
}
