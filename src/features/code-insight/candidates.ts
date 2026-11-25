/** Project files that mention a word (Find in Files engine, whole-word, case-sensitive). */
import { Channel } from "@tauri-apps/api/core";
import { IpcError, call, commands, type RequestId, type SearchEvent } from "@/platform/ipc";

export interface CandidateFiles {
  paths: string[];
  /** The search stopped at its match limit: later files were not looked at. */
  limitHit: boolean;
}

export function filesMentioning(request: RequestId, word: string): Promise<CandidateFiles> {
  return new Promise((resolve, reject) => {
    const paths: string[] = [];
    let settled = false;
    const finish = (limitHit: boolean, cancelled = false) => {
      if (settled) return;
      settled = true;
      if (cancelled) reject(new IpcError({ kind: "cancelled", message: "cancelled" }));
      else resolve({ paths, limitHit });
    };
    const channel = new Channel<SearchEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      if (ev.type === "file") paths.push(ev.file.path);
      else finish(ev.summary.limitHit, ev.summary.cancelled);
    };
    const query = {
      pattern: word,
      isRegex: false,
      caseSensitive: true,
      wholeWord: true,
      include: [],
      exclude: [],
      scope: { kind: "project" as const },
      maxMatches: 0,
      skipLargeFiles: true,
    };
    call(commands.searchStart(request, query, channel)).then(
      // `done` normally arrives on the channel; don't hang if it never does.
      () => setTimeout(() => finish(false), 2000),
      (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      },
    );
  });
}
