import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DecorationSet } from "@/bindings";
import { _addEditor, _removeEditor, type EditorDocContext, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { getFileDecoration } from "@/workbench/contributions";
import { decorationExtension, setPluginDecorations } from "../decorations";
import { capabilityDescription } from "../consent";
import { handleRuntimeEvent } from "../runtimeUi";

const ctx: EditorDocContext = {
  doc: 1,
  path: "/p/a.txt",
  language: "text",
  uiMode: null,
  readOnly: false,
};
let editor: TextEditorHandle;
const range = { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } };
const set = (root = "/p"): DecorationSet => ({
  root,
  path: "/p/a.txt",
  setId: "test",
  tree: false,
  items: [
    {
      range,
      style: "highlight",
      hover: "hover",
      after: "<plain>",
      markdownHover: null,
    },
  ],
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
  expect(editor.view.dom.querySelector('[title="hover"]')?.textContent).toBe("te");
  expect(editor.view.dom.querySelector("plain")).toBeNull();
  editor.view.dispatch({ changes: { from: 0, insert: "x" } });
  expect(editor.view.dom.querySelector('[title="hover"]')?.textContent).toBe("te");
  setPluginDecorations("test", []);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
});

it("renders a Markdown hover card instead of the native tooltip", async () => {
  setPluginDecorations("test", [
    {
      ...set(),
      items: [
        {
          range,
          style: "highlight",
          hover: "plain tooltip",
          after: " + model",
          markdownHover: "**model** card",
        },
      ],
    },
  ]);
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  expect(label.getAttribute("title")).toBeNull();
  expect(editor.view.dom.querySelector('[title="plain tooltip"]')).toBeNull();

  vi.useFakeTimers();
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  const card = document.querySelector(".cm-tooltip .cm-lsp-hover");
  expect(card?.textContent).toContain("model");
  vi.useRealTimers();
});

it("keeps the Markdown hover after the caret moves", async () => {
  setPluginDecorations("test", [
    {
      ...set(),
      items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover: "**model** card" }],
    },
  ]);
  // A click or arrow key is an ordinary selection transaction.
  editor.view.dispatch({ selection: { anchor: 0 } });

  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector(".cm-tooltip .cm-lsp-hover")?.textContent).toContain("model");
  vi.useRealTimers();
});

it("keeps the Markdown hover after an edit shifts the label", async () => {
  setPluginDecorations("test", [
    {
      ...set(),
      items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover: "**model** card" }],
    },
  ]);
  editor.view.dispatch({ changes: { from: 0, insert: "xy" } });

  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector(".cm-tooltip .cm-lsp-hover")?.textContent).toContain("model");
  vi.useRealTimers();
});

it("updates an open hover card when the plugin loads the conversation", async () => {
  const item = (markdownHover: string) => ({
    ...set(),
    items: [{ range, style: "highlight", hover: null, after: " + model", markdownHover }],
  });
  setPluginDecorations("test", [item("**model** is loading…")]);
  vi.useFakeTimers();
  const label = [...editor.view.dom.querySelectorAll("span")].find((span) => span.textContent === " + model")!;
  label.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  await vi.advanceTimersByTimeAsync(400);
  const card = document.querySelector(".cm-tooltip .cm-lsp-hover")!;
  expect(card.textContent).toContain("loading");

  // Hydration finishes while the card is open; the same card shows it.
  setPluginDecorations("test", [item("the real conversation")]);
  expect(card.textContent).toContain("the real conversation");
  vi.useRealTimers();
});

it("filters project roots and unknown styles and replaces tree badges", () => {
  setPluginDecorations("test", [set("/other")]);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
  const unknown = set();
  unknown.items[0]!.style = "unknown";
  setPluginDecorations("test", [unknown]);
  expect(editor.view.dom.textContent).not.toContain("<plain>");
  const tree = {
    ...set(),
    tree: true,
    items: [],
    file: { style: "modified", badge: "M", tooltip: "changed" },
  };
  setPluginDecorations("test", [tree]);
  expect(getFileDecoration("/p/a.txt")?.badge).toBe("M");
  setPluginDecorations("test", []);
  expect(getFileDecoration("/p/a.txt")?.badge).toBeUndefined();
});

it("selects UTF-16 ranges and reveals without changing text", () => {
  handleRuntimeEvent({
    type: "editorRanges",
    path: ctx.path,
    ranges: [range],
    reveal: false,
  });
  expect(editor.view.state.selection.main.from).toBe(2);
  expect(editor.view.state.selection.main.to).toBe(4);
  handleRuntimeEvent({
    type: "editorRanges",
    path: ctx.path,
    ranges: [range],
    reveal: true,
  });
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
