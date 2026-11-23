import type { ChangeSpec, Text } from "@codemirror/state";
import { posToOffset } from "@/editor/lsp/positions";
import type { PythonFacts } from "@/platform/ipc";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Make method static for the method whose name is at `pos`: `@staticmethod` above its
 * definition (decorators included) and its receiver parameter removed. Calls through an
 * instance (`self.method(...)`) keep working; a call through a class of this file
 * (`Base.method(obj, ...)`) passes the instance itself and would break, so then there is no fix.
 */
export function makeStaticChanges(doc: Text, facts: PythonFacts, pos: number): ChangeSpec[] | null {
  for (const cls of facts.classes) {
    for (const method of cls.methods) {
      const { selection, unusedReceiver } = method;
      if (!unusedReceiver || pos < posToOffset(doc, selection.start) || pos > posToOffset(doc, selection.end)) continue;
      const classes = facts.classes.map((c) => escape(c.name)).join("|");
      if (new RegExp(`\\b(?:${classes})\\s*\\.\\s*${escape(method.name)}\\s*\\(`).test(doc.toString())) return null;
      const first = doc.line(Math.min(method.definitionLine + 1, doc.lines));
      const indent = /^\s*/.exec(first.text)![0];
      return [
        { from: first.from, insert: `${indent}@staticmethod\n` },
        { from: posToOffset(doc, unusedReceiver.start), to: posToOffset(doc, unusedReceiver.end) },
      ];
    }
  }
  return null;
}
