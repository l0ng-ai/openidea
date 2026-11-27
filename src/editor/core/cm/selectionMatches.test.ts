import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorSettings } from "@/platform/ipc";
import { selectionMatches } from "./selectionMatches";
import { heavyExtension } from "./setup";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function mount(doc: string, selection: EditorSelection, extensions: Extension = selectionMatches()) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [EditorState.allowMultipleSelections.of(true), extensions],
    }),
    parent,
  });
  views.push(v);
  return v;
}

const matches = (v: EditorView) => [...v.contentDOM.querySelectorAll(".cm-selectionMatch")].map((el) => el.textContent);

describe("selectionMatches", () => {
  it("highlights other occurrences of a non-whitespace selection without marking the selection itself", () => {
    const doc = "  foo\n    foo\n  foobar";
    const v = mount(doc, EditorSelection.single(2, 5));
    expect(matches(v)).toEqual(["foo", "foo"]);
  });

  it.each([
    ["spaces", "  a\n  b\n    c", 0, 2],
    ["four spaces", "    a\n    b\n    c", 0, 4],
    ["tabs", "\t\ta\n\t\tb\n\t\tc", 0, 2],
    ["mixed spaces, tabs, and newlines", " \t\n \ta\n \t\n \tb", 0, 5],
  ])("skips whitespace-only selections (%s)", (_label, doc, from, to) => {
    const v = mount(doc, EditorSelection.single(from, to));
    expect(matches(v)).toEqual([]);
  });

  it("still highlights selections containing both whitespace and non-whitespace", () => {
    const doc = "  a: 1\n  a: 2\n  a: 3";
    const v = mount(doc, EditorSelection.single(0, 4)); // "  a:"
    expect(matches(v)).toEqual(["  a:", "  a:"]);
  });

  it("respects minSelectionLength, max length, multiple selections, and maxMatches", () => {
    const doc = "ab ab ab ab";
    // Below minSelectionLength (default 2)
    expect(matches(mount(doc, EditorSelection.single(0, 1)))).toEqual([]);
    // Multiple selections
    expect(
      matches(mount(doc, EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)]))),
    ).toEqual([]);
    // Exceeds maxMatches
    expect(matches(mount(doc, EditorSelection.single(0, 2), selectionMatches({ maxMatches: 2 })))).toEqual([]);
    // Exceeds 200-char limit
    const long = "x".repeat(201);
    expect(matches(mount(`${long}\n${long}`, EditorSelection.single(0, 201)))).toEqual([]);
  });

  it("updates when selection changes or document is edited", () => {
    const v = mount("  foo\n  foo\n  bar", EditorSelection.single(2, 5));
    expect(matches(v)).toEqual(["foo"]);
    // Moving selection to leading spaces clears highlights.
    v.dispatch({ selection: EditorSelection.single(0, 2) });
    expect(matches(v)).toEqual([]);
    // Moving back restores, and editing updates matches.
    v.dispatch({ selection: EditorSelection.single(2, 5) });
    expect(matches(v)).toEqual(["foo"]);
    v.dispatch({ changes: { from: 14, to: 17, insert: "foo" } });
    expect(matches(v)).toEqual(["foo", "foo"]);
  });

  it("wires into heavyExtension and respects codeEditing.highlightSelection", () => {
    const yaml = "services:\n  app:\n    image: nginx\n    restart: always";
    expect(matches(mount(yaml, EditorSelection.single(10, 12), heavyExtension(yaml.length)))).toEqual([]);

    const dup = "image: a\nimage: b";
    expect(matches(mount(dup, EditorSelection.single(0, 5), heavyExtension(dup.length)))).toEqual(["image"]);
    const disabled = { codeEditing: { highlightSelection: false } } as unknown as EditorSettings;
    expect(matches(mount(dup, EditorSelection.single(0, 5), heavyExtension(dup.length, disabled)))).toEqual([]);
  });
});
