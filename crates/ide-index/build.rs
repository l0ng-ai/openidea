//! Hashes this crate's sources into `INDEX_SOURCE_HASH`: what is extracted and stored for a
//! file (ignored state, size limit, record layout) is decided here as well as in
//! `ide-language`, so the persistent index is rebuilt when either changes.

use std::path::{Path, PathBuf};

fn main() {
    let src = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("src");
    println!("cargo:rerun-if-changed={}", src.display());
    let mut files = Vec::new();
    collect(&src, &mut files);
    files.sort();
    let mut h = blake3::Hasher::new();
    for file in files {
        h.update(file.strip_prefix(&src).unwrap_or(&file).to_string_lossy().replace('\\', "/").as_bytes());
        h.update(b"\0");
        h.update(&std::fs::read(&file).unwrap());
        h.update(b"\0");
    }
    println!("cargo:rustc-env=INDEX_SOURCE_HASH={}", &h.finalize().to_hex()[..16]);
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else {
            out.push(path);
        }
    }
}
