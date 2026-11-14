import { afterEach, beforeEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DecorationSet } from "@/bindings";
import { _addEditor, _removeEditor, type EditorDocContext, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { fileIconName, registerExternalIcons, themedFolderIconName } from "@/ui";
import { getFileDecoration } from "@/workbench/contributions";
import { decorationExtension, setPluginDecorations } from "../decorations";
import { capabilityDescription } from "../consent";
import { handleRuntimeEvent } from "../runtimeUi";

const ctx: EditorDocContext = { doc: 1, path: "/p/a.txt", language: "text", uiMode: null, readOnly: false };
let editor: TextEditorHandle;
const range = { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } };
const set = (root = "/p"): DecorationSet => ({
  root,
  path: "/p/a.txt",
  setId: "test",
  tree: false,
  items: [{ range, style: "highlight", hover: "hover", after: "<plain>" }],
  file: null,
});
beforeEach(() => {
  useProject.setState({ project: { root: "/p", trusted: true } as never });
  editor = {
    ctx,
    view: new EditorView({
      state: EditorState.create({
        doc: "😀text",
        extensions: [EditorState.allowMultipleSelections.of(true), decorationExtension(ctx)],
      }),
      parent: document.body,
    }),
  };
  _addEditor(editor);
});
afterEach(() => {
  setPluginDecorations("test", []);
  _removeEditor(editor);
  editor.view.destroy();
  useProject.setState({ project: null });
});

it("renders plain annotations, maps them through edits, and withdraws them", () => {
  setPluginDecorations("test", [set()]);
  expect(editor.view.dom.textContent).toContain("<plain>");
  // The range mark carries the hover on the code; the line-end message carries it too.
  expect(editor.view.dom.querySelector('[title="hover"]')?.textContent).toBe("te");
  const message = editor.view.dom.querySelector(".cm-plugin-after");
  expect(message?.firstElementChild?.textContent).toBe("<plain>");
  expect(message?.firstElementChild?.getAttribute("title")).toBe("hover");
  expect(editor.view.dom.querySelector("plain")).toBeNull();
  editor.view.dispatch({ changes: { from: 0, insert: "x" } });
  expect(editor.view.dom.querySelector('[title="hover"]')?.textContent).toBe("te");
  setPluginDecorations("test", []);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
});

it("filters tree badges by project root but not editor annotations, and drops unknown styles", () => {
  // Editor annotations follow the file: a set from another root still renders where the file is open.
  setPluginDecorations("test", [set("/other")]);
  expect(editor.view.dom.textContent).toContain("<plain>");
  const unknown = set();
  unknown.items[0]!.style = "unknown";
  setPluginDecorations("test", [unknown]);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
  // Tree badges are per root.
  const tree = { ...set("/other"), tree: true, items: [], file: { style: "modified", badge: "M", tooltip: "changed" } };
  setPluginDecorations("test", [tree]);
  expect(getFileDecoration("/p/a.txt")?.badge).toBeUndefined();
  setPluginDecorations("test", [{ ...tree, root: "/p" }]);
  expect(getFileDecoration("/p/a.txt")?.badge).toBe("M");
  setPluginDecorations("test", []);
  expect(getFileDecoration("/p/a.txt")?.badge).toBeUndefined();
});

it("shows a tree note after the name without colouring the file", () => {
  const note = {
    ...set(),
    tree: true,
    items: [],
    file: { style: "", badge: null, tooltip: "why", note: "entry point" },
  };
  setPluginDecorations("test", [note]);
  expect(getFileDecoration("/p/a.txt")).toMatchObject({ suffix: [{ text: "entry point" }], tooltip: "why" });
  expect(getFileDecoration("/p/a.txt")?.color).toBeUndefined();
  setPluginDecorations("test", []);
});

it("resolves dynamic file and folder icons declared by the plugin", () => {
  const unregister = registerExternalIcons([
    ["ext:fileIcon/test/helm-template", '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#39989F"/></svg>'],
    ["ext:fileIcon/test/helm-dir", '<svg viewBox="0 0 16 16"><rect width="16" height="16" fill="#39989F"/></svg>'],
  ]);
  try {
    setPluginDecorations("test", [
      {
        root: "/p",
        path: "/p/chart",
        setId: "icons",
        tree: true,
        items: [],
        file: { style: "", badge: null, tooltip: "Helm chart", icon: "helm-dir" },
      },
      {
        root: "/p",
        path: "/p/chart/templates/stage.yaml",
        setId: "icons",
        tree: true,
        items: [],
        file: { style: "", badge: null, tooltip: "Helm template", icon: "helm-template" },
      },
    ]);
    expect(themedFolderIconName("chart", false, false, "/p/chart")).toBe("ext:fileIcon/test/helm-dir");
    expect(fileIconName("stage.yaml", "/p/chart/templates/stage.yaml")).toBe("ext:fileIcon/test/helm-template");
    expect(getFileDecoration("/p/chart")?.tooltip).toBe("Helm chart");
    setPluginDecorations("test", []);
    expect(themedFolderIconName("chart", false, false, "/p/chart")).toBeNull();
    expect(fileIconName("stage.yaml", "/p/chart/templates/stage.yaml")).toBe("file-yaml");
  } finally {
    unregister();
  }
});

it("selects UTF-16 ranges and reveals without changing text", () => {
  handleRuntimeEvent({ type: "editorRanges", path: ctx.path, ranges: [range], reveal: false });
  expect(editor.view.state.selection.main.from).toBe(2);
  expect(editor.view.state.selection.main.to).toBe(4);
  handleRuntimeEvent({ type: "editorRanges", path: ctx.path, ranges: [range], reveal: true });
  expect(editor.view.state.doc.toString()).toBe("😀text");
  handleRuntimeEvent({
    type: "editorRanges",
    path: "/other/a.txt",
    ranges: [{ start: { line: 0, col: 0 }, end: { line: 0, col: 1 } }],
    reveal: false,
  });
  expect(editor.view.state.selection.main.from).toBe(2);
});

it("describes ide.commands explicitly in consent", () => {
  const description = capabilityDescription({
    id: "ide.commands",
    description: "",
    optional: false,
    granted: false,
    risk: "high",
  });
  expect(description).toContain("including running programs, committing and pushing");
});
