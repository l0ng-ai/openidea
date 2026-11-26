import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { copyAs, prefsExtension } from "./prefs";
import { validateEditorExtras } from "@/platform/editorSettings";

const views: EditorView[] = [];
let copied: Map<string, string>[] = [];

/** A copy event with a writable clipboard, like the WebView's. */
function copyEvent(target: EditorView) {
  const data = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      clearData: () => data.clear(),
    },
  });
  target.contentDOM.dispatchEvent(event);
  copied.push(data);
  return data;
}

function make(richTextCopy: boolean, doc = "let a = 1;\nlet b = 2;", selection = EditorSelection.single(4, 9)) {
  const view = new EditorView({
    doc,
    selection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      prefsExtension({
        prefs: validateEditorExtras({ general: { richTextCopy } }),
        path: "/p/a.ts",
        softWrap: false,
        showWhitespace: false,
        hardWrapAt: 120,
        readOnly: false,
      }),
    ] satisfies Extension[],
    parent: document.body,
  });
  views.push(view);
  return view;
}

beforeEach(() => {
  copied = [];
  // Like the WebView: the copy event goes to the focused editor.
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => {
      const focused = document.activeElement?.closest(".cm-editor");
      if (focused instanceof HTMLElement) copyEvent(EditorView.findFromDOM(focused)!);
      return true;
    }),
  });
});
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
});

describe("Copy as Plain Text / Copy as Rich Text", () => {
  it("copies rich text once when Rich-Text Copy is off", () => {
    const view = make(false);
    copyAs(view, "rich");
    expect(document.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(copied[0]!.get("text/plain")).toBe("a = 1");
    expect(copied[0]!.get("text/html")).toMatch(/^<pre style="[^"]*">a = 1<\/pre>$/);
    // The next ordinary copy follows the setting again.
    expect(copyEvent(view).has("text/html")).toBe(false);
  });

  it("copies plain text once when Rich-Text Copy is on", () => {
    const view = make(true);
    copyAs(view, "plain");
    expect(copied[0]!.get("text/plain")).toBe("a = 1");
    expect(copied[0]!.has("text/html")).toBe(false);
    expect(copyEvent(view).get("text/html")).toContain("a = 1");
  });

  it("keeps the setting's format when it already matches", () => {
    expect(copyEvent(make(false)).has("text/html")).toBe(false);
    copyAs(views[0]!, "plain");
    expect(copied[1]!.has("text/html")).toBe(false);
    expect(copyEvent(make(true)).has("text/html")).toBe(true);
    copyAs(views[1]!, "rich");
    expect(copied[3]!.get("text/html")).toContain("a = 1");
  });

  it("copies from the editor it was run on, not the focused one", () => {
    const target = make(false);
    const other = make(false, "other text", EditorSelection.single(0, 5));
    other.focus();
    copyAs(target, "rich");
    expect(copied).toHaveLength(1);
    expect(copied[0]!.get("text/plain")).toBe("a = 1");
    expect(copied[0]!.get("text/html")).toContain("a = 1");
  });

  it("escapes markup in the rich text", () => {
    const view = make(false, "a < b && c > d", EditorSelection.single(0, 14));
    copyAs(view, "rich");
    expect(copied[0]!.get("text/html")).toContain("a &lt; b &amp;&amp; c &gt; d");
    expect(copied[0]!.get("text/plain")).toBe("a < b && c > d");
  });

  it("copies plain text without a selection or with several", () => {
    const empty = make(false, "line one\nline two", EditorSelection.single(2));
    copyAs(empty, "rich");
    expect(copied[0]!.get("text/plain")).toBe("line one");
    expect(copied[0]!.has("text/html")).toBe(false);
    const multi = make(
      false,
      "one two",
      EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    );
    copyAs(multi, "rich");
    expect(copied[1]!.has("text/html")).toBe(false);
  });

  it("does not leak the forced format when the copy command throws", () => {
    const view = make(false);
    vi.mocked(document.execCommand).mockImplementationOnce(() => {
      throw new Error("denied");
    });
    expect(() => copyAs(view, "rich")).toThrow("denied");
    expect(copyEvent(view).has("text/html")).toBe(false);
  });
});
