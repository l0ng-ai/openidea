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

const setAppearance = (appearance: object) =>
  useProject.setState({ settings: { editor: { appearance } } as unknown as Settings });

describe("viewer caret", () => {
  it("follows the editor's caret settings, also when they change", () => {
    setAppearance({ blockCaret: true });
    const view = new EditorView({
      state: EditorState.create({ doc: "a", extensions: viewerBase({ readOnly: true }) }),
    });
    views.push(view);
    expect(view.dom.classList.contains("cm-openidea-blockCaret")).toBe(true);

    setAppearance({ blockCaret: false, smoothCaretMovement: true, caretMovementStyle: "gliding" });
    expect(view.dom.classList.contains("cm-openidea-blockCaret")).toBe(false);
    expect(view.dom.classList.contains("cm-openidea-caretMotion-gliding")).toBe(true);
  });
});
