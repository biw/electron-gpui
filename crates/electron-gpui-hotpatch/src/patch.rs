//! Patch-object generation and jump tables for Mach-O, ELF, and Windows COFF/PE.
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
    macho::{
        LC_SEGMENT_64, MH_MAGIC_64, PLATFORM_MACOS, S_INIT_FUNC_OFFSETS, S_MOD_INIT_FUNC_POINTERS,
        S_MOD_TERM_FUNC_POINTERS, S_REGULAR, SECTION_TYPE,
    },
    read::File,
    write::{MachOBuildVersion, StandardSection, Symbol, SymbolSection},
};
use subsecond_types::{AddressMap, JumpTable};

/// Anchor symbol exported by the electron-gpui SDK (prefixed with `_` on Mach-O).
pub const ANCHOR_SYMBOL: &str = "electron_gpui_hot_anchor";

/// Subsecond's runtime looks up `main` in each patch to find where it loaded.
const PATCH_SENTINEL: &str = "main";

pub struct CachedSymbol {
    pub address: u64,
    pub kind: SymbolKind,
    pub is_undefined: bool,
    pub is_weak: bool,
    pub size: u64,
    pub flags: object::SymbolFlags<object::write::SectionId, object::write::SymbolId>,
}

/// The original addon's full symbol table and TLS initializers.
pub struct ModuleCache {
    pub symbols: HashMap<String, CachedSymbol>,
    pub format: BinaryFormat,
    pub architecture: Architecture,
    tls_init_data: Vec<u8>,
    /// `$tlv$init` symbol name -> (offset in `__thread_data`, size).
    tls_init_sizes: HashMap<String, (u64, u64)>,
}

impl ModuleCache {
    pub fn load(original: &Path) -> Result<Self> {
        let bytes =
            std::fs::read(original).with_context(|| format!("reading {}", original.display()))?;
        let obj = File::parse(&*bytes)?;
        let mut symbols = obj
            .symbols()
            .filter_map(|s| {
                Some((
                    s.name().ok()?.to_string(),
                    CachedSymbol {
                        address: s.address(),
                        kind: s.kind(),
                        is_undefined: s.is_undefined(),
                        is_weak: s.is_weak(),
                        size: s.size(),
                        flags: match s.flags() {
                            object::SymbolFlags::Elf { st_info, st_other } => {
                                object::SymbolFlags::Elf { st_info, st_other }
                            }
                            _ => object::SymbolFlags::None,
                        },
                    },
                ))
            })
            .collect();
        if obj.format() == BinaryFormat::Pe {
            symbols = pdb_symbols(&original.with_extension("pdb"))?;
        }

        // Mach-O symbols carry no size, so TLS initializer sizes come from the
        // distance between adjacent symbols in __thread_data.
        let tls = obj
            .sections()
            .find(|s| matches!(s.name(), Ok("__thread_data" | ".tdata" | ".tls")));
        let tls_init_data = tls
            .as_ref()
            .and_then(|s| s.data().ok())
            .unwrap_or(&[])
            .to_vec();
        let (tls_addr, tls_size, tls_index) = tls
            .as_ref()
            .map(|s| {
                (
                    if obj.format() == BinaryFormat::Pe {
                        s.address().wrapping_sub(obj.relative_address_base())
                    } else {
                        s.address()
                    },
                    s.size(),
                    Some(s.index()),
                )
            })
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
        if obj.format() == BinaryFormat::Pe {
            tls_syms = symbols
                .iter()
                .filter(|(_, symbol)| symbol.kind == SymbolKind::Tls)
                .map(|(name, symbol)| (symbol.address.saturating_sub(tls_addr), name.clone()))
                .collect();
        }
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
            format: if obj.format() == BinaryFormat::Pe {
                BinaryFormat::Coff
            } else {
                obj.format()
            },
            architecture: obj.architecture(),
            symbols,
            tls_init_data,
            tls_init_sizes,
        })
    }

    /// Static (link-time) address of the anchor symbol.
    pub fn anchor_address(&self) -> Result<u64> {
        self.symbols
            .get(if self.format == BinaryFormat::MachO { "_electron_gpui_hot_anchor" } else { ANCHOR_SYMBOL })
            .filter(|s| !s.is_undefined)
            .map(|s| s.address)
            .with_context(|| format!("{ANCHOR_SYMBOL} not found in the original addon; was it built with the electron-gpui SDK and without stripping?"))
    }
}

