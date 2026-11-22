import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { enterAfterDocLineComment } from "./comments";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function enter(doc: string, language: string): string | null {
  const anchor = doc.indexOf("|");
  const v = new EditorView({ state: EditorState.create({ doc: doc.replace("|", ""), selection: { anchor } }) });
  views.push(v);
  if (!enterAfterDocLineComment(language)(v)) return null;
  const s = v.state;
  const h = s.selection.main.head;
  return s.sliceDoc(0, h) + "|" + s.sliceDoc(h);
}

describe("Enter after a documentation line comment", () => {
  it("continues /// and //! in Rust", () => {
    expect(enter("/// Summary|\nfn f() {}", "rust")).toBe("/// Summary\n/// |\nfn f() {}");
    expect(enter("    //! Crate docs|", "rust")).toBe("    //! Crate docs\n    //! |");
    expect(enter("/// Summary|", "csharp")).toBe("/// Summary\n/// |");
  });

  it("leaves plain comments, mid-line carets and other languages alone", () => {
    expect(enter("// note|", "rust")).toBeNull();
    expect(enter("//// banner|", "rust")).toBeNull();
    expect(enter("/// Sum|mary", "rust")).toBeNull();
    expect(enter("/// Summary|", "go")).toBeNull();
  });
});
