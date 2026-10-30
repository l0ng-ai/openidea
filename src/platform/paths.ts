/**
 * Paths coming *into* the UI from a native API (`appDataDir()` from
 * `@tauri-apps/api/path`, the file dialogs) are native strings: `C:\a\b` on
 * Windows. Everything the UI stores and compares — what the backend returns
 * (`IpcPath` in `crates/ide-core/src/ipc_path.rs`), the editor's `ctx.path`, the
 * project tree — is `/`-separated on every OS, so such a path has to be
 * converted before it is used.
 */

const DRIVE = /^[A-Za-z]:\\/;
const NETWORK = /^\\\\/;

/**
 * `p` in the form the UI holds paths: `C:\a\b` and `\\?\C:\a\b` become
 * `C:/a/b`, `\\server\share` becomes `//server/share`. A path that already is
 * in that form — or one that is not a Windows path at all — is returned as is.
 */
export function ipcPath(p: string): string {
  let path = p;
  if (path.startsWith("\\\\?\\")) path = path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.slice(4);
  return DRIVE.test(path) || NETWORK.test(path) ? path.replace(/\\/g, "/") : path;
}
