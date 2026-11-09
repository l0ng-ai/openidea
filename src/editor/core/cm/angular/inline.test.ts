import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "../languages";
import { angular } from "./index";

async function inlineSupport() {
  return (await loadSupport(findLanguageDescription("Angular TypeScript", "/p/app.ts")!))!;
}

const highlighter = tagHighlighter([
  { tag: t.tagName, class: "tag" },
  { tag: t.attributeName, class: "attr" },
  { tag: t.variableName, class: "var" },
  { tag: t.controlKeyword, class: "control" },
  { tag: t.definitionKeyword, class: "definition" },
  { tag: t.string, class: "string" },
]);

function tokens(state: EditorState) {
  const out: string[] = [];
  highlightTree(ensureSyntaxTree(state, state.doc.length, 5000)!, highlighter, (from, to, cls) =>
    out.push(`${state.sliceDoc(from, to)}:${cls}`),
  );
  return out;
}

function type(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" });
  if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, insert))) view.dispatch(insert());
}

function editor(marked: string, extensions: Extension) {
  const pos = marked.indexOf("|");
  return new EditorView({
    state: EditorState.create({
      doc: marked.replace("|", ""),
      selection: { anchor: pos },
      extensions,
    }),
  });
}

describe("Angular inline templates", () => {
  it.each(["`", "'", '"'])("highlights a %s-quoted component template", async (quote) => {
    const template = '<div [title]="name">{{ name }} @if (ready) {} @for (x of xs; track x) {} @let y = count;</div>';
    const body = quote === '"' ? template.replaceAll('"', "'") : template;
    const state = EditorState.create({
      doc: `@Component({ template: ${quote}${body}${quote} }) class App {}`,
      extensions: await inlineSupport(),
    });
    expect(tokens(state)).toEqual(
      expect.arrayContaining(["div:tag", "title:attr", "name:var", "@if:control", "@for:control", "@let:definition"]),
    );
  });

  it.each([
    "const x = { template: `<div>{{ name }}</div>` };",
    "@Other({ template: `<div>{{ name }}</div>` }) class App {}",
    "@Component({ nested: { template: `<div>{{ name }}</div>` } }) class App {}",
    "@Component({ templateUrl: `<div>{{ name }}</div>` }) class App {}",
    "Component({ template: `<div>{{ name }}</div>` });",
    "@Component({ template: `<div>${name}</div>` }) class App {}",
    "@Component({ template: `<div>` + suffix }) class App {}",
  ])("keeps unrelated strings plain: %s", async (doc) => {
    expect(tokens(EditorState.create({ doc, extensions: await inlineSupport() }))).not.toContain("div:tag");
  });

  it("keeps ordinary TypeScript projects plain", async () => {
    const support = await loadSupport(findLanguageDescription("TypeScript", "/p/app.ts")!);
    expect(
      tokens(EditorState.create({ doc: "@Component({ template: `<div/>` }) class App {}", extensions: support! })),
    ).not.toContain("div:tag");
  });

  it("supports quoted metadata keys and namespace decorators", async () => {
    const state = EditorState.create({
      doc: '@ng.Component({ "template": `<r-card/>` }) class App {}',
      extensions: await inlineSupport(),
    });
    expect(tokens(state)).toContain("r-card:tag");
  });

  it.each([
    "@Component(/* metadata */ { template /* key */ : /* value */ `<div/>` }) class App {}",
    "@Component({ template: `<div",
    "@Component({ template: '<div",
  ])("highlights unfinished and commented templates: %s", async (doc) => {
    expect(tokens(EditorState.create({ doc, extensions: await inlineSupport() }))).toContain("div:tag");
  });

  it("matches a fresh parse after editing templates and decorator context", async () => {
    const extensions = await inlineSupport();
    let state = EditorState.create({
      doc: "@Component({ template: `<div>{{ name }}</div>` }) class App {}",
      extensions,
    });
    for (const [search, replacement] of [
      ["name", "user.name"],
      ["Component", "Other"],
      ["Other", "Component"],
      ["template:", "other:"],
    ]) {
      const from = state.doc.toString().indexOf(search!);
      state = state.update({ changes: { from, to: from + search!.length, insert: replacement } }).state;
      expect(tokens(state)).toEqual(tokens(EditorState.create({ doc: state.doc, extensions })));
    }
  });
});

describe.each(["inline", "external"])("Angular tag closing (%s)", (mode) => {
  async function support() {
    return mode === "inline" ? inlineSupport() : angular();
  }
  function wrap(template: string) {
    return mode === "inline" ? `@Component({ template: \`${template}\` }) class App {}` : template;
  }

  it.each([
    ["<div|", ">", "<div></div>"],
    ["<div><|", "/", "<div></div>"],
    ["<r-card|", "/", "<r-card/>"],
    ["<r-card|>", "/", "<r-card/>"],
    ["<input|", ">", "<input>"],
    ['<r-card title="a/b|"', "/", '<r-card title="a/b/"'],
    ["<!-- <r-card| -->", "/", "<!-- <r-card/ -->"],
    ["{{ count |}}", "/", "{{ count /}}"],
  ])("handles %s + %s", async (before, text, after) => {
    const view = editor(wrap(before), await support());
    try {
      type(view, text);
      expect(view.state.doc.toString()).toBe(wrap(after));
    } finally {
      view.destroy();
    }
  });

  it("closes tags at multiple cursors in one undoable input", async () => {
    const doc = wrap("<r-card\n<app-item");
    const ranges = [doc.indexOf("<r-card") + 7, doc.indexOf("<app-item") + 9].map((p) => EditorSelection.cursor(p));
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.create(ranges),
        extensions: [await support(), history(), EditorState.allowMultipleSelections.of(true)],
      }),
    });
    try {
      type(view, "/");
      expect(view.state.doc.toString()).toBe(wrap("<r-card/>\n<app-item/>"));
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });
});
