import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentService, indentUnit } from "@codemirror/language";
import { openPopup } from "@/editor/lsp/popupStore";
import { executeAction } from "@/platform/actions";
import { clearClipboardHistory, clipboardHistory, recordClipboard } from "./clipboardHistory";
import { pasteAsPlainText, pasteFromHistory } from "./extras";
import { pasteReindentFilter } from "./cm/prefs";
import { openPasteHistory } from "./view/PasteHistoryDialog";

vi.mock("./view/PasteHistoryDialog", () => ({ openPasteHistory: vi.fn() }));
vi.mock("@/platform/actions", () => ({ executeAction: vi.fn() }));

vi.mock("@/editor/lsp/popupStore", () => ({
  caretAnchor: vi.fn(() => ({ x: 0, y: 0 })),
  openPopup: vi.fn(),
}));

let view: EditorView;
const extra: EditorView[] = [];
beforeEach(() => {
  clearClipboardHistory();
  vi.clearAllMocks();
  view = new EditorView({ state: EditorState.create({ doc: "target" }), parent: document.body });
});
afterEach(() => {
  view.destroy();
  view.dom.remove();
  extra.splice(0).forEach((v) => v.destroy());
});

it("opens the chooser and pastes its result through the existing paste path", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  recordClipboard("older");
  recordClipboard("newer\nsecond line");
  view.dispatch({ selection: { anchor: 0, head: 6 } });
  pasteFromHistory(view);
  expect(openPopup).not.toHaveBeenCalled();
  const [target, paste] = vi.mocked(openPasteHistory).mock.calls[0]!;
  expect(target).toBe(view);
  const joined = "newer\nsecond line\nolder";
  paste(joined, false);
  expect(view.state.doc.toString()).toBe(joined);
  expect(clipboardHistory()[0]).toEqual({ text: joined, linewise: false });
  expect(writeText).toHaveBeenCalledWith(joined);
  expect(view.hasFocus).toBe(true);
});

it("pastes a chosen line-wise entry above the caret line and keeps its flag", () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  recordClipboard("one", true);
  recordClipboard("selected text");
  view.dispatch({ selection: { anchor: 3 } });
  pasteFromHistory(view);
  const [, paste] = vi.mocked(openPasteHistory).mock.calls[0]!;
  paste("one", true);
  expect(view.state.doc.toString()).toBe("one\ntarget");
  expect(view.state.selection.main.head).toBe(7);
  expect(clipboardHistory()[0]).toEqual({ text: "one", linewise: true });
});

it("keeps the existing empty-history hint", () => {
  pasteFromHistory(view);
  expect(openPasteHistory).not.toHaveBeenCalled();
  expect(executeAction).toHaveBeenCalledWith("editor.showHint", {
    text: "Nothing to paste: the clipboard history is empty",
  });
});

it.each(["indentBlock", "indentEachLine"] as const)(
  "pastes line-wise as plain text without %s reformatting",
  async (mode) => {
    const text = "      a();\n          b();";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
    const v = new EditorView({
      doc: "if {\n  target\n}",
      selection: { anchor: 10 },
      extensions: [indentUnit.of("  "), indentService.of((_cx, pos) => (pos === 0 ? 0 : 2)), pasteReindentFilter(mode)],
      parent: document.body,
    });
    extra.push(v);
    recordClipboard(text, true);
    await pasteAsPlainText(v);
    expect(v.state.doc.toString()).toBe(`if {\n${text}\n  target\n}`);
    expect(v.state.selection.main.head).toBe(10 + text.length + 1);
  },
);
