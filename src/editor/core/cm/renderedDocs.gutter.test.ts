import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { java } from "@codemirror/lang-java";
import { useI18n } from "@/platform/i18n";
import { renderDocComments, renderedDocsExtension, renderedRanges, toggleRenderedViewAtCaret } from "./renderedDocs";

let view: EditorView | null = null;
const i18n = useI18n.getState();
afterEach(() => {
  view?.destroy();
  view = null;
  useI18n.setState(i18n);
});

const DOC = ["/**", " * Books a room.", " * @param n nights", " */", "class Rooms {}"].join("\n");

function open(reader: boolean, doc = DOC) {
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [java(), renderedDocsExtension, renderDocComments.of(reader)],
    }),
    parent: document.body,
  });
  return view;
}

const toggles = (v: EditorView) => [...v.dom.querySelectorAll<HTMLElement>(".cm-openidea-docToggle")];

/** Moves the mouse over the line of `line` (1-based). jsdom lays nothing out, so the block under it is given. */
async function hover(v: EditorView, line: number) {
  vi.spyOn(v, "lineBlockAtHeight").mockReturnValue(v.lineBlockAt(v.state.doc.line(line).from));
  await act(async () => fireEvent.mouseMove(v.dom, { clientY: v.documentTop }));
}

const pressed = (v: EditorView) => toggles(v).map((t) => t.getAttribute("aria-pressed"));

/** Whether the gutter gives the toggles a column: its spacer has their width, else none. */
const hasColumn = (v: EditorView) =>
  [...v.dom.querySelectorAll<HTMLElement>(".cm-openidea-docToggles .cm-gutterElement span")].some(
    (el) => el.style.width === "14px",
  );

/** Opens the file rendering its comments, then brings this one's source back with its pencil. */
async function openFlippedToSource() {
  const v = open(true);
  await hover(v, 1);
  await act(async () => fireEvent.mouseDown(toggles(v)[0]!, { button: 0 }));
  expect(renderedRanges(v.state)).toHaveLength(0);
  return v;
}

it("shows the pencil beside a rendered comment, and clicking it brings back the source", async () => {
  const v = open(true);
  expect(renderedRanges(v.state)).toHaveLength(1);
  await hover(v, 1);
  const [pencil] = toggles(v);
  // A rendered comment is a block widget: the gutter must still give it its toggle.
  expect(pencil?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => fireEvent.mouseDown(pencil!, { button: 0 }));
  expect(renderedRanges(v.state)).toHaveLength(0);
  expect(toggles(v)[0]?.getAttribute("aria-pressed")).toBe("false");
});

it("shows the lines icon beside a source comment, and clicking it renders the comment", async () => {
  const v = await openFlippedToSource();
  await hover(v, 2);
  const [lines] = toggles(v);
  expect(lines?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => fireEvent.mouseDown(lines!, { button: 0 }));
  expect(renderedRanges(v.state)).toHaveLength(1);
  expect(toggles(v)[0]?.getAttribute("aria-pressed")).toBe("true");
});

it("shows a source comment's icon only while the mouse is over it, as IDEA does", async () => {
  const v = await openFlippedToSource();
  await act(async () => fireEvent.mouseLeave(v.dom));
  expect(toggles(v)).toHaveLength(0);
  // The column stays, so the text does not shift as the icon comes and goes.
  expect(hasColumn(v)).toBe(true);
  await hover(v, 3);
  expect(pressed(v)).toEqual(["false"]);
  await hover(v, 5);
  expect(toggles(v)).toHaveLength(0);
  await hover(v, 1);
  await act(async () => fireEvent.mouseLeave(v.dom));
  expect(toggles(v)).toHaveLength(0);
});

it("shows a rendered comment's pencil only while the mouse is over it", async () => {
  const v = open(true);
  expect(toggles(v)).toHaveLength(0);
  await hover(v, 1);
  expect(pressed(v)).toEqual(["true"]);
  await hover(v, 5);
  expect(toggles(v)).toHaveLength(0);
});

it("leaves the icons to the mouse, not the caret", async () => {
  const v = await openFlippedToSource();
  await act(async () => fireEvent.mouseLeave(v.dom));
  await act(async () => v.dispatch({ selection: { anchor: v.state.doc.line(2).from + 4 } }));
  expect(toggles(v)).toHaveLength(0);
});

