//! Builds hot patches for an electron-gpui addon.
//!
//! ```text
//! electron-gpui-hotpatch fat   <crate-dir> <out.node>
//!     Build the addon so it can be patched later: keeps every symbol and records
//!     the rustc and linker invocations for the crate.
//! electron-gpui-hotpatch patch <crate-dir> <runtime-anchor-hex> <out.json>
//!     Recompile the crate, link the changed code into a patch dylib, and write a
//!     Subsecond jump table for the running app (whose anchor address is given).
//! ```
//!
//! `patch` exits with [`EXIT_COMPILE_ERROR`] when the crate doesn't compile (the
//! caller should show the errors and wait for the next edit) and with
//! [`EXIT_NOT_PATCHABLE`] when it compiled but can't be patched in (the caller
//! should rebuild and restart instead).
//!
//! The same binary is also Cargo's rustc wrapper and rustc's linker during those
//! builds (see `main`). Approach adapted from the Dioxus CLI (MIT OR Apache-2.0; used under MIT).

mod patch;

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

const CAPTURE_DIR: &str = "ELECTRON_GPUI_HOT_CAPTURE";
const TIP_CRATE: &str = "ELECTRON_GPUI_HOT_TIP";
const LINK_MODE: &str = "ELECTRON_GPUI_HOT_LINK";
const LINK_ARGS: &str = "ELECTRON_GPUI_HOT_LINK_ARGS";

const EXIT_COMPILE_ERROR: u8 = 10;
const EXIT_NOT_PATCHABLE: u8 = 11;

/// A recorded rustc invocation for the tip crate.
#[derive(Serialize, Deserialize)]
struct RustcInvocation {
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: PathBuf,
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let result = if env::var_os(CAPTURE_DIR).is_some() && args.get(1).is_some_and(|a| is_rustc(a)) {
        // Cargo runs `$RUSTC_WORKSPACE_WRAPPER $RUSTC <args>`.
        rustc_wrapper(&args[1..])
    } else if let Ok(mode) = env::var(LINK_MODE) {
        // rustc runs `-Clinker` with the link arguments.
        linker(&mode, &args[1..])
    } else {
        match args.get(1).map(String::as_str) {
            Some("fat") if args.len() == 4 => fat(Path::new(&args[2]), Path::new(&args[3])),
            Some("patch") if args.len() == 5 => {
                patch(Path::new(&args[2]), &args[3], Path::new(&args[4]))
            }
            _ => {
                eprintln!(
                    "usage:\n  electron-gpui-hotpatch fat <crate-dir> <out.node>\n  electron-gpui-hotpatch patch <crate-dir> <runtime-anchor-hex> <out.json>"
                );
                return ExitCode::from(2);
            }
        }
    };
    match result {
        Ok(code) => code,
        Err(err) => {
            eprintln!("electron-gpui-hotpatch: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn is_rustc(arg: &str) -> bool {
    Path::new(arg)
        .file_stem()
        .is_some_and(|stem| stem == "rustc")
}

fn exit_code(status: std::process::ExitStatus) -> ExitCode {
    ExitCode::from(status.code().unwrap_or(1) as u8)
}

/// Record the tip crate's rustc invocation, then run rustc.
fn rustc_wrapper(rustc_and_args: &[String]) -> Result<ExitCode> {
    let crate_name = rustc_and_args
        .windows(2)
        .find(|w| w[0] == "--crate-name")
        .map(|w| w[1].as_str());
    if crate_name.is_some() && crate_name == env::var(TIP_CRATE).ok().as_deref() {
        let invocation = RustcInvocation {
            args: rustc_and_args.to_vec(),
            env: env::vars().collect(),
            cwd: env::current_dir()?,
        };
        let path = PathBuf::from(env::var(CAPTURE_DIR)?).join("rustc.json");
        std::fs::write(path, serde_json::to_vec_pretty(&invocation)?)?;
    }
    let status = Command::new(&rustc_and_args[0])
        .args(&rustc_and_args[1..])
        .status()?;
    Ok(exit_code(status))
}

/// Record the link arguments; then link for real (`passthrough`) or just produce
/// an empty output so rustc is satisfied (`record`, used for patch builds).
fn linker(mode: &str, args: &[String]) -> Result<ExitCode> {
    let expanded = expand_response_files(args)?;
    if let Ok(path) = env::var(LINK_ARGS) {
        std::fs::write(path, serde_json::to_vec_pretty(&expanded)?)?;
    }
    match mode {
        "passthrough" => Ok(exit_code(Command::new("cc").args(args).status()?)),
        "record" => {
            if let Some(out) = expanded.windows(2).find(|w| w[0] == "-o").map(|w| &w[1]) {
                std::fs::write(out, [])?;
            }
            Ok(ExitCode::SUCCESS)
        }
        other => bail!("unknown link mode {other}"),
    }
}

/// rustc passes long argument lists as `@file`, one argument per line.
fn expand_response_files(args: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for arg in args {
        match arg.strip_prefix('@') {
            Some(file) => out.extend(std::fs::read_to_string(file)?.lines().map(str::to_owned)),
            None => out.push(arg.clone()),
        }
    }
    Ok(out)
}

struct CrateInfo {
    lib_name: String,
    package_name: String,
    target_dir: PathBuf,
}

fn crate_info(crate_dir: &Path) -> Result<CrateInfo> {
    let manifest = crate_dir.join("Cargo.toml").canonicalize()?;
    let output = Command::new("cargo")
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--manifest-path",
        ])
        .arg(&manifest)
        .output()?;
    if !output.status.success() {
        bail!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let package = metadata["packages"]
        .as_array()
        .and_then(|packages| {
            packages.iter().find(|p| {
                p["manifest_path"].as_str().map(PathBuf::from).as_ref() == Some(&manifest)
            })
        })
        .context("crate not found in cargo metadata")?;
    let lib = package["targets"]
        .as_array()
        .and_then(|targets| {
            targets.iter().find(|t| {
                t["kind"]
                    .as_array()
                    .is_some_and(|k| k.iter().any(|k| k == "cdylib"))
            })
        })
        .context("the crate has no cdylib target")?;
    Ok(CrateInfo {
        lib_name: lib["name"].as_str().unwrap_or_default().replace('-', "_"),
        package_name: package["name"].as_str().unwrap_or_default().to_owned(),
        target_dir: PathBuf::from(metadata["target_directory"].as_str().unwrap_or("target")),
    })
}

fn state_dir(info: &CrateInfo) -> PathBuf {
    info.target_dir
        .join("electron-gpui-hot")
        .join(&info.lib_name)
}

fn fat(crate_dir: &Path, out: &Path) -> Result<ExitCode> {
    let info = crate_info(crate_dir)?;
    let state = state_dir(&info);
    std::fs::create_dir_all(&state)?;
    let me = env::current_exe()?;

    // Make cargo rerun rustc for the crate so its invocation is recorded.
    let fingerprints = info.target_dir.join("debug").join(".fingerprint");
    if let Ok(entries) = std::fs::read_dir(&fingerprints) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{}-", info.package_name))
            {
                std::fs::remove_dir_all(entry.path()).ok();
            }
        }
    }

