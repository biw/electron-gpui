//! GNU/Linux x64 ELF import repair for hosts exporting private Wayland symbols.
//!
//! Keep the host's allocator and every other import intact. Only graphics
//! libraries and their dependencies, system Wayland, and this addon receive
//! system Wayland bindings.
//! Electron's own libraries continue to use its private implementation.

use std::collections::{HashMap, HashSet};
use std::ffi::CStr;
use std::sync::atomic::{AtomicUsize, Ordering};

#[repr(C)]
struct Dynamic {
    tag: i64,
    value: usize,
}

#[repr(C)]
struct Relocation {
    offset: usize,
    info: u64,
    addend: isize,
}

// The first field of glibc's public link_map is the ELF load bias. Handles
// opened by prepare remain loaded, keeping this link map and its DSOs alive.
pub(super) fn library_base(handle: *mut libc::c_void) -> Result<usize, String> {
    let mut link_map: *mut libc::c_void = std::ptr::null_mut();
    if unsafe {
        libc::dlinfo(
            handle,
            libc::RTLD_DI_LINKMAP,
            (&mut link_map as *mut *mut libc::c_void).cast(),
        )
    } != 0
        || link_map.is_null()
    {
        return Err("locating a graphics library's ELF load bias".into());
    }
    Ok(unsafe { *link_map.cast::<usize>() })
}

struct Object {
    base: usize,
    names: Vec<Vec<u8>>,
    needed: Vec<Vec<u8>>,
}

fn dependencies(roots: &HashSet<usize>, objects: &[Object]) -> HashSet<usize> {
    let mut by_name = HashMap::new();
    let by_base: HashMap<_, _> = objects.iter().map(|object| (object.base, object)).collect();
    for object in objects {
        for name in &object.names {
            by_name.entry(name.as_slice()).or_insert(object.base);
        }
    }
    let mut selected = roots.clone();
    let mut pending: Vec<_> = roots.iter().copied().collect();
    while let Some(base) = pending.pop() {
        if let Some(object) = by_base.get(&base) {
            for name in &object.needed {
                if let Some(base) = by_name.get(name.as_slice())
                    && selected.insert(*base)
                {
                    pending.push(*base);
                }
            }
        }
    }
    selected
}

fn loaded_objects() -> Vec<Object> {
    unsafe extern "C" fn visit(
        info: *mut libc::dl_phdr_info,
        _: usize,
        data: *mut libc::c_void,
    ) -> libc::c_int {
        // Copy metadata under dl_iterate_phdr's loader lock: unrelated host
        // libraries may be loaded or unloaded concurrently with preparation.
        let objects = unsafe { &mut *data.cast::<Vec<Object>>() };
        let info = unsafe { &*info };
        let name = unsafe { CStr::from_ptr(info.dlpi_name) }.to_bytes();
        let headers =
            unsafe { std::slice::from_raw_parts(info.dlpi_phdr, usize::from(info.dlpi_phnum)) };
        if let Ok(mut object) = object_metadata(info.dlpi_addr as usize, headers) {
            object.names.push(name.to_owned());
            object.names.push(
                name.rsplit(|byte| *byte == b'/')
                    .next()
                    .unwrap_or(name)
                    .to_owned(),
            );
            objects.push(object);
        }
        0
    }
    let mut objects = Vec::new();
    unsafe { libc::dl_iterate_phdr(Some(visit), (&mut objects as *mut Vec<Object>).cast()) };
    objects
}