it("while off, shows the lines icon over a comment, and clicking it renders that one, as IDEA does", async () => {
  const v = open(false);
  expect(hasColumn(v)).toBe(true);
  expect(toggles(v)).toHaveLength(0);
  await hover(v, 2);
  expect(pressed(v)).toEqual(["false"]);
  await act(async () => fireEvent.mouseDown(toggles(v)[0]!, { button: 0 }));
  expect(renderedRanges(v.state)).toHaveLength(1);
  await hover(v, 1);
  await act(async () => fireEvent.mouseDown(toggles(v)[0]!, { button: 0 }));
  expect(renderedRanges(v.state)).toHaveLength(0);
  expect(hasColumn(v)).toBe(true);
});

it("while off, gives a file without doc comments no column, and finds a new one once typing pauses", async () => {
  vi.useFakeTimers();
  try {
    const v = open(false, "class Rooms {}");
    expect(hasColumn(v)).toBe(false);
    await hover(v, 1);
    expect(toggles(v)).toHaveLength(0);
    await act(async () => v.dispatch({ changes: { from: 0, insert: "/** Books a room. */\n" } }));
    // Not scanned on the keystroke: only once typing pauses.
    expect(hasColumn(v)).toBe(false);
    await act(async () => void vi.advanceTimersByTime(300));
    expect(hasColumn(v)).toBe(true);
    await hover(v, 1);
    expect(pressed(v)).toEqual(["false"]);
  } finally {
    vi.useRealTimers();
  }
});

it("while off, Toggle Rendered View renders one comment, and its pencil is the way back", async () => {
  const v = open(false);
  await act(async () => v.dispatch({ selection: { anchor: v.state.doc.line(2).from } }));
  await act(async () => void toggleRenderedViewAtCaret(v));
  expect(renderedRanges(v.state)).toHaveLength(1);
  expect(hasColumn(v)).toBe(true);
  await hover(v, 1);
  await act(async () => fireEvent.mouseDown(toggles(v)[0]!, { button: 0 }));
  expect(renderedRanges(v.state)).toHaveLength(0);
  // The file still has its comment, so its column stays for the icon.
  expect(hasColumn(v)).toBe(true);
});

it("renders an edited comment anew, and an unchanged one as before", async () => {
  const v = open(true);
  const text = () => v.dom.querySelector(".cm-openidea-renderedDoc")?.textContent ?? "";
  expect(text()).toContain("Books a room.");
  const at = v.state.doc.toString().indexOf("room");
  await act(async () => v.dispatch({ changes: { from: at, to: at + 4, insert: "suite" } }));
  expect(text()).toContain("Books a suite.");
  await act(async () => v.dispatch({ changes: { from: at, to: at + 5, insert: "room" } }));
  expect(text()).toContain("Books a room.");
});

it("makes the toggle a labelled button with IDEA's icons", async () => {
  const v = open(true);
  await hover(v, 1);
  const [pencil] = toggles(v);
  expect(pencil?.tagName).toBe("BUTTON");
  expect(pencil?.getAttribute("aria-label")).toBe("Toggle Rendered View");
  expect(pencil?.querySelector("svg[data-icon='gutter-javadoc-edit']")).not.toBeNull();
  await act(async () => fireEvent.mouseDown(pencil!, { button: 0 }));
  await hover(v, 2);
  expect(toggles(v)[0]?.querySelector("svg[data-icon='gutter-javadoc-read']")).not.toBeNull();
});

it("shows the source of a rendered comment the caret is put inside, as by Find", async () => {
  const v = open(true);
  expect(renderedRanges(v.state)).toHaveLength(1);
  // Its edges are where arrow keys stop on their way past: still rendered there.
  await act(async () => v.dispatch({ selection: { anchor: 0 } }));
  await act(async () => v.dispatch({ selection: { anchor: v.state.doc.line(4).to } }));
  expect(renderedRanges(v.state)).toHaveLength(1);
  const at = v.state.doc.toString().indexOf("room");
  await act(async () => v.dispatch({ selection: { anchor: at, head: at + 4 } }));
  expect(renderedRanges(v.state)).toHaveLength(0);
});

