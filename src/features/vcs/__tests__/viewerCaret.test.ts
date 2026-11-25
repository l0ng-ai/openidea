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

  it("keeps the caret with the pointer during a drag", () => {
    setAppearance({ smoothCaretMovement: true });
    const view = new EditorView({
      state: EditorState.create({ doc: "abc", extensions: viewerBase({ readOnly: true }) }),
    });
    views.push(view);
    view.coordsAtPos = () => ({ left: 0, right: 0, top: 0, bottom: 10 });
    view.scrollDOM.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    const glides = () => view.scrollDOM.querySelector(".cm-cursorLayer")!.classList.contains("cm-openidea-caretGlide");
    const measure = () => (view as unknown as { measure(): void }).measure();
    const win = view.dom.ownerDocument.defaultView!;
    const press = () => view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const release = () => win.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    press();
    view.dispatch({ selection: { anchor: 0, head: 2 }, userEvent: "select.pointer" });
    measure();
    expect(glides()).toBe(true);
    release();

    press();
    win.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 40 }));
    view.dispatch({ selection: { anchor: 1, head: 3 }, userEvent: "select.pointer" });
    measure();
    expect(glides()).toBe(false);
    release();
  });
});