fn object_metadata(base: usize, headers: &[libc::Elf64_Phdr]) -> Result<Object, String> {
    let mut object = Object {
        base,
        names: Vec::new(),
        needed: Vec::new(),
    };
    let Some(dynamic) = headers
        .iter()
        .find(|header| header.p_type == libc::PT_DYNAMIC)
    else {
        return Ok(object);
    };
    let address = base + dynamic.p_vaddr as usize;
    let size = dynamic.p_memsz as usize;
    if !mapped(base, headers, address, size) {
        return Err("dynamic table is outside loaded segments".into());
    }
    let table = unsafe {
        std::slice::from_raw_parts(address as *const Dynamic, size / size_of::<Dynamic>())
    };
    let value = |tag| {
        table
            .iter()
            .take_while(|entry| entry.tag != 0)
            .find(|entry| entry.tag == tag)
            .map_or(0, |entry| entry.value)
    };
    let strings = value(5); // DT_STRTAB
    let size = value(10); // DT_STRSZ
    if strings == 0 || size == 0 {
        return Ok(object);
    }
    if !mapped(base, headers, strings, size) {
        return Err("string table is outside loaded segments".into());
    }
    let strings = unsafe { std::slice::from_raw_parts(strings as *const u8, size) };
    for entry in table.iter().take_while(|entry| entry.tag != 0) {
        if !matches!(entry.tag, 1 | 14) {
            continue;
        } // DT_NEEDED, DT_SONAME
        let name = strings
            .get(entry.value..)
            .ok_or("dependency name is outside string table")?;
        let end = name
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("unterminated dependency name")?;
        if entry.tag == 1 {
            object.needed.push(name[..end].to_owned());
        } else {
            object.names.push(name[..end].to_owned());
        }
    }
    Ok(object)
}

fn mapped(base: usize, headers: &[libc::Elf64_Phdr], address: usize, size: usize) -> bool {
    headers.iter().any(|header| {
        header.p_type == libc::PT_LOAD
            && address >= base + header.p_vaddr as usize
            && address
                .checked_add(size)
                .is_some_and(|end| end <= base + header.p_vaddr as usize + header.p_memsz as usize)
    })
}

