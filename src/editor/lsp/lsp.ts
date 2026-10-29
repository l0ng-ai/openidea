/** Shared plumbing: per-editor document facet, IPC wrapper and error policy. */
import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { whenAllSynced, type EditorDocContext } from "@/editor/api";
import { IpcError, call, isCancelled, isTauri, unavailableText } from "@/platform/ipc";
import type { IdeError } from "@/bindings";
import { showHint } from "./hint";

/** The backend document an editor shows (provided by this module's contribution). */
export const lspDoc = Facet.define<EditorDocContext, EditorDocContext | null>({
  combine: (values) => values[0] ?? null,
});

export function docOf(view: EditorView): EditorDocContext | null {
  return view.state.facet(lspDoc);
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: IdeError };

/**
 * Runs an LSP command. Synchronous throws (no Tauri runtime in a plain browser)
 * become `unavailable` rejections so callers have a single error path.
 * `wanted` is checked once pending edits are synced: a request cancelled
 * meanwhile is not sent (the backend ignores cancelling an id it hasn't seen).
 */
export async function lspRequest<T>(run: () => Promise<Result<T>>, wanted?: () => boolean): Promise<T> {
  if (!isTauri()) throw new IpcError({ kind: "unavailable", message: "No language server available" });
  try {
    // Edits typed just before (⌘B right after typing) must reach the server first.
    await whenAllSynced();
    if (wanted && !wanted()) throw new IpcError({ kind: "cancelled", message: "cancelled" });
    return await call(run());
  } catch (e) {
    if (e instanceof IpcError) throw e;
    throw new IpcError({ kind: "internal", message: e instanceof Error ? e.message : String(e) });
  }
}

export function isUnavailable(e: unknown): boolean {
  return e instanceof IpcError && e.kind === "unavailable";
}

export const NO_SERVER = "No language server available";

/**
 * Error policy: background requests fail silently; explicit actions show a
 * small hint at the caret ("No language server available" for missing servers,
 * "jdtls doesn't support X" when the running server lacks the feature).
 */
export function reportLspError(view: EditorView | null, e: unknown, explicit: boolean) {
  if (isCancelled(e)) return;
  if (!explicit || !view) {
    if (!isUnavailable(e)) console.debug("[lsp]", e);
    return;
  }
  showHint(view, isUnavailable(e) ? unavailableText(e, NO_SERVER) : e instanceof Error ? e.message : String(e));
}

/** Runs `fn` once `ms` after the last call; `cancel()` drops a pending run. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const run = (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  run.cancel = () => clearTimeout(t);
  return run;
}
