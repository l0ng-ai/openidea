/**
 * Go to declaration in `go.mod`, as in GoLand: ⌘/Ctrl-click (or ⌘B) on the module path of
 * a `require` or `replace` line selects that module's folder under External Libraries
 * (the module cache, or `vendor/`). A module that is not downloaded has no folder there
 * and is left to the language server (its documentation link).
 */
import { EditorState, type Extension, type Text } from "@codemirror/state";
import { CONTRIBUTED_DEFINITION, type ContributedDefinition, type EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";

interface GoModEntry {
  path: string;
  /** The required version; null on a `replace` without one. */
  version: string | null;
  from: number;
  to: number;
}

const ENTRY = /^(\s*)(["`]?)([^\s"`()]+)\2(?:\s+([^\s=]+))?/;
const entries = new WeakMap<Text, GoModEntry[]>();

/** The module paths of the `require` / `replace` entries of `doc` (a replacement's own path excluded). */
function goModEntries(doc: Text): GoModEntry[] {
  let list = entries.get(doc);
  if (list) return list;
  list = [];
  let block: string | null = null;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const comment = line.text.indexOf("//");
    let code = comment < 0 ? line.text : line.text.slice(0, comment);
    let offset = 0;
    if (!block) {
      const directive = /^\s*(\w+)\s*/.exec(code);
      if (!directive) continue;
      if (code.slice(directive[0].length).trim() === "(") {
        block = directive[1]!;
        continue;
      }
      if (directive[1] !== "require" && directive[1] !== "replace") continue;
      offset = directive[0].length;
      code = code.slice(offset);
    } else if (code.trim() === ")") {
      block = null;
      continue;
    } else if (block !== "require" && block !== "replace") continue;
    const m = ENTRY.exec(code);
    if (!m) continue;
    const from = line.from + offset + m[1]!.length + m[2]!.length;
    list.push({ path: m[3]!, version: m[4] ?? null, from, to: from + m[3]!.length });
  }
  entries.set(doc, list);
  return list;
}

/** The `require` / `replace` entry whose module path covers `offset`. */
export function goModModuleAt(doc: Text, offset: number): GoModEntry | null {
  return goModEntries(doc).find((e) => e.from <= offset && offset <= e.to) ?? null;
}

/**
 * Go to declaration in the project's `go.mod` files; `moduleRoot` finds a module's External
 * Libraries folder, `isLibrary` tells a library's own `go.mod` (whose graph is not the project's).
 */
export function goModNavigationExtension(
  moduleRoot: (path: string, version: string | null) => string | null,
  isLibrary: (path: string) => boolean,
) {
  return (ctx: EditorDocContext): Extension => {
    if (ctx.virtual || !/(^|[\\/])go\.mod$/.test(ctx.path) || isLibrary(ctx.path)) return [];
    const rootAt = (state: EditorState, pos: number) => {
      const entry = goModModuleAt(state.doc, pos);
      return entry && moduleRoot(entry.path, entry.version);
    };
    const definition: ContributedDefinition = (view, pos) => {
      const root = rootAt(view.state, pos);
      if (!root) return false;
      void executeAction("navigate.selectInProjectView", root);
      return true;
    };
    return EditorState.languageData.of((state, pos) =>
      rootAt(state, pos) ? [{ [CONTRIBUTED_DEFINITION]: definition }] : [],
    );
  };
}
