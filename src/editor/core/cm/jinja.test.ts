import { beforeAll, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldable, indentUnit, type LanguageSupport } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { completedSyntaxState, completedSyntaxTree } from "@/test/syntax";
import { commentLine } from "./comments";
import { linkedTags } from "./linkedTags";
import { findLanguageDescription, loadSupport } from "./languages";
import { jinja } from "./jinja";

let support: LanguageSupport;
beforeAll(async () => void (support = await jinja()));

function state(doc: string, at = 0): EditorState {
  return completedSyntaxState(
    EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [support, indentUnit.of("  ")] }),
  );
}

/** `text:class` of the styled tokens of `doc`, HTML included. */
function tokens(doc: string): string[] {
  const out: string[] = [];
  highlightTree(completedSyntaxTree(state(doc)), classHighlighter, (from, to, cls) =>
    out.push(`${doc.slice(from, to)}:${cls}`),
  );
  return out;
}

describe("Jinja2 templates", () => {
  it("is the mode of .jinja, .jinja2 and .j2 files", async () => {
    for (const path of ["/p/templates/base.jinja", "/p/a.html.jinja2", "/p/roles/web/nginx.conf.j2"])
      expect(findLanguageDescription("Jinja", path)?.name).toBe("Jinja");
    expect((await loadSupport(findLanguageDescription(null, "/p/a.j2")!))?.language.name).toBe("jinja");
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

  it("folds a block statement's content", () => {
    const doc = "{% block content %}\n  <p>x</p>\n{% endblock %}";
    expect(foldable(state(doc), 0, doc.indexOf("\n"))).toEqual({
      from: doc.indexOf("%}") + 2,
      to: doc.indexOf("{% endblock"),
    });
  });

  it("comments markup out with {# #}", () => {
    const v = new EditorView({ state: state("<p>a</p>") });
    v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    commentLine(v);
    expect(v.state.doc.toString()).toBe("{# <p>a</p> #}");
  });

  it("renames the closing tag while the opening one is typed", () => {
    const doc = '{% if a %}<div class="x">y</div>{% endif %}';
    const at = doc.indexOf(" class");
    const s = completedSyntaxState(
      EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [support, linkedTags] }),
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