/// Name given to initializer sections disabled by [`disable_initializers`].
const DISABLED_INITIALIZERS: &[u8; 16] = b"__egpui_no_init\0";

/// Turn static initializer and terminator sections into plain data,
/// so the patch library doesn't run them when loaded
/// (or unloaded). Returns how many sections were changed.
pub fn disable_initializers(object: &mut [u8]) -> Result<usize> {
    match File::parse(&*object)?.format() {
        BinaryFormat::Elf => return disable_elf_initializers(object),
        BinaryFormat::Coff => return disable_coff_initializers(object),
        BinaryFormat::MachO => {}
        format => bail!("unsupported patch object format {format:?}"),
    }
    fn read_u32(data: &[u8], at: usize) -> Result<u32> {
        let bytes = data.get(at..at + 4).context("truncated Mach-O object")?;
        Ok(u32::from_le_bytes(bytes.try_into()?))
    }

    if read_u32(object, 0)? != MH_MAGIC_64 {
        bail!("not a 64-bit little-endian Mach-O object");
    }
    // mach_header_64 is 32 bytes; ncmds is its fifth field.
    let ncmds = read_u32(object, 16)?;
    let mut command = 32;
    let mut disabled = 0;
    for _ in 0..ncmds {
        let cmd = read_u32(object, command)?;
        let cmdsize = read_u32(object, command + 4)? as usize;
        if cmd == LC_SEGMENT_64 {
            // segment_command_64 is 72 bytes (nsects at 64), then 80-byte section_64s
            // (sectname first, flags at 64).
            let nsects = read_u32(object, command + 64)? as usize;
            for index in 0..nsects {
                let section = command + 72 + index * 80;
                let flags = read_u32(object, section + 64)?;
                if matches!(
                    flags & SECTION_TYPE,
                    S_MOD_INIT_FUNC_POINTERS | S_MOD_TERM_FUNC_POINTERS | S_INIT_FUNC_OFFSETS
                ) {
                    let regular = (flags & !SECTION_TYPE) | S_REGULAR;
                    object[section + 64..section + 68].copy_from_slice(&regular.to_le_bytes());
                    // The linker also recognizes `__mod_init_func` by name.
                    object[section..section + 16].copy_from_slice(DISABLED_INITIALIZERS);
                    disabled += 1;
                }
            }
        }
        if cmdsize == 0 {
            bail!("malformed Mach-O load command");
        }
        command += cmdsize;
    }
    Ok(disabled)
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

    let mut obj = object::write::Object::new(cache.format, arch, Endianness::Little);
    if cache.format == BinaryFormat::MachO {
        obj.set_macho_build_version({
            let mut version = MachOBuildVersion::default();
            version.platform = PLATFORM_MACOS;
            version.minos = 11 << 16;
            version.sdk = 11 << 16;
            version
        });
    }
    let text = obj.section_id(StandardSection::Text);

    // Subsecond's sentinel: a `ret`, never called.
    let ret: &[u8] = match arch {
        Architecture::Aarch64 => &[0xC0, 0x03, 0x5F, 0xD6],
        _ => &[0xC3],
    };
    let offset = obj.append_section_data(text, ret, 4);
    obj.add_symbol(Symbol {
        name: PATCH_SENTINEL.as_bytes().to_vec(),
        value: offset,
        size: ret.len() as u64,
        kind: SymbolKind::Text,
        scope: SymbolScope::Dynamic,
        weak: false,
        section: SymbolSection::Section(text),
        flags: object::SymbolFlags::None,
    });

    for name in undefined.difference(&defined) {
        if cache.format == BinaryFormat::Coff
            && let Some(imported) = name.strip_prefix("__imp_")
        {
            // MSVC emits indirection through DLL-import slots for cross-crate
            // statics (and sometimes functions), even when the original linked
            // them statically. Provide a pointer to the original definition.
            if let Some(symbol) = cache
                .symbols
                .get(imported)
                .filter(|symbol| !symbol.is_undefined)
            {
                let data = obj.section_id(StandardSection::Data);
                let offset = obj.append_section_data(
                    data,
                    &symbol.address.wrapping_add(slide).to_le_bytes(),
                    8,
                );
                obj.add_symbol(Symbol {
                    name: name.as_bytes().to_vec(),
                    value: offset,
                    size: 8,
                    kind: SymbolKind::Data,
                    scope: SymbolScope::Linkage,
                    weak: false,
                    section: SymbolSection::Section(data),
                    flags: object::SymbolFlags::None,
                });
            }
            // System-library imports resolve through the original link libraries.
            continue;
        }
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
        let stub_name = if cache.format == BinaryFormat::MachO {
            &name.as_bytes()[1..]
        } else {
            name.as_bytes()
        }
        .to_vec();
        let address = sym.address.wrapping_add(slide);
        // Each DLL owns a TLS index. Reusing the addon's index with patch TLS
        // offsets would access unrelated thread-local storage.
        if cache.format == BinaryFormat::Coff
            && matches!(
                name.as_str(),
                "_tls_index" | "_tls_used" | "__tls_index" | "__tls_used"
            )
        {
            continue;
        }

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
                    .or_else(|| {
                        if cache.format == BinaryFormat::Coff {
                            cache.tls_init_sizes.get(name)
                        } else {
                            None
                        }
                    })
                    .copied()
                    .unwrap_or_else(|| {
                        if cache.format == BinaryFormat::Elf {
                            (sym.address, sym.size.max(1))
                        } else {
                            (0, cache.tls_init_data.len() as u64)
                        }
                    });
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
                // COFF absolute symbols carry only 32 bits. External data references
                // have already been bound directly in ADDR64 relocations instead.
                if cache.format == BinaryFormat::Coff {
                    continue;
                }
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
                    flags: match sym.flags {
                        object::SymbolFlags::Elf { st_info, st_other } => {
                            object::SymbolFlags::Elf {
                                // A private symbol in the original must be externally
                                // resolvable from the patch's other object files.
                                st_info: (if sym.is_weak {
                                    object::elf::STB_WEAK
                                } else {
                                    object::elf::STB_GLOBAL
                                } << 4)
                                    | (st_info & 0xf),
                                st_other,
                            }
                        }
                        flags => flags,
                    },
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
            if !name.ends_with(".o") && !name.ends_with(".obj") {
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
    let new_symbols: HashMap<String, u64> = if cache.format == BinaryFormat::Coff {
        pdb_symbols(&patch.with_extension("pdb"))?
            .into_iter()
            .map(|(name, symbol)| (name, symbol.address))
            .collect()
    } else {
        obj.symbol_map()
            .symbols()
            .iter()
            .map(|symbol| (symbol.name().to_owned(), symbol.address()))
            .collect()
    };
    let mut map = AddressMap::default();
    let sentinel = if cache.format == BinaryFormat::MachO {
        "_main"
    } else {
        PATCH_SENTINEL
    };
    let new_base_address = new_symbols.get(sentinel).copied();
    for (name, address) in &new_symbols {
        if let Some(old) = cache
            .symbols
            .get(name)
            .filter(|symbol| !symbol.is_undefined && symbol.kind == SymbolKind::Text)
        {
            map.insert(old.address.wrapping_add(slide), *address);
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

fn pdb_symbols(path: &Path) -> Result<HashMap<String, CachedSymbol>> {
    use pdb::FallibleIterator;
    let mut pdb = pdb::PDB::open(
        std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?,
    )?;
    let addresses = pdb.address_map()?;
    let mut symbols = HashMap::new();
    fn insert(
        symbol: pdb::Symbol<'_>,
        addresses: &pdb::AddressMap<'_>,
        symbols: &mut HashMap<String, CachedSymbol>,
    ) {
        let (name, offset, kind, size) = match symbol.parse() {
            Ok(pdb::SymbolData::Public(data)) => (
                data.name.to_string().into_owned(),
                data.offset,
                if data.function {
                    SymbolKind::Text
                } else {
                    SymbolKind::Data
                },
                0,
            ),
            Ok(pdb::SymbolData::Data(data)) => (
                data.name.to_string().into_owned(),
                data.offset,
                SymbolKind::Data,
                0,
            ),
            Ok(pdb::SymbolData::ThreadStorage(data)) => (
                data.name.to_string().into_owned(),
                data.offset,
                SymbolKind::Tls,
                0,
            ),
            _ => return,
        };
        if let Some(address) = offset.to_rva(addresses) {
            symbols.insert(
                name,
                CachedSymbol {
                    address: address.0 as u64,
                    kind,
                    size,
                    is_undefined: false,
                    is_weak: false,
                    flags: object::SymbolFlags::None,
                },
            );
        }
    }
    let globals = pdb.global_symbols()?;
    let mut iterator = globals.iter();
    while let Some(symbol) = iterator.next()? {
        insert(symbol, &addresses, &mut symbols);
    }
    let debug = pdb.debug_information()?;
    let mut modules = debug.modules()?;
    while let Some(module) = modules.next()? {
        if let Some(info) = pdb.module_info(&module)? {
            let mut iterator = info.symbols()?;
            while let Some(symbol) = iterator.next()? {
                insert(symbol, &addresses, &mut symbols);
            }
        }
    }
    Ok(symbols)
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .context("truncated object")?
            .try_into()?,
    ))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .context("truncated object")?
            .try_into()?,
    ))
}
fn u64_at(bytes: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(
        bytes
            .get(offset..offset + 8)
            .context("truncated object")?
            .try_into()?,
    ))
}

