import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import { selectableText } from "@/ui";
import type { DocBackend } from "../backend";
import { previewExtensions } from "./preview";

describe("previewExtensions", () => {
  it("keeps the read-only preview selectable and focusable", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "let a = 1;", extensions: await previewExtensions("/p/a.txt", undefined) }),
    });
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(view.contentDOM.getAttribute("tabindex")).toBe("0");
    expect(view.contentDOM.classList.contains(selectableText)).toBe(true);
    view.destroy();
  });

  it("shows a closed file in the mode it would open with", async () => {
    const backend = { uiModeOf: async () => "Angular Template" } as Partial<DocBackend> as DocBackend;
    const extensions = await previewExtensions("/p/app.html", undefined, backend);
    expect(EditorState.create({ doc: "@if (a) {}", extensions }).facet(language)?.name).toBe("angular");
  });
});
