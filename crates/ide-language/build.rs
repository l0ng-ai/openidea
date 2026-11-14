//! Hashes everything that decides what `Syntax::tags` extracts (this crate's
//! sources, queries, language definitions and the locked tree-sitter crates)
//! into `SYNTAX_SOURCE_HASH`, so persistent caches survive releases that leave
//! extraction untouched.

use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace = manifest.join("../..");
    let lock = workspace.join("Cargo.lock");
    let inputs = [manifest.join("src"), manifest.join("queries"), workspace.join("languages")];

    let mut h = blake3::Hasher::new();
    for dir in &inputs {
        println!("cargo:rerun-if-changed={}", dir.display());
        let mut files = Vec::new();
        collect(dir, &mut files);
        files.sort();
        for file in files {
            let rel = file.strip_prefix(&workspace).unwrap_or(&file);
            h.update(rel.to_string_lossy().replace('\\', "/").as_bytes());
            h.update(b"\0");
            h.update(&std::fs::read(&file).unwrap());
            h.update(b"\0");
        }
    }
    println!("cargo:rerun-if-changed={}", lock.display());
    match std::fs::read_to_string(&lock) {
        Ok(text) => h.update(tree_sitter_packages(&text).as_bytes()),
        // Built outside the workspace: fall back to the crate version.
        Err(_) => h.update(std::env::var("CARGO_PKG_VERSION").unwrap().as_bytes()),
    };
    println!("cargo:rustc-env=SYNTAX_SOURCE_HASH={}", &h.finalize().to_hex()[..16]);
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

/// `name version checksum` of every locked `tree-sitter*` package.
fn tree_sitter_packages(lock: &str) -> String {
    let mut out = String::new();
    for package in lock.split("[[package]]") {
        let field = |key: &str| {
            package.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix(" = ")).unwrap_or("").trim_matches('"')
        };
        if field("name").starts_with("tree-sitter") {
            out.push_str(&format!("{} {} {}\n", field("name"), field("version"), field("checksum")));
        }
    }
    out
}
