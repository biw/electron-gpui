use anyhow::{Context, Result, bail};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn linker() -> Result<Command> {
    #[cfg(target_os = "windows")]
    {
        let tool = cc::windows_registry::find_tool("x86_64-pc-windows-msvc", "link.exe")
            .context("MSVC Build Tools and the Windows SDK are required")?;
        Ok(tool.to_command())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Command::new(
            std::env::var_os("CC").unwrap_or_else(|| "cc".into()),
        ))
    }
}

pub fn library_name(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.dll")
    } else if cfg!(target_os = "linux") {
        format!("lib{name}.so")
    } else {
        format!("lib{name}.dylib")
    }
}

pub fn cargo_artifact(messages: &[u8], name: &str) -> Result<PathBuf> {
    for line in String::from_utf8_lossy(messages)
        .lines()
        .filter(|line| line.starts_with('{'))
    {
        let message: serde_json::Value = serde_json::from_str(line)?;
        if message["reason"] != "compiler-artifact" || message["target"]["name"] != name {
            continue;
        }
        if let Some(files) = message["filenames"].as_array() {
            for file in files.iter().filter_map(|file| file.as_str()) {
                if matches!(
                    Path::new(file)
                        .extension()
                        .and_then(|extension| extension.to_str()),
                    Some("dylib" | "dll" | "so")
                ) {
                    return Ok(file.into());
                }
            }
        }
    }
    bail!("Cargo did not report a native artifact for {name}")
}

pub fn fat_flags() -> Vec<&'static str> {
    let mut flags = Vec::new();
    if cfg!(all(
        target_arch = "x86_64",
        any(target_os = "windows", target_os = "linux")
    )) {
        flags.push("-Ccode-model=large");
    }
    if cfg!(target_os = "windows") {
        flags.extend([
            "-Cdebuginfo=2",
            "-Clink-arg=/DEBUG:FULL",
            "-Clink-arg=/OPT:NOICF",
        ]);
    }
    flags
}

pub fn link_output(args: &[String]) -> Option<&str> {
    args.windows(2)
        .find(|pair| pair[0] == "-o")
        .map(|pair| pair[1].as_str())
        .or_else(|| {
            args.iter().find_map(|arg| {
                arg.get(..5)
                    .filter(|prefix| prefix.eq_ignore_ascii_case("/OUT:"))
                    .map(|_| &arg[5..])
            })
        })
}

pub fn patch_flags(output: &Path) -> Vec<String> {
    if cfg!(target_os = "windows") {
        vec![
            "/DLL".into(),
            "/DEBUG:FULL".into(),
            "/EXPORT:main".into(),
            "/OPT:NOICF".into(),
            format!("/PDB:{}", output.with_extension("pdb").display()),
            format!("/OUT:{}", output.display()),
        ]
    } else if cfg!(target_os = "linux") {
        vec![
            "-shared".into(),
            "-Wl,-Bsymbolic".into(),
            "-Wl,-z,notext".into(),
            "-Wl,-z,nodelete".into(),
            "-o".into(),
            output.display().to_string(),
        ]
    } else {
        vec![
            "-dynamiclib".into(),
            "-Wl,-undefined,dynamic_lookup".into(),
            "-o".into(),
            output.display().to_string(),
        ]
    }
}

