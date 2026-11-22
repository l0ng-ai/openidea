import { describe, expect, it } from "vitest";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";

/** Functions with long doc comments: re-parsing reuses a whole comment as one node. */
const source = Array.from(
  { length: 5 },
  (_, i) =>
    `/**\n${Array.from({ length: 40 }, (_, j) => ` * line ${j} of the comment on f${i}\n`).join("")} */\n` +
    `export const f${i} = (a, b = {}) => {\n    // body\n    if (a) return b\n    return a\n}\n\n`,
).join("");

describe("incremental parsing (#4468)", () => {
  it("keeps a reused comment out of the declaration before it", () => {
    let state = EditorState.create({ doc: source, extensions: [javascript()] });
    ensureSyntaxTree(state, state.doc.length, 5000);
    // Reindenting, as a formatter does.
    const at = source.indexOf("    // body");
    state = state.update({ changes: { from: at, to: at + 4, insert: "  " } }).state;
    const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
    const fresh = javascript().language.parser.parse(state.doc.toString());
    expect(tree.toString()).toBe(fresh.toString());
    expect(tree.topNode.firstChild?.name).toBe("BlockComment");
    expect(tree.topNode.firstChild?.from).toBe(0);
  });
});
