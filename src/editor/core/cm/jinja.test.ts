import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldable, indentUnit, matchBrackets, type LanguageSupport } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { completedSyntaxState, completedSyntaxTree } from "@/test/syntax";
import { commentLine } from "./comments";
import { linkedTags } from "./linkedTags";
import { findLanguageDescription, loadSupport } from "./languages";
import { jinja, jinjaHtml } from "./jinja";

const html = jinjaHtml();
const text = jinja();

function state(doc: string, support: LanguageSupport = html, at = 0): EditorState {
  return completedSyntaxState(
    EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [support, indentUnit.of("  ")] }),
  );
}

/** `text:class` of the styled tokens of `doc`, markup included. */
function tokens(doc: string, support: LanguageSupport = html): string[] {
  const out: string[] = [];
  highlightTree(completedSyntaxTree(state(doc, support)), classHighlighter, (from, to, cls) =>
    out.push(`${doc.slice(from, to)}:${cls}`),
  );
  return out;
}

/** Types `ch` at `|` of `doc` through the real input handlers; the result with `|` at the caret. */
function type(doc: string, ch: string, support: LanguageSupport = html): string {
  const at = doc.indexOf("|");
  const v = new EditorView({ state: state(doc.replace("|", ""), support, at) });
  const insert = () => v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" });
  if (!v.state.facet(EditorView.inputHandler).some((h) => h(v, at, at, ch, insert))) v.dispatch(insert());
  const head = v.state.selection.main.head;
  const out = v.state.doc.toString();
  v.destroy();
  return out.slice(0, head) + "|" + out.slice(head);
}

function commented(doc: string, support: LanguageSupport): string {
  const v = new EditorView({ state: state(doc, support) });
  v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
  commentLine(v);
  return v.state.doc.toString();
}

describe("Jinja2 templates", () => {
  it("are the modes of the backend's two Jinja languages", async () => {
    expect(findLanguageDescription("Jinja", "/p/nginx.conf.j2")?.name).toBe("Jinja");
    expect(findLanguageDescription("Jinja HTML", "/p/page.html.j2")?.name).toBe("Jinja HTML");
    expect((await loadSupport(findLanguageDescription("Jinja HTML", "/p/a.html.j2")!))?.language.name).toBe("jinja");
  });

  it("highlights the template layer and the markup around it", () => {
    const out = tokens("<a href=\"{{ url_for('home') }}\">{% if user %}{{ user.name|upper }}{% endif %}</a>{# note #}");
    expect(out).toEqual(
      expect.arrayContaining([
        "a:tok-typeName",
        "href:tok-propertyName",
        "if:tok-keyword",
        "user:tok-variableName",
        "name:tok-propertyName",
        "upper:tok-variableName2",
        " note :tok-comment",
      ]),
    );
  });

  it("reads other templates as text with template tags", () => {
    const out = tokens("server {\n  listen {{ port }};\n  # <b>x</b>\n}", text);
    expect(out).toEqual(["{{:tok-punctuation", "port:tok-variableName", "}}:tok-punctuation"]);
  });

  it("closes tags only in HTML templates", () => {
    expect(type("<div|", ">")).toBe("<div>|</div>");
    expect(type("#include <vector|", ">", text)).toBe("#include <vector>|");
  });

  it("makes `{% %}` of `%` between braces", () => {
    expect(type("<p>{|}</p>", "%")).toBe("<p>{%|%}</p>");
    expect(type("listen {|};", "%", text)).toBe("listen {%|%};");
  });

  it("matches the braces of a tag", () => {
    const doc = "{% if a %}x{% endif %}";
    expect(matchBrackets(state(doc, text), 0, 1)).toMatchObject({
      matched: true,
      start: { from: 0, to: 2 },
      end: { from: 8, to: 10 },
    });
  });

  it("folds a block statement's content", () => {
    const doc = "{% block content %}\n  <p>x</p>\n{% endblock %}";
    for (const support of [html, text])
      expect(foldable(state(doc, support), 0, doc.indexOf("\n"))).toEqual({
        from: doc.indexOf("%}") + 2,
        to: doc.indexOf("{% endblock"),
      });
  });

  it("comments lines out with {# #}", () => {
    expect(commented("<p>a</p>", html)).toBe("{# <p>a</p> #}");
    expect(commented("listen 80;", text)).toBe("{# listen 80; #}");
  });

  it("renames the closing tag while the opening one is typed", () => {
    const doc = '{% if a %}<div class="x">y</div>{% endif %}';
    const at = doc.indexOf(" class");
    const s = completedSyntaxState(
      EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [html, linkedTags] }),
    );
    const v = new EditorView({ state: s });
    v.dispatch({
      changes: { from: at, insert: "s" },
      selection: EditorSelection.cursor(at + 1),
      userEvent: "input.type",
    });
    expect(v.state.doc.toString()).toBe('{% if a %}<divs class="x">y</divs>{% endif %}');
  });
});