    let status = Command::new("cargo")
        .args(["rustc", "--lib", "--manifest-path"])
        .arg(crate_dir.join("Cargo.toml"))
        .args(["--", "-Csave-temps=true", "-Clink-dead-code"])
        .arg(format!("-Clinker={}", me.display()))
        .env("RUSTC_WORKSPACE_WRAPPER", &me)
        .env(CAPTURE_DIR, &state)
        .env(TIP_CRATE, &info.lib_name)
        .env(LINK_MODE, "passthrough")
        .env(LINK_ARGS, state.join("fat-link-args.json"))
        .status()?;
    if !status.success() {
        return Ok(exit_code(status));
    }
    if !state.join("rustc.json").exists() {
        bail!(
            "rustc wasn't run for {}; nothing was captured",
            info.lib_name
        );
    }

    let built = info
        .target_dir
        .join("debug")
        .join(format!("lib{}.dylib", info.lib_name));
    // Keep the exact binary patches are built against, then publish it.
    std::fs::copy(&built, state.join("original.node"))?;
    let staging = out.with_extension(format!("node.{}.tmp", std::process::id()));
    std::fs::copy(&built, &staging)?;
    std::fs::rename(&staging, out)?;
    Ok(ExitCode::SUCCESS)
}

fn patch(crate_dir: &Path, anchor_hex: &str, out: &Path) -> Result<ExitCode> {
    let started = std::time::Instant::now();
    let info = crate_info(crate_dir)?;
    let state = state_dir(&info);
    let invocation: RustcInvocation = serde_json::from_slice(
        &std::fs::read(state.join("rustc.json"))
            .context("no fat build recorded; run `fat` first")?,
    )?;
    let fat_link_args: Vec<String> =
        serde_json::from_slice(&std::fs::read(state.join("fat-link-args.json"))?)?;
    let cache = patch::ModuleCache::load(&state.join("original.node"))?;
    let runtime_anchor = u64::from_str_radix(anchor_hex.trim_start_matches("0x"), 16)?;
    let slide = runtime_anchor.wrapping_sub(cache.anchor_address()?);

    // Recompile the crate into a scratch directory; rustc calls us back as its
    // linker, and we only record which object files it would link.
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let thin = state.join(format!("patch-{stamp}"));
    remove_old_patches(&state, 5);
    std::fs::create_dir_all(&thin)?;
    let mut rustc_args = invocation.args[1..].to_vec();
    if let Some(i) = rustc_args.iter().position(|a| a == "--out-dir") {
        rustc_args[i + 1] = thin.display().to_string();
    }
    // rustc strips debug info from its output by default in dev; the output here
    // is an empty placeholder, so don't.
    rustc_args.push("-Cstrip=none".into());
    let status = Command::new(&invocation.args[0])
        .args(&rustc_args)
        .current_dir(&invocation.cwd)
        .env_clear()
        // Cargo's jobserver file descriptors don't exist outside that cargo run.
        .envs(
            invocation
                .env
                .iter()
                .filter(|(k, _)| !k.contains("MAKEFLAGS") && k.as_str() != "CARGO_MAKEFLAGS"),
        )
        .env(LINK_MODE, "record")
        .env(LINK_ARGS, thin.join("link-args.json"))
        .stderr(std::process::Stdio::piped())
        .output()?;
    print_errors(&status.stderr);
    if !status.status.success() {
        return Ok(ExitCode::from(EXIT_COMPILE_ERROR));
    }
    let link_args: Vec<String> =
        serde_json::from_slice(&std::fs::read(thin.join("link-args.json"))?)?;
    let mut objects: Vec<PathBuf> = link_args
        .iter()
        .filter(|a| a.ends_with(".rcgu.o"))
        .map(PathBuf::from)
        .collect();
    objects.sort();
    if objects.is_empty() {
        bail!("no object files found for {}", info.lib_name);
    }

    let arch = if cfg!(target_arch = "aarch64") {
        object::Architecture::Aarch64
    } else {
        object::Architecture::X86_64
    };
    let stub = thin.join("stub.o");
    let stub_object = match patch::create_stub_object(&cache, &objects, arch, slide) {
        Ok(stub) => stub,
        Err(err) => return not_patchable(&format!("creating the stub failed: {err:#}")),
    };
    std::fs::write(&stub, stub_object)?;

    // Link only the crate's code plus the stub; everything else resolves to the
    // running addon (through the stub) or to system libraries.
    let dylib = thin.join(format!("lib{}-patch.dylib", info.lib_name));
    let status = Command::new("cc")
        .args(&objects)
        .arg(&stub)
        .args(kept_link_flags(&fat_link_args))
        .args(["-dynamiclib", "-Wl,-undefined,dynamic_lookup", "-o"])
        .arg(&dylib)
        .current_dir(&invocation.cwd)
        .status()?;
    if !status.success() {
        return not_patchable(
            "linking the patch failed (often a new dependency or generic needs a full rebuild)",
        );
    }

    let table = match patch::create_jump_table(&cache, &dylib, slide) {
        Ok(table) => table,
        Err(err) => return not_patchable(&format!("{err:#}")),
    };
    std::fs::write(out, serde_json::to_vec(&table)?)?;
    eprintln!(
        "electron-gpui-hotpatch: patched {} ({} symbols) in {:.1?}",
        info.lib_name,
        table.map.len(),
        started.elapsed()
    );
    Ok(ExitCode::SUCCESS)
}

