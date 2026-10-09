//! GNU/Linux x64 ELF import repair for hosts exporting private Wayland symbols.
//!
//! Keep the host's allocator and every other import intact. Only new graphics
//! libraries, system Wayland, and this addon receive system Wayland bindings.
//! Electron's own libraries continue to use its private implementation.

use std::collections::HashSet;
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

pub(super) fn loaded_objects() -> HashSet<usize> {
    unsafe extern "C" fn visit(
        info: *mut libc::dl_phdr_info,
        _: usize,
        data: *mut libc::c_void,
    ) -> libc::c_int {
        // dl_iterate_phdr keeps these headers alive throughout the callback.
        unsafe { &mut *data.cast::<HashSet<usize>>() }
            .insert(unsafe { (*info).dlpi_addr } as usize);
        0
    }
    let mut objects = HashSet::new();
    unsafe {
        libc::dl_iterate_phdr(Some(visit), (&mut objects as *mut HashSet<usize>).cast());
    }
    objects
}

pub(super) fn redirect(
    existing: &HashSet<usize>,
    client: *mut libc::c_void,
    cursor: *mut libc::c_void,
    addon_function: *const (),
) -> Result<(), String> {
    let mut owner = std::mem::MaybeUninit::<libc::Dl_info>::uninit();
    if unsafe { libc::dladdr(addon_function.cast(), owner.as_mut_ptr()) } == 0 {
        return Err("locating the GPUI addon for Wayland symbol binding".into());
    }
    let addon_base = unsafe { owner.assume_init() }.dli_fbase as usize;
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 || !(page_size as usize).is_power_of_two() {
        return Err("invalid system page size for Wayland symbol binding".into());
    }
    struct State<'a> {
        existing: &'a HashSet<usize>,
        addon_base: usize,
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
        let filename = name.rsplit(|byte| *byte == b'/').next().unwrap_or(name);
        let base = info.dlpi_addr as usize;
        if base == state.addon_base
            || !state.existing.contains(&base)
            || filename.starts_with(b"libwayland-client.")
            || filename.starts_with(b"libwayland-cursor.")
        {
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
        existing,
        addon_base,
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
    let mapped = |address: usize, size: usize| {
        headers.iter().any(|header| {
            header.p_type == libc::PT_LOAD
                && address >= base + header.p_vaddr as usize
                && address.checked_add(size).is_some_and(|end| {
                    end <= base + header.p_vaddr as usize + header.p_memsz as usize
                })
        })
    };
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
        if !mapped(address, size) || size % size_of::<Relocation>() != 0 {
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
            if !mapped(target, size_of::<usize>()) || target % align_of::<AtomicUsize>() != 0 {
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
