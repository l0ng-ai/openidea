import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { StructuralRanges, SyntaxNode } from "@/bindings";
import { offsetToPos } from "@/editor/api";
import { multiLineStatement } from "../editor";

const DOC = "fun f() {\n    if (a) {\n        b()\n    }\n    c(); d()\n}\n";

function node(s: EditorState, snippet: string, hasError = false): SyntaxNode {
  const from = s.doc.toString().indexOf(snippet);
  return {
    kind: "statement",
    range: { start: offsetToPos(s.doc, from), end: offsetToPos(s.doc, from + snippet.length) },
    field: null,
    named: true,
    error: false,
    missing: false,
    hasError,
  };
}

const ranges = (r: Partial<StructuralRanges>): StructuralRanges => ({
  selection: [],
  statement: null,
  prevStatement: null,
  nextStatement: null,
  block: null,
  declaration: null,
  prevDeclaration: null,
  nextDeclaration: null,
  ...r,
});

describe("multiLineStatement (Surround With target)", () => {
  const s = EditorState.create({ doc: DOC });

  it("takes the whole lines of a multi-line statement", () => {
    const r = ranges({ statement: node(s, "if (a) {\n        b()\n    }"), declaration: node(s, DOC.trimEnd()) });
    expect(multiLineStatement(s, r)).toEqual({ from: s.doc.line(2).from, to: s.doc.line(4).to });
  });

  it("leaves single-line, broken and line-sharing statements to the line logic", () => {
    expect(multiLineStatement(s, ranges({ statement: node(s, "b()") }))).toBeNull();
    expect(multiLineStatement(s, ranges({ statement: node(s, "if (a) {\n        b()\n    }", true) }))).toBeNull();
    expect(multiLineStatement(s, ranges({ statement: node(s, "c(); d()") }))).toBeNull();
    expect(multiLineStatement(s, null)).toBeNull();
  });
});
