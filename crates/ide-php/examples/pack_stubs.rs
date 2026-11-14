//! Packs a phpstorm-stubs checkout into the archive the engine embeds
//! (`crates/ide-php/stubs/phpstorm-stubs.zip`).
//!
//! ```text
//! cargo run -p ide-php --example pack_stubs -- <phpstorm-stubs checkout> <out.zip>
//! ```
//!
//! `scripts/php-stubs.sh` clones the pinned release and runs this. Only the
//! extension folders' `.php` files go in (not `tests/`, `meta/` or the
//! repository tooling), plus `LICENSE` and `README.md` for the notices.
//! Entries are sorted and carry a fixed timestamp, so packing the same
//! release twice gives the same bytes.

use std::io::Write;
use std::path::{Path, PathBuf};

/// Top-level folders that are not extension stubs.
const SKIPPED: &[&str] = &["tests", "meta", ".git", ".github", ".idea"];

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(source), Some(out)) = (args.next(), args.next()) else {
        eprintln!("usage: pack_stubs <phpstorm-stubs checkout> <out.zip>");
        std::process::exit(2);
    };
    let source = PathBuf::from(source);
    let mut entries = vec!["LICENSE".to_owned(), "README.md".to_owned()];
    let mut stubs = Vec::new();
    for dir in std::fs::read_dir(&source).expect("read the checkout") {
        let dir = dir.expect("read the checkout").path();
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
        if dir.is_dir() && !SKIPPED.contains(&name.as_str()) {
            collect(&source, &dir, &mut stubs);
        }
    }
    stubs.sort();
    entries.extend(stubs);

    let mut zip = zip::ZipWriter::new(std::fs::File::create(&out).expect("create the archive"));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(9))
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    let mut bytes = 0usize;
    for entry in &entries {
        let data = std::fs::read(source.join(entry)).unwrap_or_else(|e| panic!("read {entry}: {e}"));
        bytes += data.len();
        zip.start_file(entry.as_str(), options).expect("write the archive");
        zip.write_all(&data).expect("write the archive");
    }
    zip.finish().expect("write the archive");
    let packed = std::fs::metadata(&out).map(|m| m.len()).unwrap_or_default();
    println!("{} files, {} KiB of source, {} KiB packed into {out}", entries.len(), bytes / 1024, packed / 1024);
}

/// Every `.php` file below `dir`, as `/`-separated paths relative to `root`.
fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).expect("read the checkout") {
        let path = entry.expect("read the checkout").path();
        if path.is_dir() {
            collect(root, &path, out);
        } else if path.extension().is_some_and(|ext| ext == "php") {
            let relative = path.strip_prefix(root).expect("below the root");
            out.push(relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"));
        }
    }
}
