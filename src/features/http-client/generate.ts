/**
 * Requests generated from framework sources (Spring mappings, Rails routes)
 * into the `generated-requests.http` scratch: the `### Name` block format and
 * appending to the scratch, opened at the first new request.
 */
import { EditorView } from "@codemirror/view";
import { activeEditor, editorsFor, useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { call, commands, emitLocalIdeEvent, IpcError } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { editorService } from "@/workbench/contributions";

export const GENERATED_REQUESTS = "generated-requests.http";

/** One request to write into the scratch. */
export interface RequestSpec {
  /** The `### Name` line. */
  name: string;
  method: string;
  /** Full URL, `{{variables}}` included. */
  url: string;
  headers: { name: string; value: string }[];
  /** Body text (already serialised), separated from the headers by a blank line. */
  body?: string;
}

/** One `### Name` request block, ending with a line break. */
export function renderRequestBlock(spec: RequestSpec): string {
  const lines = [`### ${spec.name}`, `${spec.method} ${spec.url}`];
  for (const h of spec.headers) lines.push(`${h.name}: ${h.value}`);
  if (spec.body !== undefined) lines.push("", spec.body);
  return `${lines.join("\n")}\n`;
}

/** Text to append to a request file holding `existing`, and the offset (in the new text) of the first request line. */
export function appendRequests(existing: string, blocks: string[]): { insert: string; from: number; caret: number } {
  const from = existing.length;
  let sep = "";
  if (existing.trim()) sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const insert = sep + blocks.join("\n");
  const firstLine = blocks[0]?.indexOf("\n") ?? -1;
  return { insert, from, caret: from + sep.length + (firstLine >= 0 ? firstLine + 1 : 0) };
}

async function scratchFile(): Promise<{ path: string; created: boolean }> {
  const { appDataDir } = await import("@tauri-apps/api/path");
  // `appDataDir()` is native (`C:\…`): the editor is found by its `/` path.
  const dir = `${ipcPath(await appDataDir()).replace(/\/+$/, "")}/scratches`;
  const ignoreExisting = (e: unknown) => {
    if (!(e instanceof IpcError && e.kind === "alreadyExists")) throw e;
  };
  await call(commands.fsCreateDir(dir)).catch(ignoreExisting);
  const path = `${dir}/${GENERATED_REQUESTS}`;
  let created = true;
  await call(commands.fsCreateFile(path)).catch((e) => {
    ignoreExisting(e);
    created = false;
  });
  return { path, created };
}

/** The text editor of `path`, once the just opened tab has created it. */
function editorFor(path: string, timeoutMs = 5000): Promise<TextEditorHandle | null> {
  const find = () => editorsFor(path).find((x) => x === activeEditor()) ?? editorsFor(path)[0] ?? null;
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (e: TextEditorHandle | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(e);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const unsubscribe = useEditorRegistry.subscribe(() => {
      const e = find();
      if (e) done(e);
    });
  });
}

/** Appends `blocks` to the generated-requests scratch and opens it at the first one; rejects when the scratch cannot be opened. */
export async function generateIntoScratch(blocks: string[]): Promise<void> {
  if (!blocks.length) return;
  const file = await scratchFile();
  if (file.created) emitLocalIdeEvent({ type: "fsChanged", created: [file.path], modified: [], removed: [] });
  await editorService().openFile(file.path, { focus: true });
  const e = await editorFor(file.path);
  if (!e) throw new Error(`${tx("Cannot open file")}: ${file.path}`);
  const { insert, from, caret } = appendRequests(e.view.state.doc.toString(), blocks);
  e.view.dispatch({
    changes: { from, insert },
    selection: { anchor: caret },
    effects: EditorView.scrollIntoView(caret, { y: "center" }),
    userEvent: "input",
  });
}
