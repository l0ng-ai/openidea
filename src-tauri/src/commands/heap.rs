//! Heap snapshots of a debugged JVM or of an `.hprof` file (`ide_host::ops::heap`).

use crate::state::AppState;
use ide_core::{DebugSessionId, IdeResult, IpcPath, RequestId};
use ide_host::ops::heap::{
    HeapCaptureResult, HeapClassDiff, HeapClassRow, HeapObjectPage, HeapObjectRef, HeapOpenResult, HeapPathStep,
    HeapProgress, HeapSnapshotId,
};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Dumps the session's JVM and analyzes the dump; cancel with `request`.
#[tauri::command]
#[specta::specta]
pub async fn debug_heap_capture(
    window: Window,
    state: State<'_, AppState>,
    session: DebugSessionId,
    request: RequestId,
    on_progress: Channel<HeapProgress>,
) -> IdeResult<HeapCaptureResult> {
    ide_host::ops::heap::debug_heap_capture(
        &state.host,
        window.label(),
        session,
        request,
        crate::commands::sender(on_progress),
    )
    .await
}

/// Analyzes an `.hprof` file; cancel with `request`.
#[tauri::command]
#[specta::specta]
pub async fn debug_heap_open(
    window: Window,
    state: State<'_, AppState>,
    path: IpcPath,
    request: RequestId,
    on_progress: Channel<HeapProgress>,
) -> IdeResult<HeapOpenResult> {
    ide_host::ops::heap::debug_heap_open(
        &state.host,
        window.label(),
        path,
        request,
        crate::commands::sender(on_progress),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_heap_classes(
    window: Window,
    state: State<'_, AppState>,
    snapshot: HeapSnapshotId,
) -> IdeResult<Vec<HeapClassRow>> {
    ide_host::ops::heap::debug_heap_classes(&state.host, window.label(), snapshot).await
}

/// A page of the dominator tree: under `parent`, of type `classIndex`, or both.
#[tauri::command]
#[specta::specta]
pub async fn debug_heap_dominators(
    window: Window,
    state: State<'_, AppState>,
    snapshot: HeapSnapshotId,
    parent: Option<HeapObjectRef>,
    class_index: Option<u32>,
    offset: u32,
    limit: u32,
) -> IdeResult<HeapObjectPage> {
    ide_host::ops::heap::debug_heap_dominators(
        &state.host,
        window.label(),
        snapshot,
        parent,
        class_index,
        offset,
        limit,
    )
    .await
}

/// The shortest path from `object` to a GC root; `null` when it is unreachable.
#[tauri::command]
#[specta::specta]
pub async fn debug_heap_path(
    window: Window,
    state: State<'_, AppState>,
    snapshot: HeapSnapshotId,
    object: HeapObjectRef,
) -> IdeResult<Option<Vec<HeapPathStep>>> {
    ide_host::ops::heap::debug_heap_path(&state.host, window.label(), snapshot, object).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_heap_compare(
    window: Window,
    state: State<'_, AppState>,
    base: HeapSnapshotId,
    current: HeapSnapshotId,
) -> IdeResult<Vec<HeapClassDiff>> {
    ide_host::ops::heap::debug_heap_compare(&state.host, window.label(), base, current).await
}

/// Copies the snapshot's dump to `path`, replacing a file there.
#[tauri::command]
#[specta::specta]
pub async fn debug_heap_save(
    window: Window,
    state: State<'_, AppState>,
    snapshot: HeapSnapshotId,
    path: IpcPath,
) -> IdeResult<()> {
    ide_host::ops::heap::debug_heap_save(&state.host, window.label(), snapshot, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_heap_close(window: Window, state: State<'_, AppState>, snapshot: HeapSnapshotId) -> IdeResult<()> {
    ide_host::ops::heap::debug_heap_close(&state.host, window.label(), snapshot).await
}
