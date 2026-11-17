/**
 * The OS clipboard's file list: what Explorer copies, and what the project view
 * puts there so Explorer can paste it back; and its image (a screenshot), which
 * Paste saves as a file. The format is native (Windows
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
  /** Whether the clipboard holds an image: cheap, for the Paste item's enabled state. */
  hasImage(): Promise<boolean>;
  /** The clipboard's image as PNG bytes, null when it holds none. */
  image(): Promise<Uint8Array | null>;
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

  async hasImage() {
    if (!isTauri()) return false;
    try {
      return await commands.clipboardHasImage();
    } catch {
      return false;
    }
  },

  async image() {
    if (!isTauri()) return null;
    const url = await call(commands.clipboardImage());
    if (!url) return null;
    const binary = atob(url.slice(url.indexOf(",") + 1));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  },
};

let current = native;

export function osClipboard(): OsClipboard {
  return current;
}

/** Tests: force a clipboard implementation; what it leaves out holds nothing. */
export function setOsClipboardForTests(clipboard: Partial<OsClipboard> | null) {
  current = clipboard
    ? {
        files: async () => [],
        hasFiles: async () => false,
        setFiles: async () => false,
        hasImage: async () => false,
        image: async () => null,
        ...clipboard,
      }
    : native;
}