fn disable_elf_initializers(bytes: &mut [u8]) -> Result<usize> {
    if bytes.get(4..6) != Some(&[2, 1]) {
        bail!("expected 64-bit little-endian ELF");
    }
    let headers = u64_at(bytes, 40)? as usize;
    let stride = u16_at(bytes, 58)? as usize;
    let count = u16_at(bytes, 60)? as usize;
    let names_header = headers + u16_at(bytes, 62)? as usize * stride;
    let names = u64_at(bytes, names_header + 24)? as usize;
    let mut disabled = 0;
    for index in 0..count {
        let header = headers + index * stride;
        let start = names + u32_at(bytes, header)? as usize;
        let name = bytes
            .get(start..)
            .context("invalid ELF section name")?
            .split(|byte| *byte == 0)
            .next()
            .unwrap_or_default();
        let replacement: Option<&[u8]> = if name.starts_with(b".init_array") {
            Some(b".egpui_init")
        } else if name.starts_with(b".fini_array") {
            Some(b".egpui_fini")
        } else if name.starts_with(b".ctors") {
            Some(b".egini")
        } else if name.starts_with(b".dtors") {
            Some(b".egfin")
        } else {
            None
        };
        if let Some(replacement) = replacement {
            bytes
                .get_mut(start..start + replacement.len())
                .context("truncated ELF section name")?
                .copy_from_slice(replacement);
            bytes
                .get_mut(header + 4..header + 8)
                .context("truncated ELF section")?
                .copy_from_slice(&object::elf::SHT_PROGBITS.to_le_bytes());
            disabled += 1;
        }
    }
    Ok(disabled)
}

