import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _setFocusedCellEditor } from "@/editor/api";
import { matchActions } from "@/features/search/everywhere/model";
import { allActions, executeAction, getAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { IDEA_ACTIONS } from "@/platform/ideaActions";
import { PRESETS } from "@/platform/keymap";
import { registerEditorActions } from "./actions";

let dispose: () => void;
let view: EditorView | null;

beforeEach(() => {
  dispose = registerEditorActions();
  useContextKeys.setState({ textEditorActive: true, editorTextFocus: true }, true);
});

afterEach(() => {
  dispose();
  _setFocusedCellEditor(null);
  view?.destroy();
  view?.dom.remove();
  view = null;
  useContextKeys.setState({}, true);
  _resetI18nForTests();
});

describe("Transpose action", () => {
  it("is discoverable as Transpose in Editor Actions", () => {
    expect(getAction("code.transpose")).toMatchObject({ title: "Transpose", category: "Editor Actions" });
    expect(getAction("code.transpose")?.hidden).not.toBe(true);
    expect(
      matchActions(allActions(), "Transpose", { isEnabled: () => true, recent: [] }).map((item) => item.id),
    ).toContain("code.transpose");
  });

  it("maps EditorTranspose without adding a default shortcut", () => {
    expect(IDEA_ACTIONS.EditorTranspose).toBe("code.transpose");
    for (const keymap of Object.values(PRESETS)) expect(keymap["code.transpose"] ?? []).toEqual([]);
  });

  it("runs the editing command on the focused editor", async () => {
    view = new EditorView({
      state: EditorState.create({ doc: "abcd", selection: EditorSelection.cursor(2) }),
      parent: document.body,
    });
    _setFocusedCellEditor(view);
    expect(await executeAction("code.transpose")).toBe(true);
    expect(view.state.doc.toString()).toBe("acbd");
    expect(view.state.selection.main.head).toBe(3);
  });

  it.each([
    ["en", "Transpose"],
    ["zh", "转置"],
    ["zh-TW", "轉置"],
  ])("has a searchable %s title", async (locale, title) => {
    await setLocale(locale);
    expect(getAction("code.transpose")?.title).toBe(title);
    expect(matchActions(allActions(), title, { isEnabled: () => true, recent: [] }).map((item) => item.id)).toContain(
      "code.transpose",
    );
  });
});
