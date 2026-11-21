import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { expandEmmetAtCaret } from "../emmet/editor";
import { enclosingTag, expandAt, loadEmmet, syntaxAt, updateTagEdits, type TextEdit } from "../emmet/model";

beforeAll(() => loadEmmet());

const apply = (text: string, edits: TextEdit[]) =>
  [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);

describe("emmet context", () => {
  it("expands markup in HTML text, not inside tags, comments or scripts", () => {
    expect(syntaxAt("html", "<body>\n  ul>li")).toEqual({ type: "markup", syntax: "html" });
    expect(syntaxAt("html", "<div cla")).toBeNull();
    expect(syntaxAt("html", "<!-- div")).toBeNull();
    expect(syntaxAt("html", "<script>\n  foo")).toBeNull();
    expect(syntaxAt("html", "<script></script>\ndiv")).toEqual({ type: "markup", syntax: "html" });
    expect(syntaxAt("typescript", "div")).toBeNull();
  });

  it("expands markup in Django templates, not inside template tags, variables or comments", () => {
    expect(syntaxAt("django-html", "{% block content %}\n  ul>li")).toEqual({ type: "markup", syntax: "html" });
    expect(syntaxAt("django-html", "{% if user")).toBeNull();
    expect(syntaxAt("django-html", "{{ value|date")).toBeNull();
    expect(syntaxAt("django-html", "{# note")).toBeNull();
    expect(syntaxAt("django-html", '<a href="{% url "home" %}">x</a>\nnav')).toEqual({
      type: "markup",
      syntax: "html",
    });
  });

  it("uses stylesheet syntax inside rules and <style>", () => {
    expect(syntaxAt("css", ".a {\n  m10")).toEqual({ type: "stylesheet", syntax: "css" });
    expect(syntaxAt("css", "m10")).toBeNull();
    expect(syntaxAt("css", ".a { /* m10")).toBeNull();
    expect(syntaxAt("html", '<style lang="scss">\n.a { p5')).toEqual({ type: "stylesheet", syntax: "scss" });
    expect(syntaxAt("html", "<style>\n.a")).toBeNull();
  });
});

describe("emmet expansion", () => {
  const html = { type: "markup", syntax: "html" } as const;

  it("expands abbreviations into snippets with fields", () => {
    const line = "  ul>li.item*2";
    const r = expandAt(line, line.length, html)!;
    expect(r.from).toBe(2);
    expect(r.to).toBe(line.length);
    expect(r.snippet).toBe('<ul>\n\t<li class="item">${1}</li>\n\t<li class="item">${2}</li>\n</ul>');
  });

  it("fills attribute placeholders and escapes snippet syntax", () => {
    expect(expandAt("a", 1, html)!.snippet).toBe('<a href="${1}">${2}</a>');
    expect(expandAt("p{x#{y}}", 8, html)!.snippet).toBe("<p>x#\\{y}</p>");
  });

  it("expands CSS properties and ignores unknown words", () => {
    const css = { type: "stylesheet", syntax: "css" } as const;
    expect(expandAt("  m10", 5, css)!.snippet).toBe("margin: 10px;");
    expect(expandAt("  123", 5, css)).toBeNull();
  });
});

describe("update tag with emmet", () => {
  const doc = '<div class="a" id="x">\n  <p>hi</p>\n</div>';

  it("finds the innermost element around the caret", () => {
    expect(enclosingTag(doc, doc.indexOf("hi"))?.name).toBe("p");
    expect(enclosingTag(doc, doc.indexOf("  <p>"))?.name).toBe("div");
    expect(enclosingTag("<ul><li>a<li>b</ul>", 10)?.name).toBe("li");
    expect(enclosingTag("<br><span>x</span>", 2)?.name).toBe("br");
  });

  it("renames, adds classes and sets attributes", () => {
    const tag = enclosingTag(doc, 3)!;
    expect(apply(doc, updateTagEdits(tag, "section.b#y[data-k=v]")!)).toBe(
      '<section class="a b" id="y" data-k="v">\n  <p>hi</p>\n</section>',
    );
    expect(apply(doc, updateTagEdits(tag, ".c")!)).toBe('<div class="a c" id="x">\n  <p>hi</p>\n</div>');
    expect(updateTagEdits(tag, "ul>li")).toBeNull();
  });
});

describe("emmet in JSX", () => {
  const views: EditorView[] = [];
  afterEach(() => views.splice(0).forEach((v) => v.destroy()));

  /** Presses Tab at `|` in a TSX document; returns the text, or null when Tab did not expand. */
  function tab(text: string): string | null {
    const at = text.indexOf("|");
    const view = new EditorView({
      state: EditorState.create({
        doc: text.replace("|", ""),
        selection: { anchor: at },
        extensions: javascript({ jsx: true, typescript: true }),
      }),
      parent: document.body,
    });
    views.push(view);
    return expandEmmetAtCaret(view, "typescriptreact") ? view.state.doc.toString() : null;
  }

  it("expands among an element's children with className and self-closing void elements", () => {
    expect(tab("const a = <div>\n  .card|\n</div>;")).toBe('const a = <div>\n  <div className="card"></div>\n</div>;');
    expect(tab("const a = <div>img|</div>;")).toBe('const a = <div><img src="" alt="" /></div>;');
    expect(tab("const a = <div>ul>li*2|</div>;")).toBe("const a = <div><ul>\n  <li></li>\n  <li></li>\n</ul></div>;");
  });

  it("expands markup returned from a function or arrow", () => {
    expect(tab("function A() {\n  return (\n    div|\n  );\n}")).toBe(
      "function A() {\n  return (\n    <div></div>\n  );\n}",
    );
    expect(tab("const A = () => .row|;")).toBe('const A = () => <div className="row"></div>;');
    expect(tab("const A = () => Foo|;")).toBe("const A = () => <Foo></Foo>;");
  });

  it("leaves code, strings, attributes and plain identifiers alone", () => {
    expect(tab("const div = 1;\nfoo|")).toBeNull();
    expect(tab("function f() {\n  return value|;\n}")).toBeNull();
    expect(tab('const s = "div|";')).toBeNull();
    expect(tab("const a = <div cla|></div>;")).toBeNull();
    expect(tab("const a = <div>{items|}</div>;")).toBeNull();
  });
});