fn coff_headers(bytes: &[u8]) -> Result<(usize, usize)> {
    if u16_at(bytes, 0)? != object::pe::IMAGE_FILE_MACHINE_AMD64 {
        bail!("expected x64 COFF object");
    }
    Ok((20 + u16_at(bytes, 16)? as usize, u16_at(bytes, 2)? as usize))
}

fn disable_coff_initializers(bytes: &mut [u8]) -> Result<usize> {
    let (headers, count) = coff_headers(bytes)?;
    let object = File::parse(&*bytes)?;
    let disabled: Vec<usize> = object
        .sections()
        .enumerate()
        .filter_map(|(index, section)| {
            let name = section.name().ok()?;
            // Preserve .CRT$XL* callbacks: a patch DLL still needs its own TLS plumbing.
            (name.starts_with(".CRT$XC")
                || name.starts_with(".CRT$XP")
                || name.starts_with(".CRT$XT"))
            .then_some(index)
        })
        .collect();
    for index in &disabled {
        if *index >= count {
            bail!("invalid COFF section index");
        }
        let start = headers + index * 40;
        bytes
            .get_mut(start..start + 8)
            .context("truncated COFF section")?
            .copy_from_slice(b".egpui00");
    }
    Ok(disabled.len())
}

/// COFF absolute symbols cannot represent another DLL's 64-bit ASLR address.
/// Bind ADDR64 references in the object itself; the linker must not rebase them.
/// Large-code-model builds use these references instead of out-of-range REL32s.
pub fn bind_external_data(
    cache: &ModuleCache,
    paths: &[impl AsRef<Path>],
    slide: u64,
) -> Result<()> {
    if cache.format != BinaryFormat::Coff {
        return Ok(());
    }
    let mut undefined = HashSet::new();
    let mut defined = HashSet::new();
    for path in paths {
        collect_symbols(path.as_ref(), &mut undefined, &mut defined)?;
    }
    for path in paths {
        let mut bytes = std::fs::read(path.as_ref())?;
        let object = File::parse(&*bytes)?;
        let (headers, count) = coff_headers(&bytes)?;
        let mut bindings = Vec::new();
        for index in 0..count {
            let header = headers + index * 40;
            let data = u32_at(&bytes, header + 20)? as usize;
            let relocations = u32_at(&bytes, header + 24)? as usize;
            let count = u16_at(&bytes, header + 32)? as usize;
            if count == 0xffff {
                bail!("COFF relocation overflow requires a full rebuild");
            }
            for index in 0..count {
                let relocation = relocations + index * 10;
                let kind = u16_at(&bytes, relocation + 8)?;
                if kind == object::pe::IMAGE_REL_AMD64_ABSOLUTE {
                    continue;
                }
                let symbol =
                    object.symbol_by_index(object::SymbolIndex(
                        u32_at(&bytes, relocation + 4)? as usize
                    ))?;
                let name = symbol.name()?;
                if name.starts_with("__imp_")
                    || defined.contains(name)
                    || matches!(
                        name,
                        "_tls_index" | "_tls_used" | "__tls_index" | "__tls_used"
                    )
                {
                    continue;
                }
                let Some(symbol) = cache.symbols.get(name).filter(|symbol| {
                    !symbol.is_undefined
                        && matches!(symbol.kind, SymbolKind::Data | SymbolKind::Unknown)
                }) else {
                    continue;
                };
                if kind != object::pe::IMAGE_REL_AMD64_ADDR64 {
                    bail!(
                        "external data {name} needs an unsupported relocation {kind}; use a large-code-model build"
                    );
                }
                let offset = data + u32_at(&bytes, relocation)? as usize;
                let address = symbol
                    .address
                    .wrapping_add(slide)
                    .wrapping_add(u64_at(&bytes, offset)?);
                bindings.push((relocation, offset, address));
            }
        }
        for (relocation, offset, address) in bindings {
            bytes
                .get_mut(offset..offset + 8)
                .context("truncated COFF data relocation")?
                .copy_from_slice(&address.to_le_bytes());
            bytes
                .get_mut(relocation + 8..relocation + 10)
                .context("truncated COFF relocation")?
                .fill(0);
        }
        std::fs::write(path.as_ref(), bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use object::{
        SectionFlags, SectionKind,
        write::{self, Object as WriteObject},
    };

    use super::*;

    fn object_with_initializer() -> Vec<u8> {
        let mut obj = WriteObject::new(
            BinaryFormat::MachO,
            Architecture::Aarch64,
            Endianness::Little,
        );
        let text = obj.section_id(write::StandardSection::Text);
        obj.append_section_data(text, &[0; 4], 4);
        let init = obj.add_section(
            b"__DATA".to_vec(),
            b"__mod_init_func".to_vec(),
            SectionKind::Data,
        );
        obj.section_mut(init).flags = SectionFlags::MachO {
            flags: S_MOD_INIT_FUNC_POINTERS,
        };
        obj.append_section_data(init, &[0; 8], 8);
        obj.write().unwrap()
    }

    fn section_types(bytes: &[u8]) -> Vec<(String, u32)> {
        File::parse(bytes)
            .unwrap()
            .sections()
            .map(|section| {
                let SectionFlags::MachO { flags } = section.flags() else {
                    panic!("not Mach-O");
                };
                (section.name().unwrap().to_owned(), flags & SECTION_TYPE)
            })
            .collect()
    }

    #[test]
    fn initializer_sections_become_plain_data() {
        let mut bytes = object_with_initializer();
        assert!(
            section_types(&bytes).contains(&("__mod_init_func".into(), S_MOD_INIT_FUNC_POINTERS))
        );

        assert_eq!(disable_initializers(&mut bytes).unwrap(), 1);
        let sections = section_types(&bytes);
        assert!(
            sections.contains(&("__egpui_no_init".into(), S_REGULAR)),
            "{sections:?}"
        );
        assert!(
            sections
                .iter()
                .all(|(_, kind)| *kind != S_MOD_INIT_FUNC_POINTERS)
        );

        // Already disabled: nothing left to change.
        assert_eq!(disable_initializers(&mut bytes).unwrap(), 0);
    }

    #[test]
    fn rejects_other_files() {
        assert!(disable_initializers(&mut [0u8; 8]).is_err());
        assert!(disable_initializers(&mut []).is_err());
    }

    #[test]
    fn elf_initializers_are_disabled_but_tls_is_preserved() {
        let mut object =
            WriteObject::new(BinaryFormat::Elf, Architecture::X86_64, Endianness::Little);
        for name in [".init_array", ".fini_array.100", ".ctors", ".tdata"] {
            let kind = if name.starts_with(".init_array") {
                SectionKind::Elf(object::elf::SHT_INIT_ARRAY)
            } else if name.starts_with(".fini_array") {
                SectionKind::Elf(object::elf::SHT_FINI_ARRAY)
            } else {
                SectionKind::Data
            };
            let section = object.add_section(Vec::new(), name.as_bytes().to_vec(), kind);
            object.append_section_data(section, &[0; 8], 8);
        }
        let mut bytes = object.write().unwrap();
        assert_eq!(disable_initializers(&mut bytes).unwrap(), 3);
        let sections: Vec<_> = File::parse(&*bytes)
            .unwrap()
            .sections()
            .map(|section| section.name().unwrap().to_owned())
            .collect();
        assert!(sections.contains(&".egpui_init".into()));
        assert!(sections.contains(&".egpui_fini.100".into()));
        assert!(sections.contains(&".egini".into()));
        assert!(sections.contains(&".tdata".into()));
        let headers = u64_at(&bytes, 40).unwrap() as usize;
        let stride = u16_at(&bytes, 58).unwrap() as usize;
        for index in 0..u16_at(&bytes, 60).unwrap() as usize {
            let kind = u32_at(&bytes, headers + index * stride + 4).unwrap();
            assert!(!matches!(
                kind,
                object::elf::SHT_INIT_ARRAY | object::elf::SHT_FINI_ARRAY
            ));
        }
        assert_eq!(disable_initializers(&mut bytes).unwrap(), 0);
    }

    #[test]
    fn coff_initializers_are_disabled_but_tls_callbacks_are_preserved() {
        let mut object =
            WriteObject::new(BinaryFormat::Coff, Architecture::X86_64, Endianness::Little);
        for name in [".CRT$XCU", ".CRT$XPU", ".CRT$XTU", ".CRT$XLB"] {
            let section =
                object.add_section(Vec::new(), name.as_bytes().to_vec(), SectionKind::Data);
            object.append_section_data(section, &[0; 8], 8);
        }
        let mut bytes = object.write().unwrap();
        assert_eq!(disable_initializers(&mut bytes).unwrap(), 3);
        let sections: Vec<_> = File::parse(&*bytes)
            .unwrap()
            .sections()
            .map(|section| section.name().unwrap().to_owned())
            .collect();
        assert_eq!(
            sections.iter().filter(|name| *name == ".egpui00").count(),
            3
        );
        assert!(sections.contains(&".CRT$XLB".into()));
        assert_eq!(disable_initializers(&mut bytes).unwrap(), 0);
    }

    #[test]
    fn elf_stub_exposes_private_data_at_its_runtime_address() {
        let mut object =
            WriteObject::new(BinaryFormat::Elf, Architecture::X86_64, Endianness::Little);
        object.add_symbol(Symbol {
            name: b"private_data".to_vec(),
            value: 0,
            size: 0,
            kind: SymbolKind::Data,
            scope: SymbolScope::Linkage,
            weak: false,
            section: SymbolSection::Undefined,
            flags: object::SymbolFlags::None,
        });
        let path = std::env::temp_dir().join(format!("egpui-elf-{}.o", std::process::id()));
        std::fs::write(&path, object.write().unwrap()).unwrap();
        let cache = ModuleCache {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            symbols: HashMap::from([(
                "private_data".into(),
                CachedSymbol {
                    address: 0x1234,
                    size: 8,
                    kind: SymbolKind::Data,
                    is_undefined: false,
                    is_weak: false,
                    flags: object::SymbolFlags::Elf {
                        st_info: object::elf::STT_OBJECT,
                        st_other: 0,
                    },
                },
            )]),
            tls_init_data: Vec::new(),
            tls_init_sizes: HashMap::new(),
        };
        let bytes = create_stub_object(&cache, &[&path], Architecture::X86_64, 0x7ff0_0000_0000);
        std::fs::remove_file(path).unwrap();
        let bytes = bytes.unwrap();
        let parsed = File::parse(&*bytes).unwrap();
        let symbol = parsed.symbol_by_name("private_data").unwrap();
        assert!(symbol.is_global());
        assert_eq!(symbol.address(), 0x7ff0_0000_1234);
        assert!(parsed.symbol_by_name("main").unwrap().is_global());
    }

    #[test]
    fn coff_import_slots_point_to_the_original_definition() {
        let mut object =
            WriteObject::new(BinaryFormat::Coff, Architecture::X86_64, Endianness::Little);
        object.add_symbol(Symbol {
            name: b"__imp_old_global".to_vec(),
            value: 0,
            size: 0,
            kind: SymbolKind::Data,
            scope: SymbolScope::Linkage,
            weak: false,
            section: SymbolSection::Undefined,
            flags: object::SymbolFlags::None,
        });
        let path = std::env::temp_dir().join(format!("egpui-import-{}.obj", std::process::id()));
        std::fs::write(&path, object.write().unwrap()).unwrap();
        let cache = ModuleCache {
            format: BinaryFormat::Coff,
            architecture: Architecture::X86_64,
            symbols: HashMap::from([(
                "old_global".into(),
                CachedSymbol {
                    address: 0x1234,
                    size: 8,
                    kind: SymbolKind::Data,
                    is_undefined: false,
                    is_weak: false,
                    flags: object::SymbolFlags::None,
                },
            )]),
            tls_init_data: Vec::new(),
            tls_init_sizes: HashMap::new(),
        };
        let bytes = create_stub_object(&cache, &[&path], Architecture::X86_64, 0x7ff0_0000_0000);
        std::fs::remove_file(path).unwrap();
        let bytes = bytes.unwrap();
        let parsed = File::parse(&*bytes).unwrap();
        let symbol = parsed.symbol_by_name("__imp_old_global").unwrap();
        let section = parsed
            .section_by_index(symbol.section_index().unwrap())
            .unwrap();
        assert_eq!(
            u64_at(section.data().unwrap(), symbol.address() as usize).unwrap(),
            0x7ff0_0000_1234
        );
        assert!(symbol.is_global());
    }

    #[test]
    fn coff_data_references_keep_the_full_aslr_address() {
        let mut object =
            WriteObject::new(BinaryFormat::Coff, Architecture::X86_64, Endianness::Little);
        let data = object.section_id(StandardSection::Data);
        object.append_section_data(data, &[0; 8], 8);
        let symbol = object.add_symbol(Symbol {
            name: b"old_static".to_vec(),
            value: 0,
            size: 0,
            kind: SymbolKind::Data,
            scope: SymbolScope::Linkage,
            weak: false,
            section: SymbolSection::Undefined,
            flags: object::SymbolFlags::None,
        });
        object
            .add_relocation(
                data,
                write::Relocation {
                    offset: 0,
                    symbol,
                    addend: 17,
                    flags: object::RelocationFlags::Coff {
                        typ: object::pe::IMAGE_REL_AMD64_ADDR64,
                    },
                },
            )
            .unwrap();
        let path = std::env::temp_dir().join(format!("egpui-coff-{}.obj", std::process::id()));
        std::fs::write(&path, object.write().unwrap()).unwrap();
        let cache = ModuleCache {
            format: BinaryFormat::Coff,
            architecture: Architecture::X86_64,
            symbols: HashMap::from([(
                "old_static".into(),
                CachedSymbol {
                    address: 0x1234,
                    size: 0,
                    kind: SymbolKind::Data,
                    is_undefined: false,
                    is_weak: false,
                    flags: object::SymbolFlags::None,
                },
            )]),
            tls_init_data: Vec::new(),
            tls_init_sizes: HashMap::new(),
        };
        let result = bind_external_data(&cache, &[&path], 0x7ff0_0000_0000);
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        result.unwrap();
        let parsed = File::parse(&*bytes).unwrap();
        let section = parsed.section_by_name(".data").unwrap();
        assert_eq!(
            u64_at(section.data().unwrap(), 0).unwrap(),
            0x7ff0_0000_1245
        );
        assert!(
            section
                .relocations()
                .all(|(_, relocation)| relocation.flags()
                    == object::RelocationFlags::Coff { typ: 0 })
        );
    }
}
