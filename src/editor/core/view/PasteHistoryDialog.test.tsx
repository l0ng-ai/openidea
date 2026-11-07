import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { executeAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { applyKeymapSettings, installKeyboardDispatcher } from "@/platform/keymap";
import { clearClipboardHistory, clipboardHistory, recordClipboard } from "../clipboardHistory";
import { compartments, fontExtension } from "../cm/setup";
import { PasteHistoryDialogHost, openPasteHistory, registerPasteHistoryActions } from "./PasteHistoryDialog";

let view: EditorView;
let paste: ReturnType<typeof vi.fn<(text: string, linewise: boolean) => void>>;
let disposeActions: () => void;
beforeEach(() => {
  disposeActions = registerPasteHistoryActions();
  applyKeymapSettings(undefined, undefined);
  clearClipboardHistory();
  paste = vi.fn();
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "target",
      extensions: [javascript(), compartments.font.of(fontExtension({ fontSize: 17 }))],
    }),
  });
});
afterEach(() => {
  if (screen.queryByRole("dialog")) fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  disposeActions();
  view.destroy();
  view.dom.remove();
});

function open(...entries: string[]) {
  for (const entry of entries.toReversed()) recordClipboard(entry);
  view.focus();
  render(<PasteHistoryDialogHost />);
  act(() => openPasteHistory(view, paste));
  return screen.getByRole("textbox", { name: "Filter clipboard history" });
}

function options() {
  return screen.getAllByRole("option");
}

function chosen() {
  return options().filter((row) => row.getAttribute("aria-selected") === "true");
}

