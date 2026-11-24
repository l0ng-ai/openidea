import { EditorState, StateEffect, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import type { Diagnostic, PythonFacts, Range } from "@/platform/ipc";
import { isSuppressed, suppressChange, suppressControls, suppressTargets } from "./pythonSuppression";

const range = (sl: number, sc: number, el: number, ec: number): Range => ({
  start: { line: sl, col: sc },
  end: { line: el, col: ec },
});
const problem = (code: string, line: number): Diagnostic => ({
  range: range(line, 4, line, 8),
  severity: "warning",
  message: "",
  source: "Python",
  code,
});

it("drops problems a matching comment covers", () => {
  const suppressions = [{ ids: ["PyAbstractClass"], range: range(2, 0, 5, 0) }];
  expect(isSuppressed(problem("builtin:python-abstract-method", 3), suppressions)).toBe(true);
  expect(isSuppressed(problem("builtin:python-abstract-method", 6), suppressions)).toBe(false);
  expect(isSuppressed(problem("builtin:python-override", 3), suppressions)).toBe(false);
  expect(isSuppressed(problem("builtin:python-override", 3), [{ ids: ["ALL"], range: range(0, 0, 9, 0) }])).toBe(true);
  // Inspections without a `# noinspection` id are never suppressed.
  expect(isSuppressed(problem("builtin:spelling", 3), [{ ids: ["ALL"], range: range(0, 0, 9, 0) }])).toBe(false);
});

const FACTS: PythonFacts = {
  suppressions: [],
  classes: [
    {
      name: "Shape",
      selection: range(1, 6, 1, 11),
      definitionLine: 0,
      bases: [],
      methods: [
        {
          name: "area",
          selection: range(4, 8, 4, 12),
          definitionLine: 3,
          params: ["self"],
          abstractMethod: false,
          overrideDecorated: true,
          body: { kind: "empty" },
        },
      ],
    },
  ],
};

it("targets the reported definition and its class", () => {
  expect(suppressTargets(FACTS, { line: 4, col: 10 })).toEqual([
    { target: "statement", line: 3 },
    { target: "function", line: 3 },
    { target: "class", line: 0 },
  ]);
  expect(suppressTargets(FACTS, { line: 1, col: 11 })).toEqual([
    { target: "statement", line: 0 },
    { target: "class", line: 0 },
  ]);
  expect(suppressTargets(FACTS, { line: 2, col: 0 })).toEqual([]);
});

const apply = (doc: Text, change: ReturnType<typeof suppressChange>) =>
  doc.replace(change.from, change.to ?? change.from, Text.of(change.insert.split("\n"))).toString();

it("writes the comment above the target at its indentation, or adds to the one there", () => {
  const doc = Text.of(["class Shape:", "    @override", "    def area(self):", "        pass"]);
  expect(apply(doc, suppressChange(doc, 1, "PyOverrideDecorator"))).toBe(
    "class Shape:\n    # noinspection PyOverrideDecorator\n    @override\n    def area(self):\n        pass",
  );
  const commented = Text.of(["class Shape:", "    # noinspection PyAbstractClass", "    def area(self):"]);
  expect(apply(commented, suppressChange(commented, 2, "PyOverrideDecorator"))).toBe(
    "class Shape:\n    # noinspection PyAbstractClass,PyOverrideDecorator\n    def area(self):",
  );
  expect(apply(commented, suppressChange(commented, 2, "PyAbstractClass"))).toBe(commented.toString());
  const stacked = Text.of([
    "class Shape:",
    "    # noinspection PyAbstractClass",
    "    # keep this",
    "    def area(self):",
  ]);
  expect(apply(stacked, suppressChange(stacked, 3, "PyOverrideDecorator"))).toBe(
    "class Shape:\n    # noinspection PyAbstractClass,PyOverrideDecorator\n    # keep this\n    def area(self):",
  );
  // A comment at another indentation belongs to other code.
  expect(apply(commented, suppressChange(commented, 0, "PyAbstractClass"))).toBe(
    "# noinspection PyAbstractClass\n" + commented.toString(),
  );
});

it("offers no Suppress rows once the text has changed since the facts were read", () => {
  const doc = Text.of(["class Shape:", "    pass", "", "    @override", "    def area(self):", "        pass"]);
  const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.line(5).from + 10 } }) });
  const latest = { facts: FACTS, doc: view.state.doc };
  const rows = suppressControls(view, "builtin:python-override", latest);
  expect(rows.map((r) => r.label)).toEqual(["Suppress for statement", "Suppress for function", "Suppress for class"]);
  view.dispatch({ changes: { from: 0, insert: "import os\n" } });
  expect(suppressControls(view, "builtin:python-override", latest)).toEqual([]);
  // A row picked from a menu opened before the edit does nothing.
  rows[0]!.run();
  expect(view.state.doc.line(1).text).toBe("import os");
  view.destroy();
});

it("keeps a read-only document unchanged", () => {
  const doc = Text.of(["class Shape:", "    pass", "", "    @override", "    def area(self):", "        pass"]);
  const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.line(5).from + 10 } }) });
  const latest = { facts: FACTS, doc: view.state.doc };
  const [row] = suppressControls(view, "builtin:python-override", latest);
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  expect(suppressControls(view, "builtin:python-override", latest)).toEqual([]);
  row!.run();
  expect(view.state.doc).toBe(doc);
  view.destroy();
});
