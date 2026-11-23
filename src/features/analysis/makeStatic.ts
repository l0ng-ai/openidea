import type { ChangeSpec, Text } from "@codemirror/state";
import type { PythonFacts, Range } from "@/platform/ipc";

const offset = (doc: Text, pos: Range["start"]) => doc.line(pos.line + 1).from + pos.col;

/**
 * Make method static for the method whose name is at `pos`: `@staticmethod` above its
 * definition (decorators included) and its receiver parameter removed. Calls through
 * `self.method(...)` keep working, so they are left as they are.
 */
export function makeStaticChanges(doc: Text, facts: PythonFacts, pos: number): ChangeSpec[] | null {
  for (const cls of facts.classes) {
    for (const method of cls.methods) {
      const { selection, unusedReceiver } = method;
      if (!unusedReceiver || pos < offset(doc, selection.start) || pos > offset(doc, selection.end)) continue;
      const first = doc.line(method.definitionLine + 1);
      const indent = /^\s*/.exec(first.text)![0];
      return [
        { from: first.from, insert: `${indent}@staticmethod\n` },
        { from: offset(doc, unusedReceiver.start), to: offset(doc, unusedReceiver.end) },
      ];
    }
  }
  return null;
}
