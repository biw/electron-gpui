//! Patch-object generation and jump tables, for Mach-O (macOS arm64/x86_64).
//!
//! Adapted from the Dioxus CLI's hot-patching engine
//! (`packages/cli/src/build/patch.rs`, https://github.com/DioxusLabs/dioxus),
//! MIT OR Apache-2.0 (used here under MIT), Copyright Dioxus Labs. Changes: the original module is a
//! dylib (a Node addon) loaded into another process, so addresses are anchored to
//! an exported `electron_gpui_hot_anchor` symbol instead of the executable's
//! `main`, and jump-table keys are emitted as absolute runtime addresses.

use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::Path,
};

use anyhow::{Context, Result, bail};
use object::{
    Architecture, BinaryFormat, Endianness, Object, ObjectSection, ObjectSymbol, SymbolKind,
    SymbolScope,
    macho::PLATFORM_MACOS,
    read::File,
    write::{MachOBuildVersion, StandardSection, Symbol, SymbolSection},
};
use subsecond_types::{AddressMap, JumpTable};

/// Mach-O name of the anchor symbol exported by the electron-gpui SDK.
pub const ANCHOR_SYMBOL: &str = "_electron_gpui_hot_anchor";

/// Subsecond's runtime looks up `main` in each patch to find where it loaded.
const PATCH_SENTINEL: &str = "_main";

pub struct CachedSymbol {
    pub address: u64,
    pub kind: SymbolKind,
    pub is_undefined: bool,
    pub is_weak: bool,
}

/// The original addon's full symbol table and TLS initializers.
pub struct ModuleCache {
    pub symbols: HashMap<String, CachedSymbol>,
    tls_init_data: Vec<u8>,
    /// `$tlv$init` symbol name -> (offset in `__thread_data`, size).
    tls_init_sizes: HashMap<String, (u64, u64)>,
}

impl ModuleCache {
    pub fn load(original: &Path) -> Result<Self> {
        let bytes =
            std::fs::read(original).with_context(|| format!("reading {}", original.display()))?;
        let obj = File::parse(&*bytes)?;
        let symbols = obj
            .symbols()
            .filter_map(|s| {
                Some((
                    s.name().ok()?.to_string(),
                    CachedSymbol {
                        address: s.address(),
                        kind: s.kind(),
                        is_undefined: s.is_undefined(),
                        is_weak: s.is_weak(),
                    },
                ))
            })
            .collect();

        // Mach-O symbols carry no size, so TLS initializer sizes come from the
        // distance between adjacent symbols in __thread_data.
        let tls = obj.sections().find(|s| s.name() == Ok("__thread_data"));
        let tls_init_data = tls
            .as_ref()
            .and_then(|s| s.data().ok())
            .unwrap_or(&[])
            .to_vec();
        let (tls_addr, tls_size, tls_index) = tls
            .as_ref()
            .map(|s| (s.address(), s.size(), Some(s.index())))
            .unwrap_or((0, 0, None));
        let mut tls_syms: Vec<(u64, String)> = obj
            .symbols()
            .filter(|s| tls_index.is_some() && s.section_index() == tls_index)
            .filter_map(|s| {
                Some((
                    s.address().saturating_sub(tls_addr),
                    s.name().ok()?.to_string(),
                ))
            })
            .collect();
        tls_syms.sort_by_key(|(offset, _)| *offset);
        tls_syms.dedup_by_key(|(offset, _)| *offset);
        let tls_init_sizes = tls_syms
            .iter()
            .enumerate()
            .map(|(i, (offset, name))| {
                let end = tls_syms.get(i + 1).map_or(tls_size, |(next, _)| *next);
                (name.clone(), (*offset, end - offset))
            })
            .collect();

        Ok(Self {
            symbols,
            tls_init_data,
            tls_init_sizes,
        })
    }

    /// Static (link-time) address of the anchor symbol.
    pub fn anchor_address(&self) -> Result<u64> {
        self.symbols
            .get(ANCHOR_SYMBOL)
            .filter(|s| !s.is_undefined)
            .map(|s| s.address)
            .with_context(|| format!("{ANCHOR_SYMBOL} not found in the original addon; was it built with the electron-gpui SDK and without stripping?"))
    }
}

