import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import type { PythonFacts } from "@/platform/ipc";
import { makeStaticChanges } from "./makeStatic";

const SRC = "class C:\n    # note\n    def helper(self, x):\n        return x * 2\n";
const pos = (line: number, col: number) => ({ line, col });
const FACTS: PythonFacts = {
  suppressions: [],
  classes: [
    {
      name: "C",
      selection: { start: pos(0, 6), end: pos(0, 7) },
      definitionLine: 0,
      bases: [],
      methods: [
        {
          name: "helper",
          selection: { start: pos(2, 8), end: pos(2, 14) },
          definitionLine: 2,
          params: ["self", "x"],
          abstractMethod: false,
          overrideDecorated: false,
          body: { kind: "other" },
          unusedReceiver: { start: pos(2, 15), end: pos(2, 21) },
        },
      ],
    },
  ],
};

it("adds @staticmethod and removes the receiver", () => {
  const state = EditorState.create({ doc: SRC });
  const at = state.doc.line(3).from + 10;
  const changes = makeStaticChanges(state.doc, FACTS, at);
  expect(state.update({ changes: changes! }).state.doc.toString()).toBe(
    "class C:\n    # note\n    @staticmethod\n    def helper(x):\n        return x * 2\n",
  );
  expect(makeStaticChanges(state.doc, FACTS, 3)).toBeNull();
});
