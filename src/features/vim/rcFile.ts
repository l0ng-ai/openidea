/** Locating and reading the rc file: `~/.openideavimrc`, else `~/.ideavimrc`. */
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { parseVimrc, RC_FILES, type RcIgnored, type RcParseResult } from "./rc";

export interface RcFile {
  path: string;
  text: string;
}

export async function readRcFile(): Promise<RcFile | null> {
  if (!isTauri()) return null;
  const { homeDir, join } = await import("@tauri-apps/api/path");
  const home = await homeDir();
  for (const name of RC_FILES) {
    const path = await join(home, name);
    try {
      return { path, text: await call(commands.fsReadText(path)) };
    } catch {
      // Not there (or unreadable): try the next name.
    }
  }
  return null;
}

export interface RcStatus {
  /** The file read, or null when there is none. */
  path: string | null;
  mappings: number;
  ignored: RcIgnored[];
  loaded: boolean;
}

export const useVimRc = create<RcStatus>(() => ({ path: null, mappings: 0, ignored: [], loaded: false }));

/** Reads and parses the rc file, publishing what was found. */
export async function loadRcFile(): Promise<RcParseResult> {
  const file = await readRcFile().catch(() => null);
  const result = parseVimrc(file?.text ?? "");
  useVimRc.setState({
    path: file?.path ?? null,
    mappings: result.commands.filter((c) => c.kind !== "set").length,
    ignored: result.ignored,
    loaded: true,
  });
  return result;
}
