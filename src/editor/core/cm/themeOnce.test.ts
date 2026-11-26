// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { breakpointGutter } from "@/features/debugger/editor/breakpointGutter";
import { indexedMarkers } from "@/features/plugins/indexedMarkers";
import { inlineBlame } from "@/features/vcs/inlineBlame";
import { iconAreaExtension } from "./iconArea";

const ctx: EditorDocContext = { doc: 1, path: "/p/A.java", language: "java", uiMode: null, readOnly: false };
const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function cssRules(): number {
  let n = 0;
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) n += sheet.cssRules.length;
  return n;
}

function mount(extensions: Extension): void {
  const parent = document.createElement("div");
  document.body.append(parent);
  views.push(new EditorView({ state: EditorState.create({ doc: "a\nb", extensions }), parent }));
}

// A theme built inside an extension factory mounts new CSS rules for every editor that calls it.
// The rules are never removed, and each insertion makes the browser restyle the whole document.
it.each([
  ["breakpointGutter", () => breakpointGutter(ctx)],
  ["inlineBlame", () => inlineBlame(ctx)],
  ["indexedMarkers", () => [iconAreaExtension, indexedMarkers(ctx.path)]],
])("%s mounts its theme once, however many editors use it", (_name, extensions) => {
  mount(extensions());
  const after = cssRules();
  mount(extensions());
  mount(extensions());
  expect(cssRules()).toBe(after);
});
