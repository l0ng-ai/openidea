import { Channel } from "@tauri-apps/api/core";
import type { ChangeSpec, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { readManyFileLines } from "@/editor/lsp/files";
import { showHint } from "@/editor/lsp/hint";
import { lspRequest } from "@/editor/lsp/lsp";
import { posToOffset } from "@/editor/lsp/positions";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { commands, nextRequestId, type Location, type Pos, type PythonFacts } from "@/platform/ipc";

/** Make method static for one method: its name (and where it is) and the edit of its definition. */
export interface MakeStaticFix {
  name: string;
  at: Pos;
  changes: ChangeSpec[];
}

/**
 * Make method static for the method whose name is at `pos`: `@staticmethod` above its
 * definition (decorators included) and its receiver parameter removed. Whether its
 * call sites keep working is for {@link makeMethodStatic} to find out.
 */
export function makeStaticChanges(doc: Text, facts: PythonFacts, pos: number): MakeStaticFix | null {
  for (const cls of facts.classes) {
    for (const method of cls.methods) {
      const { selection, unusedReceiver } = method;
      if (!unusedReceiver || pos < posToOffset(doc, selection.start) || pos > posToOffset(doc, selection.end)) continue;
      const first = doc.line(Math.min(method.definitionLine + 1, doc.lines));
      const indent = /^\s*/.exec(first.text)![0];
      return {
        name: method.name,
        at: selection.start,
        changes: [
          { from: first.from, insert: `${indent}@staticmethod\n` },
          { from: posToOffset(doc, unusedReceiver.start), to: posToOffset(doc, unusedReceiver.end) },
        ],
      };
    }
  }
  return null;
}

// `self.m` or `super().m` / `super(C, self).m`, the name being the usage.
const THROUGH_INSTANCE = /(?:^|[^\w.])(?:self|super\([^()]*\))\s*\.\s*$/;

/**
 * The usages a static method would break. Through an instance (`self.m(...)`,
 * `super().m(...)`) a call keeps working; through anything else the receiver may be a
 * class — `C.m(obj, ...)`, an alias of it, a subclass, `type(obj)` — that passes the
 * instance itself, so those count as breaking.
 * ponytail: receivers are read as text, not typed; `obj.m(...)` blocks the fix too.
 */
export function breakingUsages(
  usages: readonly Location[],
  linesOf: (path: string) => readonly string[] | null | undefined,
): Location[] {
  return usages.filter(({ path, range }) => {
    const line = linesOf(path)?.[range.start.line];
    return line === undefined || !THROUGH_INSTANCE.test(line.slice(0, range.start.col));
  });
}

/**
 * Applies `fix` once Find Usages (the language server's references, the whole project)
 * shows every call site keeps working; otherwise says why not and lists the ones that would break.
 */
export async function makeMethodStatic(view: EditorView, path: string, doc: number, fix: MakeStaticFix) {
  const before = view.state.doc;
  let usages: Location[];
  try {
    const refs = await lspRequest(() =>
      commands.lspReferences(nextRequestId(), doc, fix.at, false, true, false, new Channel()),
    );
    if (refs.incomplete) throw new Error("incomplete");
    usages = refs.locations;
  } catch {
    showHint(view, tx`Cannot make '${fix.name}' static: its usages could not be searched`, { tone: "warning" });
    return;
  }
  const files = await readManyFileLines(usages.map((u) => u.path).filter((p) => p !== path));
  if (view.state.doc !== before) return;
  const own = before.toString().split("\n");
  const breaking = breakingUsages(usages, (p) => (p === path ? own : files.get(p)));
  if (!breaking.length) {
    view.dispatch({ changes: fix.changes, userEvent: "input" });
    return;
  }
  const count = breaking.length;
  const message =
    count === 1
      ? tx`Cannot make '${fix.name}' static: 1 usage may call it through a class`
      : tx`Cannot make '${fix.name}' static: ${count} usages may call it through a class`;
  showHint(view, message, { tone: "warning" });
  void executeAction("find.showUsageResults", { symbol: fix.name, locations: breaking });
}
