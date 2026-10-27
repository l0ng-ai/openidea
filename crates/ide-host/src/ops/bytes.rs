//! Raw file bytes for the image viewer and hex view (see `ide_vfs::bytes`).
use crate::Host;
use crate::rpc::Dispatcher;

use crate::ops::doc::blocking;
use ide_core::IdeResult;
use ide_vfs::{ByteRange, FileProbe};
use std::path::PathBuf;

/// Size and text/binary classification, from the file's head only.
pub async fn fs_probe(_host: &Host, _window: &str, path: PathBuf) -> IdeResult<FileProbe> {
    blocking(move || ide_vfs::probe(&path)).await
}

/// Up to `len` bytes from `offset` (capped per call), base64-encoded.
pub async fn fs_read_range(_host: &Host, _window: &str, path: PathBuf, offset: u64, len: u32) -> IdeResult<ByteRange> {
    blocking(move || ide_vfs::read_range(&path, offset, len)).await
}

/// An image file as a `data:` URL.
pub async fn fs_read_image(_host: &Host, _window: &str, path: PathBuf) -> IdeResult<String> {
    blocking(move || ide_vfs::read_data_url(&path)).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("fs_probe", |c| async move { fs_probe(&c.host, &c.window, c.arg("path")?).await });
    d.add("fs_read_range", |c| async move {
        fs_read_range(&c.host, &c.window, c.arg("path")?, c.arg("offset")?, c.arg("len")?).await
    });
    d.add("fs_read_image", |c| async move { fs_read_image(&c.host, &c.window, c.arg("path")?).await });
}
