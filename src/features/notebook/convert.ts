/** Convert to Python File (.ipynb → .py) and Convert to Jupyter Notebook (.py → .ipynb). */
import { editorsFor } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { toBase64 } from "@/platform/base64";
import { tx } from "@/platform/i18n";
import { call, commands, IpcError } from "@/platform/ipc";
import { editorService, notifications, registerMenuGroup } from "@/workbench/contributions";
import { notebookCells, notebookToScript, scriptToNotebook } from "./script";
import { existingNotebookSession } from "./session";

const isNotebook = (path: string) => /\.ipynb$/i.test(path);
const isScript = (path: string) => /\.py$/i.test(path);

/** The right-clicked file, else the active editor's. */
function target(arg: unknown, accepts: (path: string) => boolean): string | null {
  const path = typeof arg === "string" ? arg : (editorService().activeInput?.()?.path ?? null);
  return path && accepts(path) ? path : null;
}

/** Writes `<stem><ext>` beside `source`, or `<stem>-1<ext>`, … if taken; returns the path written. */
export async function writeBeside(
  source: string,
  ext: string,
  text: string,
  create = (path: string, base64: string) => call(commands.fsCreateFileBytes(path, base64)),
): Promise<string> {
  const stem = source.slice(0, source.lastIndexOf("."));
  const data = toBase64(new TextEncoder().encode(text));
  for (let n = 0; ; n++) {
    const path = `${stem}${n ? `-${n}` : ""}${ext}`;
    try {
      // oxlint-disable-next-line no-await-in-loop -- the next name is only tried after this one reports alreadyExists
      await create(path, data);
      return path;
    } catch (error) {
      if (!(error instanceof IpcError) || error.kind !== "alreadyExists") throw error;
    }
  }
}

async function notebookText(path: string): Promise<string> {
  const session = existingNotebookSession(path);
  const snapshot = session && (await session.flush(), session.getState().snapshot);
  // An open notebook is converted as shown, unsaved edits included.
  const cells = snapshot ? snapshot.cells : notebookCells(await call(commands.fsReadText(path)));
  return notebookToScript(cells);
}

async function scriptText(path: string): Promise<string> {
  const open = editorsFor(path)[0];
  return open ? open.view.state.doc.toString() : call(commands.fsReadText(path));
}

async function convert(path: string, toScript: boolean) {
  try {
    const text = toScript ? await notebookText(path) : scriptToNotebook(await scriptText(path));
    await editorService().openFile(await writeBeside(path, toScript ? ".py" : ".ipynb", text));
  } catch (error) {
    notifications().notify({
      level: "error",
      title: toScript ? tx("Could not convert to a Python file") : tx("Could not convert to a Jupyter notebook"),
      body: error instanceof Error ? tx(error.message) : String(error),
    });
  }
}

export function registerConversions(): () => void {
  const disposers = [
    registerActions([
      {
        id: "notebook.convertToPython",
        title: "Convert to Python File",
        category: "File",
        when: "projectOpen",
        enabled: ({ arg }) => !!target(arg, isNotebook),
        run: ({ arg }) => {
          const path = target(arg, isNotebook);
          if (path) return convert(path, true);
        },
      },
      {
        id: "notebook.convertToNotebook",
        title: "Convert to Jupyter Notebook",
        category: "File",
        when: "projectOpen",
        enabled: ({ arg }) => !!target(arg, isScript),
        run: ({ arg }) => {
          const path = target(arg, isScript);
          if (path) return convert(path, false);
        },
      },
    ]),
    registerMenuGroup({
      id: "notebook.convert",
      menus: ["projectView"],
      order: 46,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (path && isNotebook(path)) return [{ kind: "action", action: "notebook.convertToPython", arg: path }];
        if (path && isScript(path)) return [{ kind: "action", action: "notebook.convertToNotebook", arg: path }];
        return [];
      },
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