it("indents by the code's character width, so a font size change keeps it in line", () => {
  const v = open(true, ["class A {", "\t/**", "\t * Books.", "\t */", "\tvoid book() {}", "}"].join("\n"));
  const body = v.dom.querySelector<HTMLElement>(".cm-openidea-renderedDoc")!;
  // A tab is a tab size of columns, not one character.
  expect(body.style.marginLeft).toContain(`${v.state.tabSize} * var(--openidea-doc-char`);
});

it("forgets a flip whose comment is deleted, so the feature turns off again", async () => {
  const v = open(
    false,
    ["/** Books a room. */", "class Rooms {}", "/** Lists the rooms. */", "class List {}"].join("\n"),
  );
  await act(async () => v.dispatch({ selection: { anchor: 0 } }));
  await act(async () => void toggleRenderedViewAtCaret(v));
  expect(renderedRanges(v.state)).toHaveLength(1);
  // Delete the rendered comment, its line and all: the other comment stays as source.
  await act(async () => v.dispatch({ changes: { from: 0, to: v.state.doc.line(2).from } }));
  expect(renderedRanges(v.state)).toHaveLength(0);
  // A flip left behind would keep the feature on: the remaining comment, now where the
  // deleted one began, would render after its next edit.
  await act(async () => v.dispatch({ changes: { from: v.state.doc.length, insert: " " } }));
  expect(renderedRanges(v.state)).toHaveLength(0);
});

it("does not flip a comment with nothing to render, nor give it an icon", async () => {
  const v = open(false, ["/** */", "class Rooms {}"].join("\n"));
  expect(toggleRenderedViewAtCaret(v)).toBe(false);
  expect(hasColumn(v)).toBe(false);
  await hover(v, 1);
  expect(toggles(v)).toHaveLength(0);
});

it("draws the section titles and tooltips again in a new UI language", async () => {
  const v = open(true);
  const title = () => v.dom.querySelector(".cm-openidea-renderedDocSections dt")?.textContent;
  expect(title()).toBe("Params:");
  await act(async () =>
    useI18n.setState({ locale: "zh", texts: { Params: "参数", "Toggle Rendered View": "切换渲染视图" } }),
  );
  expect(title()).toBe("参数:");
  await hover(v, 1);
  expect(toggles(v)[0]?.getAttribute("aria-label")).toBe("切换渲染视图");
});

/** The declarations the editor's theme gives `selector` (ending the rule's selector). */
function themeRule(selector: string): CSSStyleDeclaration | null {
  for (const sheet of document.styleSheets)
    for (const rule of sheet.cssRules)
      if (rule instanceof CSSStyleRule && rule.selectorText.split(",").some((s) => s.trim().endsWith(selector)))
        return rule.style;
  return null;
}

it("gives the rendered comment no vertical margin, which would push the lines below off their numbers", () => {
  open(true);
  // The editor measures a block widget by its border box: a margin is height it never sees.
  const rule = themeRule(".cm-openidea-renderedDoc")!;
  expect(rule.marginTop || "0").toMatch(/^0(px)?$/);
  expect(rule.marginBottom || "0").toMatch(/^0(px)?$/);
});

it("reflows the rendered text, so the source's line breaks do not carry over", () => {
  open(true);
  // The content is `white-space: pre`, which the widget inherits unless it says otherwise;
  // jsdom does not compute inheritance, so the rule itself is what is checked.
  expect(themeRule(".cm-openidea-renderedDoc")?.whiteSpace).toBe("normal");
  // Code blocks keep theirs.
  expect(themeRule(".cm-openidea-renderedDoc pre")?.whiteSpace).toBe("pre");
});

it("gives a {@link} the link colour, over the code colour", () => {
  open(true);
  expect(themeRule(".cm-openidea-renderedDoc code.cm-openidea-docLink")?.color).toBe("var(--accent)");
});

it("wraps the rendered text at the visible width, not the longest line's", () => {
  const v = open(true);
  const body = v.dom.querySelector<HTMLElement>(".cm-openidea-renderedDoc")!;
  expect(body.style.maxWidth).toContain("var(--openidea-doc-width");
});

it("leaves the comment as it is when its rendered text is clicked", async () => {
  const v = open(true);
  const body = v.dom.querySelector<HTMLElement>(".cm-openidea-renderedDoc")!;
  await act(async () => fireEvent.mouseDown(body, { button: 0 }));
  expect(renderedRanges(v.state)).toHaveLength(1);
});