/// The recorded rustc invocation reports diagnostics as JSON (as Cargo asked);
/// print errors the way Cargo would. Warnings are skipped: they'd repeat on every
/// patch and already showed in the full build.
fn print_errors(stderr: &[u8]) {
    for line in String::from_utf8_lossy(stderr).lines() {
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(message) if message["$message_type"] == "diagnostic" => {
                if message["level"] == "error"
                    && let Some(rendered) = message["rendered"].as_str()
                {
                    eprint!("{rendered}");
                }
            }
            Ok(_) => {}
            Err(_) => eprintln!("{line}"),
        }
    }
}

fn not_patchable(reason: &str) -> Result<ExitCode> {
    eprintln!("electron-gpui-hotpatch: can't hot-patch: {reason}");
    Ok(ExitCode::from(EXIT_NOT_PATCHABLE))
}

/// Platform and system-library flags from the original link, minus its inputs,
/// output and export list.
fn kept_link_flags(args: &[String]) -> Vec<String> {
    let mut kept = Vec::new();
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-arch" | "-framework" | "-target" | "-L" => {
                kept.push(arg.clone());
                if let Some(value) = iter.next() {
                    kept.push(value.clone());
                }
            }
            "-nodefaultlibs" => kept.push(arg.clone()),
            a if a.starts_with("-l") || a.starts_with("-L") || a.starts_with("-m") => {
                kept.push(arg.clone())
            }
            _ => {}
        }
    }
    kept
}

/// Patch dylibs stay loaded in the running app, so only prune old ones; keep the
/// newest `keep`.
fn remove_old_patches(state: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(state) else {
        return;
    };
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("patch-"))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    let excess = dirs.len().saturating_sub(keep);
    for dir in &dirs[..excess] {
        std::fs::remove_dir_all(dir).ok();
    }
}
