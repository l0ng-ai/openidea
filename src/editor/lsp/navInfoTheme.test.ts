import { afterEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lspTheme } from "./theme";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

it("draws the ⌘-hover info as a popup in a view without the editor theme", () => {
  // Diff viewers declare a dark theme and leave out the editor's `.cm-tooltip` rule.
  view = new EditorView({
    state: EditorState.create({ extensions: [EditorView.theme({}, { dark: true }), lspTheme] }),
    parent: document.body,
  });
  const info = document.createElement("div");
  info.className = "cm-tooltip cm-lsp-hover cm-lsp-nav-info";
  view.dom.appendChild(info);
  const style = getComputedStyle(info);
  expect(style.backgroundColor).toBe("var(--bg-popup)");
  expect(style.color).toBe("var(--fg)");
  expect(style.width).toBe("max-content");
  expect(style.borderRadius).toBe("var(--radius-popup-large)");
  expect(style.overflow).toBe("visible");
});
