/**
 * The OS clipboard's file list: what Explorer copies, and what the project view
 * puts there so Explorer can paste it back. The format is native (Windows
 * `CF_HDROP`), so the backend owns it; a plain browser has nothing to exchange
 * and every call degrades to "no files".
 */
import { call, commands, isTauri } from "@/platform/ipc";

export interface OsClipboard {
  /** Files Explorer copied; empty when the clipboard holds none. */
  files(): Promise<string[]>;
  /** Whether the clipboard holds files: cheap, for the Paste item's enabled state. */
  hasFiles(): Promise<boolean>;
  /** True only when the OS accepted the file list; false for unsupported hosts. */
  setFiles(paths: string[]): Promise<boolean>;
}

const native: OsClipboard = {
  async files() {
    if (!isTauri()) return [];
    return call(commands.clipboardFileList());
  },

  async hasFiles() {
    if (!isTauri()) return false;
    try {
      return await commands.clipboardHasFiles();
    } catch {
      return false;
    }
  },

  async setFiles(paths) {
    if (!isTauri() || !paths.length) return false;
    try {
      return await call(commands.clipboardSetFileList(paths));
    } catch {
      // The internal clipboard still works; a failed hand-off is not an error.
      return false;
    }
  },
};

let current = native;

export function osClipboard(): OsClipboard {
  return current;
}

/** Tests: force a clipboard implementation. */
export function setOsClipboardForTests(clipboard: OsClipboard | null) {
  current = clipboard ?? native;
}