/// Build an object file that defines every symbol the patch objects use but
/// don't define, pointing at the original addon's copy in the running process
/// (`slide` = runtime address - static address). Also defines `_main`, which
/// Subsecond uses to locate the patch once loaded.
pub fn create_stub_object(
    cache: &ModuleCache,
    patch_objects: &[impl AsRef<Path>],
    arch: Architecture,
    slide: u64,
) -> Result<Vec<u8>> {
    let mut undefined = HashSet::new();
    let mut defined = HashSet::new();
    for path in patch_objects {
        collect_symbols(path.as_ref(), &mut undefined, &mut defined)?;
    }

    let mut obj = object::write::Object::new(BinaryFormat::MachO, arch, Endianness::Little);
    obj.set_macho_build_version({
        let mut version = MachOBuildVersion::default();
        version.platform = PLATFORM_MACOS;
        version.minos = 11 << 16;
        version.sdk = 11 << 16;
        version
    });
    let text = obj.section_id(StandardSection::Text);

    // Subsecond's sentinel: a `ret`, never called.
    let ret: &[u8] = match arch {
        Architecture::Aarch64 => &[0xC0, 0x03, 0x5F, 0xD6],
        _ => &[0xC3],
    };
    let offset = obj.append_section_data(text, ret, 4);
    obj.add_symbol(Symbol {
        name: PATCH_SENTINEL.as_bytes()[1..].to_vec(),
        value: offset,
        size: ret.len() as u64,
        kind: SymbolKind::Text,
        scope: SymbolScope::Dynamic,
        weak: false,
        section: SymbolSection::Section(text),
        flags: object::SymbolFlags::None,
    });

    for name in undefined.difference(&defined) {
        let Some(sym) = cache.symbols.get(name) else {
            // Not in the original either (e.g. a libSystem import or a brand-new
            // generic instantiation from a dependency); left to the linker.
            continue;
        };
        // Imports into the original (libSystem, napi_*) resolve through the
        // patch's own dynamic linking instead.
        if sym.is_undefined {
            continue;
        }
        // The object writer adds Mach-O's leading underscore back.
        let stub_name = name.as_bytes()[1..].to_vec();
        let address = sym.address.wrapping_add(slide);

        match sym.kind {
            SymbolKind::Text => {
                // Trampoline to the original function.
                let mut code = match arch {
                    // ldr x16, #8 ; br x16
                    Architecture::Aarch64 => vec![0x50, 0x00, 0x00, 0x58, 0x00, 0x02, 0x1F, 0xD6],
                    // jmp [rip+0]
                    _ => vec![0xFF, 0x25, 0x00, 0x00, 0x00, 0x00],
                };
                code.extend_from_slice(&address.to_le_bytes());
                let offset = obj.append_section_data(text, &code, 8);
                obj.add_symbol(Symbol {
                    name: stub_name,
                    value: offset,
                    size: code.len() as u64,
                    kind: SymbolKind::Text,
                    scope: SymbolScope::Linkage,
                    weak: false,
                    section: SymbolSection::Section(text),
                    flags: object::SymbolFlags::None,
                });
            }
            SymbolKind::Tls => {
                // Each patch gets its own copy of the thread-local, initialized from
                // the original's init image (so it resets on patch, as in Dioxus).
                let tls = obj.section_id(StandardSection::Tls);
                let (start, size) = cache
                    .tls_init_sizes
                    .get(&format!("{name}$tlv$init"))
                    .copied()
                    .unwrap_or((0, cache.tls_init_data.len() as u64));
                let end = (start + size) as usize;
                let init = if end <= cache.tls_init_data.len() {
                    cache.tls_init_data[start as usize..end].to_vec()
                } else {
                    vec![0; size as usize]
                };
                let id = obj.add_symbol(Symbol {
                    name: stub_name,
                    value: 0,
                    size: 0,
                    kind: SymbolKind::Tls,
                    scope: SymbolScope::Linkage,
                    weak: false,
                    section: SymbolSection::Undefined,
                    flags: object::SymbolFlags::None,
                });
                obj.add_symbol_data(id, tls, &init, size.min(8).next_power_of_two());
            }
            kind => {
                // Statics and other data: an absolute symbol at the original's copy.
                obj.add_symbol(Symbol {
                    name: stub_name,
                    value: address,
                    size: 0,
                    kind: if kind == SymbolKind::Unknown {
                        SymbolKind::Data
                    } else {
                        kind
                    },
                    scope: SymbolScope::Linkage,
                    weak: sym.is_weak,
                    section: SymbolSection::Absolute,
                    flags: object::SymbolFlags::None,
                });
            }
        }
    }

    Ok(obj.write()?)
}

fn collect_symbols(
    path: &Path,
    undefined: &mut HashSet<String>,
    defined: &mut HashSet<String>,
) -> Result<()> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("rlib" | "a")
    ) {
        let mut archive = ar::Archive::new(std::io::Cursor::new(bytes));
        while let Some(entry) = archive.next_entry() {
            let mut entry = entry?;
            let name = String::from_utf8_lossy(entry.header().identifier()).to_string();
            if !name.ends_with(".o") {
                continue;
            }
            let mut member = Vec::new();
            entry.read_to_end(&mut member)?;
            collect_symbols_from_bytes(&member, undefined, defined)?;
        }
        return Ok(());
    }
    collect_symbols_from_bytes(&bytes, undefined, defined)
}

fn collect_symbols_from_bytes(
    bytes: &[u8],
    undefined: &mut HashSet<String>,
    defined: &mut HashSet<String>,
) -> Result<()> {
    for symbol in File::parse(bytes)?.symbols() {
        if symbol.is_undefined() {
            undefined.insert(symbol.name()?.to_string());
        } else if symbol.is_global() {
            defined.insert(symbol.name()?.to_string());
        }
    }
    Ok(())
}

/// Map every function/data symbol present in both the original addon and the
/// patch from its runtime address in the original to its static address in the
/// patch. Subsecond adds the patch's load address at apply time.
pub fn create_jump_table(cache: &ModuleCache, patch: &Path, slide: u64) -> Result<JumpTable> {
    let bytes = std::fs::read(patch)?;
    let obj = File::parse(&*bytes)?;
    let new_symbols = obj.symbol_map();

    let mut map = AddressMap::default();
    let mut new_base_address = None;
    for symbol in new_symbols.symbols() {
        if symbol.name() == PATCH_SENTINEL {
            new_base_address = Some(symbol.address());
        }
        if let Some(old) = cache.symbols.get(symbol.name()).filter(|s| !s.is_undefined) {
            map.insert(old.address.wrapping_add(slide), symbol.address());
        }
    }
    let Some(new_base_address) = new_base_address else {
        bail!("the patch has no {PATCH_SENTINEL} symbol");
    };

    Ok(JumpTable {
        lib: patch.to_path_buf(),
        map,
        // Replaced at runtime with Subsecond's own reference: the keys above are
        // already absolute.
        aslr_reference: 0,
        new_base_address,
        ifunc_count: 0,
    })
}
