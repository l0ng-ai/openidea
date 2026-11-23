/**
 * PyCharm's `# noinspection <Id>` comments for the IDE's own Python inspections: the parser
 * reports which code each comment covers (`PythonFacts.suppressions`), problems there are
 * dropped, and ⌥↵ offers Suppress for statement / function / class to write the comment.
 * Ruff and basedpyright have suppress fixes of their own (`# noqa`, `# pyright: ignore`).
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ContributedIntention } from "@/editor/api";
import { suppressIdOf } from "@/platform/inspections";
import type { Diagnostic, PythonFacts, PythonSuppression, Range } from "@/platform/ipc";

type Pos = Range["start"];

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col <= b.col);
const within = (pos: Pos, range: Range) => before(range.start, pos) && before(pos, range.end);

/** Whether a `# noinspection` comment covers `d` (its `code` is the inspection id). */
export function isSuppressed(d: Diagnostic, suppressions: readonly PythonSuppression[]): boolean {
  const id = suppressIdOf(d.code ?? "");
  return (
    !!id && suppressions.some((s) => (s.ids.includes(id) || s.ids.includes("ALL")) && within(d.range.start, s.range))
  );
}

export type SuppressTarget = "statement" | "function" | "class";

/**
 * Where each Suppress fix writes its comment for a problem at `pos`: the line its
 * definition starts on. The inspections report on class and method names, so the
 * statement is that definition itself.
 */
export function suppressTargets(facts: PythonFacts, pos: Pos): { target: SuppressTarget; line: number }[] {
  for (const cls of facts.classes) {
    const method = cls.methods.find((m) => within(pos, m.selection));
    if (method)
      return [
        { target: "statement", line: method.definitionLine },
        { target: "function", line: method.definitionLine },
        { target: "class", line: cls.definitionLine },
      ];
  }
  const cls = facts.classes.find((c) => within(pos, c.selection));
  return cls
    ? [
        { target: "statement", line: cls.definitionLine },
        { target: "class", line: cls.definitionLine },
      ]
    : [];
}

const NOINSPECTION = /^(\s*)#\s*noinspection\s+(.*?)\s*$/;

/** The change that suppresses `id` above 0-based `line`: a new comment, or `id` added to the one there. */
export function suppressChange(doc: Text, line: number, id: string): { from: number; to?: number; insert: string } {
  const target = doc.line(line + 1);
  const indent = /^\s*/.exec(target.text)![0];
  if (line > 0) {
    const above = doc.line(line);
    const m = NOINSPECTION.exec(above.text);
    if (m && m[1] === indent) {
      const ids = m[2]!.split(",").map((s) => s.trim());
      if (ids.includes(id) || ids.includes("ALL")) return { from: above.from, insert: "" };
      return { from: above.from, to: above.to, insert: `${indent}# noinspection ${[...ids, id].join(",")}` };
    }
  }
  return { from: target.from, insert: `${indent}# noinspection ${id}\n` };
}

const LABELS: Record<SuppressTarget, string> = {
  statement: "Suppress for statement",
  function: "Suppress for function",
  class: "Suppress for class",
};

/** The ⌥↵ Suppress rows for inspection `inspectionId` at the caret, from the document's last `facts`. */
export function suppressControls(
  view: EditorView,
  inspectionId: string,
  facts: PythonFacts | undefined,
): ContributedIntention[] {
  const id = suppressIdOf(inspectionId);
  if (!id || !facts) return [];
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return suppressTargets(facts, { line: line.number - 1, col: head - line.from }).map(({ target, line }) => ({
    id: `inspection.suppress.${target}`,
    label: LABELS[target],
    run: () => view.dispatch({ changes: suppressChange(view.state.doc, line, id), userEvent: "input" }),
  }));
}
