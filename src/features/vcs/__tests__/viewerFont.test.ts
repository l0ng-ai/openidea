import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useProject } from "@/platform/project";
import type { Settings } from "@/platform/ipc";
import { viewerBase } from "../cm";

const previous = useProject.getState().settings;
const views: EditorView[] = [];

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  useProject.setState({ settings: previous });
});

const setEditor = (editor: object) => useProject.setState({ settings: { editor } as unknown as Settings });

describe("viewer font", () => {
  it("follows the editor's font settings, also when they change", () => {
    setEditor({ fontFamily: "Fira Code", fontSize: 16, lineHeight: 22 });
    const view = new EditorView({
      state: EditorState.create({ doc: "a", extensions: viewerBase({ readOnly: true }) }),
    });
    views.push(view);
    const style = () => view.dom.style;
    expect(style().getPropertyValue("--openidea-editor-font")).toContain("Fira Code");
    expect(style().getPropertyValue("--openidea-editor-font-size")).toBe("16px");
    expect(style().getPropertyValue("--openidea-editor-line-height")).toBe("22px");
    expect(view.dom.classList.contains("cm-openidea-ligatures")).toBe(false);

    setEditor({ fontSize: 11, ligatures: true });
    expect(style().getPropertyValue("--openidea-editor-font")).toBe("");
    expect(style().getPropertyValue("--openidea-editor-font-size")).toBe("11px");
    expect(view.dom.classList.contains("cm-openidea-ligatures")).toBe(true);
  });
});
