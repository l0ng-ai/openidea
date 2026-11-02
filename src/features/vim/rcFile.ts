/** Locating and reading the rc file: `~/.openideavimrc`, else `~/.ideavimrc`. */
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { parseVimrc, RC_FILES, sourcedPaths, type RcIgnored, type RcParseResult } from "./rc";

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

const MAX_SOURCED_FILES = 32;

/** The files `source` lines reach, by the path as written. `~` is the home directory, others stay as given. */
export async function readSourcedFiles(
  text: string,
  read: (path: string) => Promise<string>,
  home: string,
): Promise<Map<string, string | null>> {
  const sources = new Map<string, string | null>();
  const pending = sourcedPaths(text);
  while (pending.length && sources.size < MAX_SOURCED_FILES) {
    const path = pending.shift()!;
    if (sources.has(path)) continue;
    const content = await read(path.replace(/^~(?=$|[\\/])/, home)).catch(() => null);
    sources.set(path, content);
    if (content !== null) pending.push(...sourcedPaths(content));
  }
  return sources;
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
  let sources: Map<string, string | null> | undefined;
  if (file) {
    const { homeDir } = await import("@tauri-apps/api/path");
    sources = await readSourcedFiles(file.text, (path) => call(commands.fsReadText(path)), await homeDir());
  }
  const result = parseVimrc(file?.text ?? "", sources);
  useVimRc.setState({
    path: file?.path ?? null,
    mappings: result.commands.filter((c) => c.kind !== "set").length,
    ignored: result.ignored,
    loaded: true,
  });
  return result;
}
