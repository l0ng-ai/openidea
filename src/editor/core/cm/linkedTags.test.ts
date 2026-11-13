import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { linkedTags } from "./linkedTags";
import { prefsExtension } from "./prefs";
import { angular } from "./angular";
import { astro } from "./astro";
import { django } from "./django";
import { jsp } from "./jsp";
import { vueLanguage } from "./vue";
import { validateEditorExtras } from "@/platform/editorSettings";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

const extensions: Extension = [html(), linkedTags];

/** `|` marks carets, `[`/`]` a selection. */
function make(text: string, extra: Extension = []) {
  return makeWith([EditorState.allowMultipleSelections.of(true), extensions, extra], text);
}

/** Like `make`, with the full extension list spelled out. */
function makeWith(extensions: Extension, text: string) {
  const ranges: ReturnType<typeof EditorSelection.cursor>[] = [];
  let doc = "";
  let anchor = -1;
  for (const ch of text) {
    if (ch === "|") ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === "[") anchor = doc.length;
    else if (ch === "]") ranges.push(EditorSelection.range(anchor, doc.length));
    else doc += ch;
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
      extensions,
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function show(view: EditorView): string {
  const { doc, selection } = view.state;
  let out = doc.toString();
  for (const r of [...selection.ranges].sort((a, b) => b.from - a.from))
    out = r.empty
      ? out.slice(0, r.head) + "|" + out.slice(r.head)
      : out.slice(0, r.from) + "[" + out.slice(r.from, r.to) + "]" + out.slice(r.to);
  return out;
}

/** Types `text` at every caret / over every selection, as typing does. */
function type(view: EditorView, text: string) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => ({
      changes: { from: r.from, to: r.to, insert: text },
      range: EditorSelection.cursor(r.from + text.length),
    })),
    { userEvent: "input.type" },
  );
}

/** One Backspace before every caret. */
function backspace(view: EditorView) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => ({
      changes: { from: Math.max(0, r.head - 1), to: r.head },
      range: EditorSelection.cursor(Math.max(0, r.head - 1)),
    })),
    { userEvent: "delete.backward" },
  );
}

