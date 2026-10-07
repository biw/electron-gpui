fn main() {
    // napi's C functions are provided by Node/Electron at load time. This crate is
    // an rlib, so these link args only affect its unit-test binary, letting it link
    // without them; the tests never call into napi itself.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