/// MSVC's command-line limit is smaller than a typical Rust link invocation.
pub fn patch_linker(args: &[String], output: &Path) -> Result<Command> {
    let mut command = linker()?;
    if cfg!(target_os = "windows") {
        let response = output.with_extension("rsp");
        let text = args
            .iter()
            .map(|arg| quote_windows_argument(arg))
            .collect::<Vec<_>>()
            .join("\n");
        let bytes: Vec<u8> = std::iter::once(0xfeff)
            .chain(text.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect();
        std::fs::write(&response, bytes)?;
        command.arg(format!("@{}", response.display()));
    } else {
        command.args(args);
    }
    Ok(command)
}

fn quote_windows_argument(argument: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        quoted.extend(std::iter::repeat_n(
            '\\',
            slashes * if character == '"' { 2 } else { 1 },
        ));
        slashes = 0;
        if character == '"' {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.extend(std::iter::repeat_n('\\', slashes * 2));
    quoted.push('"');
    quoted
}

pub fn kept_link_flags(args: &[String]) -> Vec<String> {
    let mut kept = Vec::new();
    let mut iterator = args.iter();
    while let Some(arg) = iterator.next() {
        match arg.as_str() {
            "-arch" | "-framework" | "-target" | "-L" | "-isysroot" => {
                kept.push(arg.clone());
                if let Some(value) = iterator.next() {
                    kept.push(value.clone());
                }
            }
            "-nodefaultlibs" | "-pthread" => kept.push(arg.clone()),
            arg if arg.starts_with("-l")
                || arg.starts_with("-L")
                || arg.starts_with("-m")
                || arg.starts_with("-Wl,-z,") =>
            {
                kept.push(arg.into())
            }
            arg if cfg!(target_os = "windows")
                && (arg.to_ascii_uppercase().starts_with("/LIBPATH:")
                    || arg.to_ascii_uppercase().starts_with("/DEFAULTLIB:")
                    || arg.to_ascii_lowercase().ends_with(".lib")) =>
            {
                kept.push(arg.into())
            }
            _ => {}
        }
    }
    kept
}

pub fn expand_response_files(args: &[String]) -> Result<Vec<String>> {
    let mut expanded = Vec::new();
    for arg in args {
        if let Some(file) = arg.strip_prefix('@') {
            let bytes = std::fs::read(file)?;
            let text = if bytes.starts_with(&[0xff, 0xfe]) {
                if bytes.len() % 2 != 0 {
                    bail!("truncated UTF-16 linker response file");
                }
                String::from_utf16(
                    &bytes[2..]
                        .chunks_exact(2)
                        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
                        .collect::<Vec<_>>(),
                )?
            } else {
                String::from_utf8(bytes)?
            };
            let args = if cfg!(target_os = "windows") {
                windows_arguments(&text)?
            } else {
                shell_words::split(&text)?
            };
            expanded.extend(expand_response_files(&args)?);
        } else {
            expanded.push(arg.clone());
        }
    }
    Ok(expanded)
}

fn windows_arguments(text: &str) -> Result<Vec<String>> {
    let mut arguments = Vec::new();
    let mut characters = text.chars().peekable();
    while characters.peek().is_some() {
        while characters
            .peek()
            .is_some_and(|character| character.is_whitespace())
        {
            characters.next();
        }
        if characters.peek().is_none() {
            break;
        }
        let mut argument = String::new();
        let mut quoted = false;
        while let Some(&character) = characters.peek() {
            if character.is_whitespace() && !quoted {
                break;
            }
            if character == '\\' {
                let mut count = 0;
                while characters.peek() == Some(&'\\') {
                    characters.next();
                    count += 1;
                }
                if characters.peek() == Some(&'"') {
                    argument.extend(std::iter::repeat_n('\\', count / 2));
                    characters.next();
                    if count % 2 == 1 {
                        argument.push('"');
                    } else {
                        quoted = !quoted;
                    }
                } else {
                    argument.extend(std::iter::repeat_n('\\', count));
                }
            } else if character == '"' {
                characters.next();
                quoted = !quoted;
            } else {
                argument.push(character);
                characters.next();
            }
        }
        if quoted {
            bail!("unclosed quote in MSVC response file");
        }
        arguments.push(argument);
    }
    Ok(arguments)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_quotes_preserve_paths() {
        assert_eq!(
            windows_arguments(r#"/DLL "/OUT:C:\My App\addon.dll" "C:\My App\tip.rcgu.o""#).unwrap(),
            ["/DLL", r"/OUT:C:\My App\addon.dll", r"C:\My App\tip.rcgu.o"]
        );
        for argument in [r"C:\My App\", "contains \"quotes\"", "", "/DLL"] {
            assert_eq!(
                windows_arguments(&quote_windows_argument(argument)).unwrap(),
                [argument]
            );
        }
    }
    #[test]
    fn finds_native_artifacts_without_guessing_directories() {
        let messages = br#"{"reason":"compiler-artifact","target":{"name":"views"},"filenames":["C:\\target space\\views.pdb","C:\\target space\\views.dll"]}"#;
        assert_eq!(
            cargo_artifact(messages, "views").unwrap(),
            PathBuf::from(r"C:\target space\views.dll")
        );
        assert!(cargo_artifact(messages, "other").is_err());
    }
    #[test]
    fn handles_both_linker_output_conventions() {
        assert_eq!(
            link_output(&["/OUT:C:\\My App\\addon.dll".into()]),
            Some(r"C:\My App\addon.dll")
        );
        assert_eq!(
            link_output(&["-o".into(), "addon.so".into()]),
            Some("addon.so")
        );
    }
}
