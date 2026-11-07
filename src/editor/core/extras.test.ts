import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { indentService, indentUnit } from "@codemirror/language";
import { closePopup, useLspPopup } from "@/editor/lsp/popupStore";
import { clearClipboardHistory, clipboardHistory, recordClipboard } from "./clipboardHistory";
import { pasteAsPlainText, pasteFromHistory } from "./extras";
import { pasteReindentFilter } from "./cm/prefs";

const views: EditorView[] = [];
beforeEach(() => clearClipboardHistory());
afterEach(() => {
  closePopup();
  views.splice(0).forEach((view) => view.destroy());
  vi.restoreAllMocks();
});

describe("paste actions", () => {
  it("pastes an older line-wise history entry and preserves its flag when promoted", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = new EditorView({ doc: "target", selection: { anchor: 3 }, parent: document.body });
    views.push(view);
    recordClipboard("one", true);
    recordClipboard("selected text");

    pasteFromHistory(view);
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("list");
    if (popup?.kind !== "list") throw new Error("Missing clipboard history popup");
    await popup.items[1]!.run();

    expect(view.state.doc.toString()).toBe("one\ntarget");
    expect(view.state.selection.main.head).toBe(7);
    expect(clipboardHistory()[0]).toEqual({ text: "one", linewise: true });
    expect(writeText).toHaveBeenCalledWith("one");
  });

  it.each(["indentBlock", "indentEachLine"] as const)(
    "pastes line-wise as plain text without %s reformatting",
    async (mode) => {
      const text = "      a();\n          b();";
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
      const view = new EditorView({
        doc: "if {\n  target\n}",
        selection: { anchor: 10 },
        extensions: [
          indentUnit.of("  "),
          indentService.of((_cx, pos) => (pos === 0 ? 0 : 2)),
          pasteReindentFilter(mode),
        ],
        parent: document.body,
      });
      views.push(view);
      recordClipboard(text, true);

      await pasteAsPlainText(view);

      expect(view.state.doc.toString()).toBe(`if {\n${text}\n  target\n}`);
      expect(view.state.selection.main.head).toBe(10 + text.length + 1);
    },
  );
});
