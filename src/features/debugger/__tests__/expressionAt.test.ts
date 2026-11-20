import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expressionAt } from "../editor/valueTooltip";

/** The expression around the `|` in `line`. */
function at(line: string, calls: boolean) {
  const pos = line.indexOf("|");
  const view = new EditorView({ state: EditorState.create({ doc: line.replace("|", "") }) });
  const text = expressionAt(view, pos, { calls })?.text ?? null;
  view.destroy();
  return text;
}

describe("expression at the mouse for Quick Evaluate (#4772)", () => {
  it("takes the call of the clicked method, arguments included", () => {
    expect(at("String n = vo.getChd|rnum();", true)).toBe("vo.getChdrnum()");
    expect(at('x = f|(a, g(b), "c)");', true)).toBe('f(a, g(b), "c)")');
    expect(at("x = list.g|et (i);", true)).toBe("list.get (i)");
  });

  it("follows member chains through calls and indexing to the clicked member", () => {
    expect(at("a.getB().c|()", true)).toBe("a.getB().c()");
    expect(at("a.get|B().c()", true)).toBe("a.getB()");
    expect(at("items[i + 1].na|me", true)).toBe("items[i + 1].name");
    expect(at("a.b()[0].c|", true)).toBe("a.b()[0].c");
  });

  it("leaves an unbalanced call as the bare member", () => {
    expect(at("vo.getChd|rnum(a,", true)).toBe("vo.getChdrnum");
  });

  it("keeps plain hovers free of calls", () => {
    expect(at("String n = vo.getChd|rnum();", false)).toBe("vo.getChdrnum");
    expect(at("a.getB().c|()", false)).toBe("c");
  });
});
