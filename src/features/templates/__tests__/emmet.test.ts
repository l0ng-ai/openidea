import { beforeAll, describe, expect, it } from "vitest";
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
