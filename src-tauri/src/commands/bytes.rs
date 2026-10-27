//! IPC commands of `ide_host::ops::bytes` (the shared implementation).

use crate::state::AppState;
use ide_core::IdeResult;
#[allow(unused_imports)]
pub use ide_host::ops::bytes::*;
use ide_vfs::{ByteRange, FileProbe};
use std::path::PathBuf;
use tauri::State;

/// Size and text/binary classification, from the file's head only.
#[tauri::command]
#[specta::specta]
pub async fn fs_probe(state: State<'_, AppState>, path: PathBuf) -> IdeResult<FileProbe> {
    ide_host::ops::bytes::fs_probe(&state.host, "", path).await
}

/// Up to `len` bytes from `offset` (capped per call), base64-encoded.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_range(state: State<'_, AppState>, path: PathBuf, offset: u64, len: u32) -> IdeResult<ByteRange> {
    ide_host::ops::bytes::fs_read_range(&state.host, "", path, offset, len).await
}

/// An image file as a `data:` URL.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_image(state: State<'_, AppState>, path: PathBuf) -> IdeResult<String> {
    ide_host::ops::bytes::fs_read_image(&state.host, "", path).await
}
