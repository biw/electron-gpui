fn main() {
    napi_build::setup();
    // napi's symbols come from Node/Electron at load time; let `cargo test`
    // binaries for this crate link too.
    println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
}
