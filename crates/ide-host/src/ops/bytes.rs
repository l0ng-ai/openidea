//! Raw file bytes for the image viewer and hex view (see `ide_vfs::bytes`).
use crate::Host;
use ide_command::command;

use crate::ops::doc::blocking;
use ide_core::{IdeError, IdeResult};
use ide_vfs::{ByteRange, FileProbe, ParquetPage};
use std::path::PathBuf;

/// Size and text/binary classification, from the file's head only.
#[command(trust = always)]
pub async fn fs_probe(path: PathBuf) -> IdeResult<FileProbe> {
    blocking(move || ide_vfs::probe(&path)).await
}

/// Up to `len` bytes from `offset` (capped per call), base64-encoded.
#[command(trust = always)]
pub async fn fs_read_range(path: PathBuf, offset: u64, len: u32) -> IdeResult<ByteRange> {
    blocking(move || ide_vfs::read_range(&path, offset, len)).await
}

/// An image file as a `data:` URL.
#[command(trust = always)]
pub async fn fs_read_image(host: &Host, path: PathBuf) -> IdeResult<String> {
    // A network path is read only from a share an open project is on: the path may come from
    // Markdown, and opening a share signs in to its server.
    let opened: Vec<PathBuf> = host.projects().iter().map(|project| project.root.clone()).collect();
    blocking(move || ide_vfs::read_data_url(&path, &opened)).await
}

#[command(trust = always)]
pub async fn fs_read_parquet(host: &Host, path: PathBuf, offset: u64) -> IdeResult<ParquetPage> {
    let opened: Vec<PathBuf> = host.projects().iter().map(|project| project.root.clone()).collect();
    blocking(move || {
        if !ide_vfs::content_path_allowed(&path, &opened) {
            return Err(IdeError::invalid(format!("{} is not on a local drive or an opened share", path.display())));
        }
        ide_vfs::read_parquet_page(&path, offset)
    })
    .await
}

ide_command::domain!(bytes: fs_probe, fs_read_image, fs_read_range, fs_read_parquet);
