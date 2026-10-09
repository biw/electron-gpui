#[cfg(any(target_os = "windows", target_os = "linux"))]
use napi::Error;
use napi::Result;

#[cfg(target_os = "macos")]
pub(crate) type EmbeddedPlatform = gpui_macos::MacPlatform;
#[cfg(target_os = "windows")]
pub(crate) type EmbeddedPlatform = gpui_windows::WindowsPlatform;
#[cfg(target_os = "linux")]
pub(crate) type EmbeddedPlatform = gpui_linux::LinuxPlatform;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
compile_error!("electron-gpui supports macOS, Windows MSVC, and Linux GNU");

pub(crate) fn new() -> Result<EmbeddedPlatform> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        Ok(EmbeddedPlatform::new_embedded())
    }
    #[cfg(target_os = "windows")]
    {
        EmbeddedPlatform::new_embedded()
            .map_err(|err| Error::from_reason(format!("initializing Windows GPUI: {err:#}")))
    }
}

pub(crate) fn poll(platform: &EmbeddedPlatform) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        platform
            .poll_events()
            .map_err(|err| Error::from_reason(format!("dispatching Linux GPUI events: {err:#}")))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = platform;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
static MAIN_THREAD: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

pub(crate) fn record_main_thread() {
    // createGpui rejects worker threads before entering the addon. Retain the
    // initializing thread so later direct addon calls cannot migrate the runtime.
    #[cfg(target_os = "windows")]
    {
        MAIN_THREAD.get_or_init(|| std::thread::current().id());
    }
}

pub(crate) fn is_main_thread() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn pthread_main_np() -> std::ffi::c_int;
        }
        unsafe { pthread_main_np() == 1 }
    }
    #[cfg(target_os = "linux")]
    {
        unsafe { libc::syscall(libc::SYS_gettid) == libc::getpid() as libc::c_long }
    }
    #[cfg(target_os = "windows")]
    {
        MAIN_THREAD
            .get()
            .is_some_and(|thread| *thread == std::thread::current().id())
    }
}
