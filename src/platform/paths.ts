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

const SHARE = /^[\\/]{2}/;
const SHARE_NAME = /^[\\/]{2}(?:\?[\\/]UNC[\\/])?([^\\/]+)[\\/]([^\\/]+)/i;

/**
 * `server/share` of a path on a network share, in lower case; null for any other path. The
 * host hands out a share's paths as `//?/UNC/server/share/…`, the dialogs as `//server/share/…`.
 */
function shareOf(path: string): string | null {
  const m = SHARE_NAME.exec(path);
  // Any other device path (`//?/C:/…`, `//./…`) names no server to compare.
  return m && m[1] !== "?" && m[1] !== "." ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * Whether `path` is on a network share that `base` is not on. Windows reads `//server/share`,
 * `\\server\share` and mixes of the two as a share, and opening one signs in to its server
 * with the user's credentials: a path that text someone else wrote leads to is followed to no
 * share but the one that text is on.
 */
export function onOtherShare(path: string, base: string): boolean {
  if (!SHARE.test(path)) return false;
  const share = shareOf(path);
  return share === null || share !== shareOf(base);
}

/**
 * `onOtherShare` for a path resolved against `base`, the folder or file of the text naming
 * it: also true when that text spells a share itself (`written`, decoded).
 */
export function opensOtherShare(path: string, written: string, base: string): boolean {
  return SHARE.test(written) || onOtherShare(path, base);
}

/** True when `path` equals `ancestor` or lies below it. */
export function isSameOrInside(path: string, ancestor: string): boolean {
  path = ipcPath(path);
  ancestor = ipcPath(ancestor);
  return path === ancestor || path.startsWith(ancestor.endsWith("/") ? ancestor : ancestor + "/");
}