describe("Paste from History chooser", () => {
  it("shows newest first and a read-only preview with the target grammar and editor font", () => {
    open("const newest = 1;\n// detail", "older");
    expect(options().map((row) => row.textContent)).toEqual(["const newest = 1;2 lines", "older1 line"]);
    const content = screen.getByLabelText("Paste preview");
    expect(content).toHaveAttribute("contenteditable", "false");
    expect(content).toHaveAttribute("tabindex", "0");
    const preview = EditorView.findFromDOM(content)!;
    expect(preview.state.readOnly).toBe(true);
    expect(preview.state.facet(language)?.name).toBe("javascript");
    expect(preview.dom.style.getPropertyValue("--openidea-editor-font-size")).toBe("17px");
    expect(preview.state.doc.toString()).toBe("const newest = 1;\n// detail");
    expect(content.querySelector("span")).not.toBeNull();
    fireEvent.click(options()[1]!);
    expect(EditorView.findFromDOM(screen.getByLabelText("Paste preview"))!.state.doc.toString()).toBe("older");
    expect(paste).not.toHaveBeenCalled();
  });

  it("filters full contents as you type and resets selection, including empty results", () => {
    const search = open("newest", "first line\nHidden Needle", "oldest");
    fireEvent.change(search, { target: { value: "needle" } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent("first line");
    expect(chosen()).toHaveLength(1);
    fireEvent.change(search, { target: { value: "absent" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste" })).toBeDisabled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(paste).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: "" } });
    expect(options()).toHaveLength(3);
    expect(chosen()[0]).toBe(options()[0]);
  });

  it("pastes Cmd-click selections in list order and restores editor focus", async () => {
    open("newest", "middle", "oldest");
    fireEvent.click(options()[2]!);
    fireEvent.click(options()[0]!, { metaKey: true });
    expect(chosen()).toEqual([options()[0], options()[2]]);
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(paste).toHaveBeenCalledExactlyOnceWith("newest\noldest", false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(view.hasFocus).toBe(true));
  });

  it("extends and shrinks selection with Shift+Arrow from the search field", () => {
    const search = open("newest", "middle", "oldest");
    fireEvent.keyDown(search, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(search, { key: "ArrowDown", shiftKey: true });
    expect(chosen()).toHaveLength(3);
    fireEvent.keyDown(search, { key: "ArrowUp", shiftKey: true });
    expect(chosen()).toHaveLength(2);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(paste).toHaveBeenCalledExactlyOnceWith("newest\nmiddle", false);
  });

  it("supports Shift-click and keyboard navigation in the list", () => {
    open("newest", "middle", "oldest");
    fireEvent.click(options()[2]!, { shiftKey: true });
    expect(chosen()).toHaveLength(3);
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowUp", shiftKey: true });
    expect(chosen()).toHaveLength(2);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(paste).toHaveBeenCalledExactlyOnceWith("newest\nmiddle", false);
  });

  it("deletes selected entries, selects a neighbour, and handles removing the last entry", () => {
    const search = open("newest", "middle", "oldest");
    fireEvent.click(options()[2]!, { metaKey: true });
    fireEvent.keyDown(search, { key: "Delete" });
    expect(clipboardHistory().map((e) => e.text)).toEqual(["middle"]);
    expect(chosen()[0]).toHaveTextContent("middle");
    fireEvent.keyDown(search, { key: "Backspace" });
    expect(clipboardHistory().map((e) => e.text)).toEqual([]);
    expect(screen.getByText("Nothing to paste: the clipboard history is empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(paste).not.toHaveBeenCalled();
  });

  it("deletes only matching selections while allowing Backspace to edit the filter", () => {
    const search = open("keep", "delete this", "also keep");
    fireEvent.change(search, { target: { value: "delete" } });
    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    fireEvent(search, event);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardHistory()).toHaveLength(3);
    fireEvent.keyDown(search, { key: "Delete" });
    expect(clipboardHistory().map((e) => e.text)).toEqual(["keep", "also keep"]);
    fireEvent.change(search, { target: { value: "" } });
    expect(chosen()[0]).toHaveTextContent("keep");
  });

  it("pastes on double-click while single-click only selects", () => {
    open("newest", "oldest");
    fireEvent.click(options()[1]!, { detail: 1 });
    expect(paste).not.toHaveBeenCalled();
    fireEvent.click(options()[1]!, { detail: 2 });
    expect(paste).toHaveBeenCalledExactlyOnceWith("oldest", false);
  });

  it("returns focus on Escape without pasting and ignores IME commit keys", async () => {
    const search = open("newest", "oldest");
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229 });
    expect(paste).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(view.hasFocus).toBe(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(paste).not.toHaveBeenCalled();
  });

  it("scopes chooser actions and default shortcuts to the dialog", async () => {
    const disposeKeyboard = installKeyboardDispatcher();
    try {
      expect(await executeAction("editor.pasteHistory.remove")).toBe(false);
      open("newest", "oldest");
      const list = screen.getByRole("listbox");
      act(() => list.focus());
      fireEvent.keyDown(list, { key: "Backspace" });
      expect(clipboardHistory().map((e) => e.text)).toEqual(["oldest"]);
      fireEvent.keyDown(list, { key: "Enter" });
      expect(paste).toHaveBeenCalledExactlyOnceWith("oldest", false);
      expect(getContext().pasteHistoryOpen).toBe(false);
      expect(getContext().pasteHistoryListFocus).toBe(false);
    } finally {
      disposeKeyboard();
    }
  });

  it("resets the chooser when opened again while already shown", () => {
    const search = open("newest", "oldest");
    fireEvent.change(search, { target: { value: "oldest" } });
    act(() => openPasteHistory(view, paste));
    const reopened = screen.getByRole("textbox", { name: "Filter clipboard history" });
    expect(reopened).toHaveValue("");
    fireEvent.keyDown(reopened, { key: "Enter" });
    expect(paste).toHaveBeenCalledExactlyOnceWith("newest", false);
  });

  it.each(["read-only", "closed"])("does not paste into an editor that became %s", (state) => {
    const search = open("newest");
    if (state === "read-only") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    else view.dom.remove();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(paste).not.toHaveBeenCalled();
  });
});
