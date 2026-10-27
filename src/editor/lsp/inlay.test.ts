import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { InlayHint } from "@/bindings";

const openFile = vi.fn(async () => undefined);
vi.mock("@/workbench/contributions", async (orig) => {
  const actual = await orig<typeof import("@/workbench/contributions")>();
  return { ...actual, maybeEditorService: () => ({ openFile }) };
});

const { inlayDecorations, inlayMenuItems } = await import("./inlay");
const { usePlatform } = await import("@/platform/platformInfo");
const { useContextMenuStore } = await import("@/ui");

const hint: InlayHint = {
  position: { line: 0, col: 5 },
  label: ": Foo",
  kind: "type",
  paddingLeft: false,
  paddingRight: false,
  tooltip: null,
  parts: [
    { value: ": ", tooltip: null, location: null },
    {
      value: "Foo",
      tooltip: "struct Foo",
      location: { path: "/p/foo.rs", range: { start: { line: 4, col: 7 }, end: { line: 4, col: 10 } } },
    },
  ],
};

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
});

function editorWith(hints: InlayHint[]) {
  const view = new EditorView({ state: EditorState.create({ doc: "let x = foo();" }), parent: document.body });
  views.push(view);
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(inlayDecorations(view, hints))) });
  return view;
}

describe("inlay hints", () => {
  it("renders label parts; ⌘-click on a part with a location navigates there", () => {
    const view = editorWith([hint]);
    const part = view.dom.querySelector<HTMLElement>(".cm-lsp-inlay-part")!;
    expect(part.textContent).toBe("Foo");
    expect(part.title).toBe("struct Foo");
    expect(view.dom.querySelector(".cm-lsp-inlay")!.textContent).toBe(": Foo");
    part.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(openFile).not.toHaveBeenCalled();
    usePlatform.setState({ os: "windows" });
    // ⌘ is not the navigation modifier off macOS.
    part.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
    expect(openFile).not.toHaveBeenCalled();
    part.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    expect(openFile).toHaveBeenCalledWith("/p/foo.rs", { selection: { line: 4, col: 7 }, focus: true });
  });

  it("offers to disable hints of the clicked kind", () => {
    const view = editorWith([hint]);
    view.dom.querySelector(".cm-lsp-inlay")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items = useContextMenuStore.getState().menu?.items ?? [];
    expect(items.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "Disable Type hints",
      "separator",
      "Inlay Hints Settings…",
    ]);
    expect((inlayMenuItems("parameter")[0] as { label: string }).label).toBe("Disable Parameter name hints");
  });
});