pub(super) fn redirect(
    roots: &HashSet<usize>,
    client: *mut libc::c_void,
    cursor: *mut libc::c_void,
    addon_function: *const (),
) -> Result<(), String> {
    let mut owner = std::mem::MaybeUninit::<libc::Dl_info>::uninit();
    if unsafe { libc::dladdr(addon_function.cast(), owner.as_mut_ptr()) } == 0 {
        return Err("locating the GPUI addon for Wayland symbol binding".into());
    }
    let addon_base = unsafe { owner.assume_init() }.dli_fbase as usize;
    let mut selected = dependencies(roots, &loaded_objects());
    selected.insert(addon_base);
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 || !(page_size as usize).is_power_of_two() {
        return Err("invalid system page size for Wayland symbol binding".into());
    }
    struct State<'a> {
        selected: &'a HashSet<usize>,
        client: *mut libc::c_void,
        cursor: *mut libc::c_void,
        page_size: usize,
        error: Option<String>,
    }
    unsafe extern "C" fn visit(
        info: *mut libc::dl_phdr_info,
        _: usize,
        data: *mut libc::c_void,
    ) -> libc::c_int {
        let state = unsafe { &mut *data.cast::<State<'_>>() };
        let info = unsafe { &*info };
        let name = unsafe { CStr::from_ptr(info.dlpi_name) }.to_bytes();
        let base = info.dlpi_addr as usize;
        if state.selected.contains(&base) {
            let headers =
                unsafe { std::slice::from_raw_parts(info.dlpi_phdr, usize::from(info.dlpi_phnum)) };
            if let Err(error) = repair(base, headers, state.client, state.cursor, state.page_size) {
                state.error = Some(format!("{}: {error}", String::from_utf8_lossy(name)));
                return 1;
            }
        }
        0
    }
    let mut state = State {
        selected: &selected,
        client,
        cursor,
        page_size: page_size as usize,
        error: None,
    };
    unsafe { libc::dl_iterate_phdr(Some(visit), (&mut state as *mut State<'_>).cast()) };
    state.error.map_or(Ok(()), Err)
}

fn repair(
    base: usize,
    headers: &[libc::Elf64_Phdr],
    client: *mut libc::c_void,
    cursor: *mut libc::c_void,
    page_size: usize,
) -> Result<(), String> {
    let mapped = |address, size| mapped(base, headers, address, size);
    let Some(dynamic) = headers
        .iter()
        .find(|header| header.p_type == libc::PT_DYNAMIC)
    else {
        return Ok(());
    };
    let address = base + dynamic.p_vaddr as usize;
    let size = dynamic.p_memsz as usize;
    if !mapped(address, size) {
        return Err("dynamic table is outside loaded segments".into());
    }
    // The GNU loader has already relocated pointer-valued dynamic entries.
    let table = unsafe {
        std::slice::from_raw_parts(address as *const Dynamic, size / size_of::<Dynamic>())
    };
    let value = |tag| {
        table
            .iter()
            .take_while(|entry| entry.tag != 0)
            .find(|entry| entry.tag == tag)
            .map_or(0, |entry| entry.value)
    };
    let strings = value(5); // DT_STRTAB
    let string_size = value(10); // DT_STRSZ
    let symbols = value(6); // DT_SYMTAB
    if strings == 0 || symbols == 0 {
        return Ok(());
    }
    if !mapped(strings, string_size) {
        return Err("string table is outside loaded segments".into());
    }
    let strings = unsafe { std::slice::from_raw_parts(strings as *const u8, string_size) };
    let mut tables = vec![(value(7), value(8))]; // DT_RELA, DT_RELASZ
    if value(20) == 7 {
        tables.push((value(23), value(2))); // DT_JMPREL, DT_PLTRELSZ
    }
    for (address, size) in tables {
        if address == 0 || size == 0 {
            continue;
        }
        if !mapped(address, size) || !size.is_multiple_of(size_of::<Relocation>()) {
            return Err("relocation table is outside loaded segments".into());
        }
        let relocations = unsafe {
            std::slice::from_raw_parts(address as *const Relocation, size / size_of::<Relocation>())
        };
        for relocation in relocations {
            // R_X86_64_64, GLOB_DAT and JUMP_SLOT are pointer-sized imports.
            if !matches!(relocation.info as u32, 1 | 6 | 7) {
                continue;
            }
            let symbol = symbols
                .checked_add((relocation.info >> 32) as usize * size_of::<libc::Elf64_Sym>())
                .filter(|address| mapped(*address, size_of::<libc::Elf64_Sym>()))
                .ok_or("symbol is outside loaded segments")?;
            let symbol = unsafe { &*(symbol as *const libc::Elf64_Sym) };
            let Some(name) = strings.get(symbol.st_name as usize..) else {
                return Err("symbol name is outside string table".into());
            };
            let Some(end) = name.iter().position(|byte| *byte == 0) else {
                return Err("unterminated symbol name".into());
            };
            if !name[..end].starts_with(b"wl_") {
                continue;
            }
            let name =
                CStr::from_bytes_with_nul(&name[..=end]).map_err(|error| error.to_string())?;
            let mut replacement = unsafe { libc::dlsym(client, name.as_ptr()) };
            if replacement.is_null() {
                replacement = unsafe { libc::dlsym(cursor, name.as_ptr()) };
            }
            unsafe { libc::dlerror() };
            if replacement.is_null() {
                continue; // Project-defined protocol interfaces are not system symbols.
            }
            let target = base + relocation.offset;
            if !mapped(target, size_of::<usize>())
                || !target.is_multiple_of(align_of::<AtomicUsize>())
            {
                return Err("Wayland import is outside loaded segments or unaligned".into());
            }
            let replacement = (replacement as usize).wrapping_add_signed(relocation.addend);
            let slot = unsafe { &*(target as *const AtomicUsize) };
            if slot.load(Ordering::Acquire) == replacement {
                continue;
            }
            let page = target & !(page_size - 1);
            let readonly = headers.iter().any(|header| {
                header.p_type == libc::PT_GNU_RELRO
                    && page >= (base + header.p_vaddr as usize) & !(page_size - 1)
                    && page
                        < (base + header.p_vaddr as usize + header.p_memsz as usize)
                            & !(page_size - 1)
            });
            if !readonly
                && !headers.iter().any(|header| {
                    header.p_type == libc::PT_LOAD
                        && header.p_flags & libc::PF_W != 0
                        && target >= base + header.p_vaddr as usize
                        && target + size_of::<usize>()
                            <= base + header.p_vaddr as usize + header.p_memsz as usize
                })
            {
                return Err("Wayland import is not in writable data or RELRO".into());
            }
            // Imports live in writable data or RELRO, never executable code.
            if readonly
                && unsafe {
                    libc::mprotect(
                        page as *mut _,
                        page_size,
                        libc::PROT_READ | libc::PROT_WRITE,
                    )
                } != 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            slot.store(replacement, Ordering::Release);
            if readonly
                && unsafe { libc::mprotect(page as *mut _, page_size, libc::PROT_READ) } != 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_graphics_dependencies_without_touching_unrelated_host_objects() {
        let object = |base, names: &[&str], needed: &[&str]| Object {
            base,
            names: names
                .iter()
                .map(|name| name.as_bytes().to_owned())
                .collect(),
            needed: needed
                .iter()
                .map(|name| name.as_bytes().to_owned())
                .collect(),
        };
        let objects = [
            object(1, &["libdriver.so"], &["libshared.so", "libmissing.so"]),
            // Already-loaded dependencies must still receive compatible imports.
            object(
                2,
                &["libshared.so", "/usr/lib/libshared.so"],
                &["libwayland-client.so.0"],
            ),
            object(3, &["libwayland-client.so.0"], &["libshared.so"]),
            // A host module loaded concurrently is not a graphics dependency.
            object(4, &["libelectron-host.so"], &["libwayland-client.so.0"]),
        ];
        assert_eq!(
            dependencies(&HashSet::from([1]), &objects),
            HashSet::from([1, 2, 3])
        );
    }

    #[test]
    fn reads_dependency_metadata_from_a_retained_system_library() {
        let client = unsafe { libc::dlopen(c"libwayland-client.so.0".as_ptr(), libc::RTLD_NOW) };
        assert!(!client.is_null());
        let base = library_base(client).expect("system Wayland load bias");
        let objects = loaded_objects();
        let object = objects
            .iter()
            .find(|object| object.base == base)
            .expect("loaded Wayland object");
        assert!(
            object
                .names
                .iter()
                .any(|name| name == b"libwayland-client.so.0")
        );
        assert!(!object.needed.is_empty());
        assert!(dependencies(&HashSet::from([base]), &objects).len() > 1);
        assert_eq!(unsafe { libc::dlclose(client) }, 0);
    }

    struct Fixture {
        address: usize,
        size: usize,
        headers: Vec<libc::Elf64_Phdr>,
    }

    impl Fixture {
        fn new() -> Self {
            let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as usize;
            let address = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    size,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                    -1,
                    0,
                )
            };
            assert_ne!(address, libc::MAP_FAILED);
            let address = address as usize;
            let strings = b"\0wl_proxy_marshal_flags\0malloc\0";
            let dynamic = [
                Dynamic {
                    tag: 5,
                    value: address + 512,
                },
                Dynamic {
                    tag: 10,
                    value: strings.len(),
                },
                Dynamic {
                    tag: 6,
                    value: address + 256,
                },
                Dynamic {
                    tag: 7,
                    value: address + 1024,
                },
                Dynamic {
                    tag: 8,
                    value: 2 * size_of::<Relocation>(),
                },
                Dynamic { tag: 0, value: 0 },
            ];
            let symbol = |name| libc::Elf64_Sym {
                st_name: name,
                st_info: 0,
                st_other: 0,
                st_shndx: 0,
                st_value: 0,
                st_size: 0,
            };
            let symbols = [symbol(0), symbol(1), symbol(24)];
            let relocations = [
                Relocation {
                    offset: 1536,
                    info: (1 << 32) | 6,
                    addend: 0,
                },
                Relocation {
                    offset: 1544,
                    info: (2 << 32) | 7,
                    addend: 0,
                },
            ];
            unsafe {
                std::ptr::copy_nonoverlapping(
                    dynamic.as_ptr(),
                    address as *mut Dynamic,
                    dynamic.len(),
                );
                std::ptr::copy_nonoverlapping(
                    symbols.as_ptr(),
                    (address + 256) as *mut libc::Elf64_Sym,
                    symbols.len(),
                );
                std::ptr::copy_nonoverlapping(
                    strings.as_ptr(),
                    (address + 512) as *mut u8,
                    strings.len(),
                );
                std::ptr::copy_nonoverlapping(
                    relocations.as_ptr(),
                    (address + 1024) as *mut Relocation,
                    relocations.len(),
                );
                ((address + 1536) as *mut usize).write(0x1234);
                ((address + 1544) as *mut usize).write(0x5678);
            }
            let header = |kind, offset, length| libc::Elf64_Phdr {
                p_type: kind,
                p_flags: libc::PF_R | libc::PF_W,
                p_offset: 0,
                p_vaddr: offset,
                p_paddr: 0,
                p_filesz: length,
                p_memsz: length,
                p_align: size as u64,
            };
            Self {
                address,
                size,
                headers: vec![
                    header(libc::PT_LOAD, 0, size as u64),
                    header(libc::PT_DYNAMIC, 0, size_of_val(&dynamic) as u64),
                    header(libc::PT_GNU_RELRO, 0, size as u64),
                ],
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(
                unsafe { libc::munmap(self.address as *mut _, self.size) },
                0
            );
        }
    }

    #[test]
    fn binds_wayland_preserves_allocator_and_restores_relro() {
        let fixture = Fixture::new();
        let client = unsafe { libc::dlopen(c"libwayland-client.so.0".as_ptr(), libc::RTLD_NOW) };
        assert!(!client.is_null());
        let expected = unsafe { libc::dlsym(client, c"wl_proxy_marshal_flags".as_ptr()) };
        assert!(!expected.is_null());
        assert_eq!(
            unsafe { libc::mprotect(fixture.address as *mut _, fixture.size, libc::PROT_READ) },
            0
        );
        repair(
            fixture.address,
            &fixture.headers,
            client,
            client,
            fixture.size,
        )
        .expect("repair imports");
        assert_eq!(
            unsafe { ((fixture.address + 1536) as *const usize).read() },
            expected as usize
        );
        assert_eq!(
            unsafe { ((fixture.address + 1544) as *const usize).read() },
            0x5678
        );
        let maps = std::fs::read_to_string("/proc/self/maps").expect("read memory protections");
        let mapping = maps
            .lines()
            .find(|line| {
                line.split_whitespace().next().is_some_and(|range| {
                    range.split_once('-').is_some_and(|(start, end)| {
                        let start = usize::from_str_radix(start, 16).expect("mapping start");
                        let end = usize::from_str_radix(end, 16).expect("mapping end");
                        fixture.address >= start && fixture.address < end
                    })
                })
            })
            .expect("fixture mapping");
        assert_eq!(mapping.split_whitespace().nth(1), Some("r--p"));
        assert_eq!(unsafe { libc::dlclose(client) }, 0);
    }

    #[test]
    fn rejects_relocation_tables_outside_loaded_segments() {
        let fixture = Fixture::new();
        let dynamic = fixture.address as *mut Dynamic;
        unsafe { (*dynamic.add(3)).value = fixture.address + fixture.size - 1 };
        let error = repair(
            fixture.address,
            &fixture.headers,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            fixture.size,
        )
        .expect_err("invalid relocation table");
        assert!(error.contains("relocation table is outside"));
    }
}