describe("linked html tags", () => {
  it("renames the closing tag while the opening one is typed", () => {
    const v = make('<div| class="container">\n  Content\n</div>');
    type(v, "ision");
    expect(v.state.doc.toString()).toBe('<division class="container">\n  Content\n</division>');
    // The caret stays where the user typed, not in the mirrored tag.
    expect(show(v)).toBe('<division| class="container">\n  Content\n</division>');
  });

  it("renames the opening tag while the closing one is typed", () => {
    const v = make('<div class="container">\n  Content\n</div|>');
    type(v, "ision");
    expect(v.state.doc.toString()).toBe('<division class="container">\n  Content\n</division>');
  });

  it("renames a name typed at its start", () => {
    const v = make("<|div></div>");
    type(v, "s");
    expect(v.state.doc.toString()).toBe("<sdiv></sdiv>");
  });

  it("follows deletions", () => {
    const v = make("<div|></div>");
    backspace(v);
    expect(v.state.doc.toString()).toBe("<di></di>");
    backspace(v);
    expect(v.state.doc.toString()).toBe("<d></d>");
  });

  it("follows a selection replaced with a new name", () => {
    const v = make("<[div]>x</div>");
    type(v, "article");
    expect(v.state.doc.toString()).toBe("<article>x</article>");
    expect(show(v)).toBe("<article|>x</article>");
  });

  it("pairs the outer tags of nested same-name elements", () => {
    const v = make("<div>\n  <div>inner</div>\n</div|>");
    type(v, "s");
    expect(v.state.doc.toString()).toBe("<divs>\n  <div>inner</div>\n</divs>");
  });

  it("pairs the inner tags of nested same-name elements", () => {
    const v = make("<div>\n  <div|>inner</div>\n</div>");
    type(v, "s");
    expect(v.state.doc.toString()).toBe("<div>\n  <divs>inner</divs>\n</div>");
  });

  it("renames two elements with one caret each", () => {
    const v = make("<p|>one</p>\n<h2|>two</h2>");
    type(v, "x");
    expect(v.state.doc.toString()).toBe("<px>one</px>\n<h2x>two</h2x>");
  });

  it("leaves both tags alone when the caret edits both at once", () => {
    const v = make("<div|></div|>");
    type(v, "s");
    expect(v.state.doc.toString()).toBe("<divs></divs>");
  });

  it("mirrors only the caret inside a tag name", () => {
    const v = make("<p|>one\nplain| text\n</p>");
    type(v, "x");
    expect(v.state.doc.toString()).toBe("<px>one\nplainx text\n</px>");
  });

  it("skips rather than guesses with two carets in one name", () => {
    const v = make("<di|v|></div>");
    type(v, "x");
    expect(v.state.doc.toString()).toBe("<dixvx></div>");
  });

  it("does not touch other tags or attributes", () => {
    const v = make('<div class="container" |>\n  <span>keep</span>\n</div>');
    type(v, "x");
    expect(v.state.doc.toString()).toBe('<div class="container" x>\n  <span>keep</span>\n</div>');
  });

  it("skips void and self-closing tags", () => {
    const v = make("<p>before</p>\n<img|>\n<br>");
    type(v, "x");
    expect(v.state.doc.toString()).toBe("<p>before</p>\n<imgx>\n<br>");
    const selfClosing = make("<p>before</p>\n<div|/>");
    type(selfClosing, "x");
    expect(selfClosing.state.doc.toString()).toBe("<p>before</p>\n<divx/>");
  });

  it("skips unclosed elements and stray close tags", () => {
    const v = make("<div|>unclosed");
    type(v, "x");
    expect(v.state.doc.toString()).toBe("<divx>unclosed");
    const stray = make("<p>before</p>\n</div|>");
    type(stray, "x");
    expect(stray.state.doc.toString()).toBe("<p>before</p>\n</divx>");
  });

  it("keeps a partially typed tag unmirrored", () => {
    const v = make("<di|v");
    type(v, "s");
    expect(v.state.doc.toString()).toBe("<disv");
  });

  it("does not follow structural characters typed at the name's edge", () => {
    // `/` would make the open tag self-closing; `>` would end it: neither extends the name.
    const v = make("<div|></div>");
    type(v, "/");
    expect(v.state.doc.toString()).toBe("<div/></div>");
    const closing = make("<div>content</di|v>");
    type(closing, ">");
    expect(closing.state.doc.toString()).toBe("<div>content</di>v>");
  });

  it("undoes the pair as one step and redoes it", () => {
    const v = make("<div|></div>", history());
    type(v, "x");
    expect(v.state.doc.toString()).toBe("<divx></divx>");
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("<div></div>");
    expect(redo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("<divx></divx>");
  });

  // Every mode whose outer parser is `@lezer/html`: renaming an opening tag follows into
  // the closing one (prefs.ts enables the filter for exactly these language ids).
  describe("in the html-based modes", () => {
    const modes: [string, () => Extension][] = [
      ["Vue", () => vueLanguage()],
      ["Angular Template", () => angular()],
      ["JSP", () => jsp()],
      ["Django Template", () => django()],
      ["Astro", () => astro()],
    ];

    for (const [name, language] of modes) {
      it(`renames the closing tag while the opening one is typed in ${name}`, () => {
        const v = makeWith([language(), linkedTags], '<div| class="a">x</div>');
        type(v, "s");
        expect(v.state.doc.toString()).toBe('<divs class="a">x</divs>');
      });
    }
  });

  describe("the smart key gates the filter", () => {
    /** The real wiring: prefsExtension attaches the filter for the document's language. */
    const prefs = (language: string | undefined, smartKeys: Record<string, unknown> = {}) =>
      makeWith(
        [
          EditorState.allowMultipleSelections.of(true),
          // A parseable tree: the real editors attach the mode's parser beside prefsExtension.
          html(),
          prefsExtension({
            prefs: validateEditorExtras({ smartKeys }),
            path: "",
            softWrap: false,
            showWhitespace: false,
            hardWrapAt: 120,
            readOnly: false,
            language,
          }),
        ],
        "<div|></div>",
      );

    it("links tags for plain html", () => {
      const v = prefs("html");
      type(v, "s");
      expect(v.state.doc.toString()).toBe("<divs></divs>");
    });

    it("links tags for the html-based language ids", () => {
      for (const language of ["vue", "jsp", "django-html", "astro"]) {
        const v = prefs(language);
        type(v, "s");
        expect(v.state.doc.toString()).toBe("<divs></divs>");
      }
    });

    it("stays off when the option is off", () => {
      const v = prefs("html", { simultaneousTagEditing: false });
      type(v, "s");
      expect(v.state.doc.toString()).toBe("<divs></div>");
    });

    it("stays off for the token-based erb mode", () => {
      const v = prefs("erb");
      type(v, "s");
      expect(v.state.doc.toString()).toBe("<divs></div>");
    });
  });
});
