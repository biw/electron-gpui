use std::collections::HashSet;
use std::ffi::{CStr, CString, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

mod wayland_symbols;

// Electron 30 exports a private Wayland implementation. Mesa's EGL/Vulkan
// drivers and implicit layers otherwise bind to it while receiving objects
// created by system libwayland. Redirect only their Wayland imports; using
// RTLD_DEEPBIND also changes allocator bindings and breaks Electron's allocator.
pub(super) fn prepare() -> Result<(), String> {
    if (std::env::var_os("WAYLAND_DISPLAY").is_none()
        && std::env::var_os("WAYLAND_SOCKET").is_none())
        || !host_exports_private_wayland()
    {
        return Ok(());
    }
    static PREPARED: OnceLock<Result<(), String>> = OnceLock::new();
    PREPARED
        .get_or_init(|| {
            let client = open(OsStr::new("libwayland-client.so.0"))?;
            let cursor = open(OsStr::new("libwayland-cursor.so.0"))?;
            let mut roots = HashSet::from([
                wayland_symbols::library_base(client)?,
                wayland_symbols::library_base(cursor)?,
            ]);
            for manifest in graphics_manifests() {
                if let Err(error) = bind_manifest(&manifest, &mut roots) {
                    // An installed driver may be for a different architecture,
                    // unavailable on this machine, or disabled by configuration.
                    // The renderer still selects among the usable drivers.
                    if std::env::var_os("ELECTRON_GPUI_DEBUG").is_some() {
                        eprintln!("[electron-gpui] {}: {error}", manifest.display());
                    }
                }
            }
            wayland_symbols::redirect(&roots, client, cursor, prepare as *const ())
        })
        .clone()
}

fn host_exports_private_wayland() -> bool {
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"wl_proxy_marshal_flags".as_ptr()) };
    // Consume this probe's loader error before another library does a lookup.
    unsafe { libc::dlerror() };
    if symbol.is_null() {
        return false;
    }
    let mut info = std::mem::MaybeUninit::<libc::Dl_info>::uninit();
    if unsafe { libc::dladdr(symbol, info.as_mut_ptr()) } == 0 {
        return true;
    }
    let info = unsafe { info.assume_init() };
    if info.dli_fname.is_null() {
        return true;
    }
    let filename = unsafe { CStr::from_ptr(info.dli_fname) };
    !Path::new(OsStr::from_bytes(filename.to_bytes()))
        .file_name()
        .is_some_and(|name| name.as_bytes().starts_with(b"libwayland-client."))
}

fn open(library: &OsStr) -> Result<*mut libc::c_void, String> {
    let name = CString::new(library.as_bytes()).map_err(|error| error.to_string())?;
    // GNU/glibc is the supported Linux target. Retain each handle for the
    // process lifetime: the renderer and applied patches may keep its pointers.
    let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if !handle.is_null() {
        return Ok(handle);
    }
    let error = unsafe { libc::dlerror() };
    let reason = if error.is_null() {
        "unknown dynamic loader error".into()
    } else {
        unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned()
    };
    Err(format!("loading {}: {reason}", library.to_string_lossy()))
}

fn graphics_manifests() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(value) =
        std::env::var_os("VK_DRIVER_FILES").or_else(|| std::env::var_os("VK_ICD_FILENAMES"))
    {
        paths.extend(std::env::split_paths(&value));
    } else {
        if let Some(value) = std::env::var_os("VK_ADD_DRIVER_FILES") {
            paths.extend(std::env::split_paths(&value));
        }
        paths.extend(vulkan_directories("icd.d"));
    }
    paths.extend(vulkan_directories("implicit_layer.d"));
    if let Some(value) = std::env::var_os("__EGL_VENDOR_LIBRARY_FILENAMES") {
        paths.extend(std::env::split_paths(&value));
    } else if let Some(value) = std::env::var_os("__EGL_VENDOR_LIBRARY_DIRS") {
        paths.extend(std::env::split_paths(&value));
    } else {
        paths.extend([
            PathBuf::from("/etc/glvnd/egl_vendor.d"),
            PathBuf::from("/usr/share/glvnd/egl_vendor.d"),
        ]);
    }
    let mut manifests = Vec::new();
    for path in paths {
        if path.is_dir() {
            match std::fs::read_dir(&path) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) if entry.path().extension() == Some(OsStr::new("json")) => {
                                manifests.push(entry.path());
                            }
                            Ok(_) => {}
                            Err(error) => eprintln!("[electron-gpui] {}: {error}", path.display()),
                        }
                    }
                }
                Err(error) => eprintln!("[electron-gpui] {}: {error}", path.display()),
            }
        } else if path.is_file() {
            manifests.push(path);
        }
    }
    manifests.sort();
    manifests.dedup();
    manifests
}

fn vulkan_directories(kind: &str) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    let user_home = std::env::var_os("HOME").map(PathBuf::from);
    for (variable, fallback) in [
        ("XDG_CONFIG_HOME", ".config"),
        ("XDG_DATA_HOME", ".local/share"),
    ] {
        if let Some(value) = std::env::var_os(variable) {
            bases.push(PathBuf::from(value));
        } else if let Some(user_home) = &user_home {
            bases.push(user_home.join(fallback));
        }
    }
    for (variable, fallback) in [
        ("XDG_CONFIG_DIRS", "/etc/xdg"),
        ("XDG_DATA_DIRS", "/usr/local/share:/usr/share"),
    ] {
        let value = std::env::var_os(variable).unwrap_or_else(|| fallback.into());
        bases.extend(std::env::split_paths(&value));
    }
    bases.extend([PathBuf::from("/usr/local/etc"), PathBuf::from("/etc")]);
    bases
        .into_iter()
        .map(|base| base.join("vulkan").join(kind))
        .collect()
}

fn bind_manifest(path: &Path, roots: &mut HashSet<usize>) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|error| error.to_string())?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&data).map_err(|error| error.to_string())?;
    let entries = manifest["layers"].as_array().map_or_else(
        || vec![&manifest["ICD"], &manifest["layer"]],
        |layers| layers.iter().collect(),
    );
    for entry in entries {
        let matches_environment = |conditions: &serde_json::Value| {
            conditions.as_object().is_some_and(|conditions| {
                conditions.iter().any(|(name, value)| {
                    value.as_str().is_some_and(|value| {
                        std::env::var_os(name).is_some_and(|actual| actual == value)
                    })
                })
            })
        };
        if matches_environment(&entry["disable_environment"])
            || (entry.get("enable_environment").is_some()
                && !matches_environment(&entry["enable_environment"]))
        {
            continue;
        }
        let Some(library) = entry["library_path"].as_str() else {
            continue;
        };
        let library = Path::new(library);
        let library = if library.is_relative() && library.as_os_str().as_bytes().contains(&b'/') {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join(library)
        } else {
            library.to_owned()
        };
        roots.insert(wayland_symbols::library_base(open(library.as_os_str())?)?);
    }
    Ok(())
}
