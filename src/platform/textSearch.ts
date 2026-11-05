import { Channel } from "@tauri-apps/api/core";
import {
  call,
  commands,
  type FileMatches,
  type RequestId,
  type SearchEvent,
  type SearchQuery,
  type SearchSummary,
} from "@/platform/ipc";

/**
 * Starts a streaming Find in Files request. `onFile` receives each file's
 * matches as they are found; resolves with the summary (null when the
 * request failed or was cancelled before it finished).
 */
export function streamSearch(
  request: RequestId,
  query: SearchQuery,
  onFile: (f: FileMatches) => void,
): Promise<SearchSummary | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (s: SearchSummary | null) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    const channel = new Channel<SearchEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      if (ev.type === "file") onFile(ev.file);
      else finish(ev.summary);
    };
    call(commands.searchStart(request, query, channel)).then(
      // `done` normally arrives on the channel; don't hang if it never does.
      () => setTimeout(() => finish(null), 2000),
      (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      },
    );
  });
}

export function cancelRequest(request: RequestId) {
  void commands.cancelRequest(request).catch(() => {});
}
