import { describe, expect, it } from "vitest";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { TreeFragment } from "@lezer/common";

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

/** `count` documented classes: as many top-level statements, each after a doc comment longer than the parser's look-ahead margin. */
function documentedClasses(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `/** Repository for entity ${i}, with a comment long enough to look ahead of. */\n` +
      `export class Repository${i}<T extends { id: number }> {\n` +
      `  find(id: number): T | undefined {\n    return this.items.get(id)\n  }\n}\n\n`,
  ).join("");
}

const parser = javascript({ typescript: true }).language.parser;

/** Inserts `insert` at `at`, re-parsing incrementally from `tree`; returns the new tree and how many parser steps that took. */
function reparse(doc: string, tree: ReturnType<typeof parser.parse>, at: number, insert: string) {
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
    { fromA: at, toA: at, fromB: at, toB: at + insert.length },
  ]);
  const edited = doc.slice(0, at) + insert + doc.slice(at);
  const parse = parser.startParse(edited, fragments);
  let steps = 0;
  let result = null;
  while (!(result = parse.advance())) steps++;
  return { doc: edited, tree: result, steps };
}

describe("incremental parsing of long statement lists", () => {
  // A repeat group's look-ahead was that of the whole list, ending at the last doc comment: no group before an
  // edit could be reused, so typing cost grew with the position in the file, one statement at a time.
  it("takes as many parser steps in a long file as in a short one", () => {
    const steps = (count: number) => {
      const doc = documentedClasses(count);
      const at = doc.indexOf("return", doc.length >> 1);
      return reparse(doc, parser.parse(doc), at, "a").steps;
    };
    const short = steps(100);
    const long = steps(1600);
    expect(long).toBeLessThan(short * 2);
  });

  it("matches a fresh parse wherever the edit is", () => {
    const doc = documentedClasses(300);
    const tree = parser.parse(doc);
    const edits: Array<[string, string]> = [
      ["/**", "a"],
      ["return", "a"],
      ["export class Repository150", "// "],
      ["}\n\n/** Repository for entity 299", "}"],
      ["find(id", "static "],
    ];
    for (const [anchor, insert] of edits) {
      const at = doc.indexOf(anchor) + (anchor.startsWith("}") ? 0 : 0);
      const result = reparse(doc, tree, at, insert);
      expect(result.tree.toString(), `after inserting ${JSON.stringify(insert)} before ${JSON.stringify(anchor)}`).toBe(
        parser.parse(result.doc).toString(),
      );
    }
  });
});
