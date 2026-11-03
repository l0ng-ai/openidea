/**
 * Applying the generation: the statement of a mapper method in its XML, and the
 * `@Param` annotations a Java method is missing.
 *
 * Nothing is written to disk. Each action works on the *text of the open
 * document* — a stale index offset could otherwise cut a statement into the
 * middle of the file — and dispatches one transaction, leaving the tab dirty for
 * the user to save. Only a brand-new mapper XML reaches the filesystem, as an
 * empty file the editor then fills.
 *
 * The operations needed are behind `GenerateDeps` so both actions can be tested
 * without a backend, the way `mapperStore` injects its lookups.
 */
import { EditorView } from "@codemirror/view";
import { activeEditor, editorsFor, useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { call, commands, emitLocalIdeEvent, IpcError } from "@/platform/ipc";
import { editorService, notifications } from "@/workbench/contributions";
import { javaMask } from "./mask";
import { parseJavaMapper, type JavaMapper, type MapperMethod } from "./java";
import { parseMapperXml, type MapperXml } from "./xml";
import { mapperXmlFor, type Found } from "./mapperStore";
import { mapperXmlPath, newMapperXml, paramEdits, statementInsertion, tableName } from "./generate";

export interface GenerateDeps {
  /** The editor of `path`, opened if needed; null when it cannot be shown. */
  editor: (path: string) => Promise<EditorView | null>;
  /** An empty file at `path`, with its parent folders, announced to the project. */
  create: (path: string) => Promise<void>;
  /** The XML half of `namespace`, through the lazy index. */
  xmlOf: (namespace: string) => Promise<Found<MapperXml> | null>;
  notify: (title: string, body: string) => void;
}

/** The text editor of `path`, once a just opened tab has created it. */
function handleFor(path: string, timeoutMs = 5000): Promise<TextEditorHandle | null> {
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

/** Parents plus an empty file, announced so the tree and the lazy index learn about it. */
async function createEmptyFile(path: string): Promise<void> {
  const ignore = (e: unknown) => {
    if (!(e instanceof IpcError && e.kind === "alreadyExists")) throw e;
  };
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  if (dir) await call(commands.fsCreateDir(dir)).catch(ignore);
  await call(commands.fsCreateFile(path));
  emitLocalIdeEvent({ type: "fsChanged", created: [path], modified: [], removed: [] });
}

export const defaultGenerateDeps: GenerateDeps = {
  editor: async (path) => {
    try {
      await editorService().openFile(path, { focus: true });
    } catch {
      return null;
    }
    return (await handleFor(path))?.view ?? null;
  },
  create: createEmptyFile,
  xmlOf: (namespace) => mapperXmlFor(namespace),
  notify: (title, body) => notifications().notify({ level: "error", title, body, key: "mybatis-generate" }),
};

const STMT_TITLE = "Cannot Generate MyBatis Statement";
const PARAM_TITLE = "Cannot Generate @Param Annotations";

function fail(deps: GenerateDeps, title: string, path: string, why: string): void {
  deps.notify(tx(title), `${why}\n${path}`);
}

const detail = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Adds the statement of the method `name` to the XML of the mapper in `view`:
 * creating that XML where the interface has none, in the resources twin of the
 * folder holding `path`.
 */
export async function generateStatement(
  view: EditorView,
  javaPath: string,
  name: string,
  deps: GenerateDeps = defaultGenerateDeps,
): Promise<void> {
  const mapper = parseJavaMapper(view.state.doc.toString(), javaMask(view.state));
  const method = mapper?.methods.find((m) => m.name === name);
  if (!mapper?.isInterface || !method) return fail(deps, STMT_TITLE, javaPath, tx("The document changed; retry"));
  await statementOf(javaPath, mapper, method, deps);
}

async function statementOf(
  javaPath: string,
  mapper: JavaMapper,
  method: MapperMethod,
  deps: GenerateDeps,
): Promise<void> {
  const table = tableName(mapper.name);
  const found = await deps.xmlOf(mapper.qualifiedName);
  const path = found?.path ?? mapperXmlPath(javaPath, mapper.qualifiedName);
  if (!found) {
    try {
      await deps.create(path);
    } catch (e) {
      return fail(deps, STMT_TITLE, path, `${tx("Cannot create the file")}: ${detail(e)}`);
    }
  }
  const view = await deps.editor(path);
  if (!view) return fail(deps, STMT_TITLE, path, tx("Cannot open file"));
  const text = view.state.doc.toString();
  const xml = text.trim() ? parseMapperXml(text) : null;
  if (text.trim() && xml?.namespace !== mapper.qualifiedName)
    return fail(deps, STMT_TITLE, path, tx("Not a mapper XML of this interface"));
  const placement = xml ? statementInsertion(text, xml, method, table) : newMapperXml(mapper, method, table);
  if (!placement) return fail(deps, STMT_TITLE, path, tx("The document changed; retry"));
  view.dispatch({
    changes: placement.edit,
    // The generated SQL is selected: it is the one line that cannot be right.
    selection: { anchor: placement.from, head: placement.to },
    effects: EditorView.scrollIntoView(placement.from, { y: "center" }),
    userEvent: "input",
  });
}

/** Adds the missing `@Param` to `name`'s parameters, in the document the caret is in. */
export async function generateParams(
  view: EditorView,
  javaPath: string,
  name: string,
  deps: GenerateDeps = defaultGenerateDeps,
): Promise<void> {
  const text = view.state.doc.toString();
  const method = parseJavaMapper(text, javaMask(view.state))?.methods.find((m) => m.name === name);
  const edits = method ? paramEdits(text, method) : [];
  if (!edits.length) return fail(deps, PARAM_TITLE, javaPath, tx("The document changed; retry"));
  // No selection: the caret sits on the method name and its edit maps it along.
  view.dispatch({ changes: edits, userEvent: "input" });
}
