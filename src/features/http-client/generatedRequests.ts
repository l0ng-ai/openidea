import { EditorView } from "@codemirror/view";
import { activeEditor, editorsFor, useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { call, commands, emitLocalIdeEvent, IpcError } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { editorService } from "@/workbench/contributions";
import { appendRequests } from "./spring/request";

export const GENERATED_REQUESTS = "generated-requests.http";

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

export async function appendGeneratedRequests(blocks: string[]): Promise<void> {
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
