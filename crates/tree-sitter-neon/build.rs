fn main() {
    let src = std::path::Path::new("src");
    cc::Build::new()
        .include(src)
        .file(src.join("parser.c"))
        .file(src.join("scanner.c"))
        .warnings(false)
        .compile("neon");
    println!("cargo:rerun-if-changed=src");
}
