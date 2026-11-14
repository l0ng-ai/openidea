import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { foldable, getIndentation, indentUnit, matchBrackets } from "@codemirror/language";
import { buildParserFile } from "@lezer/generator";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { completedSyntaxState, completedSyntaxTree } from "@/test/syntax";
import { commentBlock, commentLine } from "../comments";
import { findLanguageDescription, loadSupport } from "../languages";
import { django, djangoLanguage } from "./index";

const highlighter = tagHighlighter([
  { tag: t.special(t.brace), class: "delim" },
  { tag: t.blockComment, class: "comment" },
  { tag: t.operatorKeyword, class: "opkw" },
  { tag: t.keyword, class: "keyword" },
  { tag: t.bool, class: "bool" },
  { tag: t.null, class: "null" },
  { tag: t.function(t.variableName), class: "filter" },
  { tag: t.variableName, class: "var" },
  { tag: t.propertyName, class: "prop" },
  { tag: t.attributeName, class: "attr" },
  { tag: t.string, class: "str" },
  { tag: t.number, class: "num" },
  { tag: t.tagName, class: "tag" },
]);

function state(doc: string, selection?: EditorSelection | number): EditorState {
  return completedSyntaxState(
    EditorState.create({
      doc,
      selection: typeof selection == "number" ? EditorSelection.cursor(selection) : selection,
      extensions: [django(), indentUnit.of("  ")],
    }),
  );
}

/** `text:class` of the styled tokens of `doc`, HTML included. */
function tokens(doc: string): string[] {
  const out: string[] = [];
  highlightTree(completedSyntaxTree(state(doc)), highlighter, (from, to, cls) =>
    out.push(`${doc.slice(from, to)}:${cls}`),
  );
  return out;
}

/** The error nodes of `doc`'s template layer, with the text they start. */
function errors(doc: string): string[] {
  const out: string[] = [];
  djangoLanguage.parser.parse(doc).iterate({
    enter: (node) => void (node.type.isError && out.push(doc.slice(node.from, node.from + 12))),
  });
  return out;
}

/** The top-level node names of `doc`'s template layer. */
function outline(doc: string): string {
  return djangoLanguage.parser.parse(doc).toString();
}

/** A view on `doc` with `|` marking the caret. */
function view(marked: string): EditorView {
  const at = marked.indexOf("|");
  const doc = marked.slice(0, at) + marked.slice(at + 1);
  return new EditorView({ state: state(doc, at) });
}

/** Types `text` at the caret through the input handlers, like a keystroke. */
function type(v: EditorView, text: string): string {
  const { from, to } = v.state.selection.main;
  const handled = v.state.facet(EditorView.inputHandler).some((h) => h(v, from, to, text, () => v.state.update({})));
  if (!handled)
    v.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
  const head = v.state.selection.main.head;
  return v.state.sliceDoc(0, head) + "|" + v.state.sliceDoc(head);
}

describe("Django template grammar", () => {
  it("parses Django's tags, filters with arguments and its operators without errors", () => {
    const doc = [
      `{% extends "base.html" %}{% load static i18n %}`,
      `{% block content %}{{ block.super }}`,
      `<a href="{% url 'app:detail' pk=obj.pk as link %}">{{ value|date:"Y-m-d"|default:'-' }}</a>`,
      `<img src="{% static 'img/a.png' %}">{% csrf_token %}`,
      `{% for x in items|dictsort:"name" %}{{ forloop.counter0 }} {{ x.0 }}{% empty %}none{% endfor %}`,
      `{% if a and not b or c in d %}x{% elif e is not None and n >= -1 %}y{% else %}z{% endif %}`,
      `{% blocktranslate with n=count trimmed %}{{ n }} item{% plural %}{{ n }} items{% endblocktranslate %}`,
      `{% with total=business.employees.count %}{{ total }}{% endwith %}`,
      `{% include "row.html" with item=item only %}{% cycle 'odd' 'even' %}{% now "Y" %}`,
      `{% render_field form.email class="input" %}{% endblock content %}`,
    ].join("\n");
    expect(errors(doc)).toEqual([]);
  });

  it("nests block tags and leaves other tags alone", () => {
    expect(outline("{% if a %}{% for x in b %}{{ x }}{% endfor %}{% else %}-{% endif %}")).toBe(
      "Template(Element(OpenTag(OpenTagStart,TagName,VariableName,TagEnd)," +
        "Element(OpenTag(OpenTagStart,TagName,VariableName,in,VariableName,TagEnd)," +
        'Interpolation("{{",VariableName,"}}"),EndTag(EndTagStart,TagName,TagEnd)),' +
        "MidTag(MidTagStart,TagName,TagEnd),Text,EndTag(EndTagStart,TagName,TagEnd)))",
    );
    expect(outline("{% csrf_token %}{% else %}")).toBe(
      "Template(Tag(TagStart,TagName,TagEnd),Tag(TagStart,TagName,TagEnd))",
    );
  });

  it("closes a block only with its own end tag", () => {
    // `endfor` closes nothing here: the `if` stays open to the end.
    const tree = outline("{% if a %}{% endfor %}");
    expect(tree).toContain("Element(OpenTag(");
    expect(tree).toContain("Tag(TagStart,TagName,TagEnd)");
  });

  it("doesn't parse the content of comment and verbatim", () => {
    expect(errors("{% comment 'why' %}{% if %} {{ {% endcomment %}")).toEqual([]);
    expect(outline("{% verbatim %}{{ raw }}{% if %}{% endverbatim %}")).toBe(
      "Template(VerbatimElement(VerbatimTag(VerbatimTagStart,TagName,TagEnd),VerbatimBody,EndTag(EndTagStart,TagName,TagEnd)))",
    );
  });

  it("highlights the template layer and the markup around it", () => {
    expect(tokens(`<p class="x">{{ user.name|lower }}{# hi #}</p>`)).toEqual([
      "p:tag",
      "class:attr",
      '"x":str',
      "{{:delim",
      "user:var",
      "name:prop",
      "lower:filter",
      "}}:delim",
      "{# hi #}:comment",
      "p:tag",
    ]);
    expect(tokens(`{% if a is None and b %}{% endif %}`)).toEqual([
      "{%:delim",
      "if:keyword",
      "a:var",
      "is:opkw",
      "None:null",
      "and:opkw",
      "b:var",
      "%}:delim",
      "{%:delim",
      "endif:keyword",
      "%}:delim",
    ]);
  });

  it("parses the templates of the Django fixture without errors", () => {
    const fixture = resolve(import.meta.dirname, "../../../../../fixtures/django-app");
    for (const file of [
      "shop/templates/shop/base.html",
      "shop/templates/shop/product_list.html",
      "shop/templates/shop/email/order.txt",
      "pages/promo.html",
    ]) {
      expect([file, errors(readFileSync(resolve(fixture, file), "utf8"))]).toEqual([file, []]);
    }
  });

  it("is generated from django.grammar", () => {
    const dir = import.meta.dirname;
    const { parser, terms } = buildParserFile(readFileSync(resolve(dir, "django.grammar"), "utf8"), {
      fileName: "src/editor/core/cm/django/django.grammar",
      moduleStyle: "es",
      typeScript: true,
    });
    expect(parser).toBe(readFileSync(resolve(dir, "parser.ts"), "utf8"));
    expect(terms).toBe(readFileSync(resolve(dir, "parser.terms.ts"), "utf8"));
  });
});

describe("Django template editing", () => {
  it("folds blocks, comments and verbatim content", () => {
    const doc = "{% block content %}\n  <p>x</p>\n{% endblock %}\n{% comment %}\nold\n{% endcomment %}\n";
    const s = state(doc);
    expect(foldable(s, 0, doc.indexOf("\n"))).toEqual({ from: doc.indexOf("%}") + 2, to: doc.indexOf("{% endblock") });
    const comment = doc.indexOf("{% comment");
    expect(foldable(s, comment, doc.indexOf("\n", comment))).toEqual({
      from: doc.indexOf("%}", comment) + 2,
      to: doc.indexOf("{% endcomment"),
    });
  });

  it("indents a block's content and puts its middle and end tags back", () => {
    const doc = "{% if a %}\nx\n{% else %}\ny\n{% endif %}";
    const s = state(doc);
    const lineStart = (n: number) => s.doc.line(n).from;
    expect(getIndentation(s, lineStart(2))).toBe(2);
    expect(getIndentation(s, lineStart(3))).toBe(0);
    expect(getIndentation(s, lineStart(5))).toBe(0);
  });

  it("matches a block tag with its end tag by name", () => {
    const doc = "{% for x in xs %}{{ x }}{% endfor %}";
    const match = matchBrackets(state(doc), 4, 1);
    expect(match?.matched).toBe(true);
    expect(doc.slice(match!.end!.from, match!.end!.to)).toBe("endfor");
  });

  it("closes {% %}, {{ }} and {# #} after a brace", () => {
    expect(type(view("<p>{|</p>"), "%")).toBe("<p>{% | %}</p>");
    expect(type(view("<p>{|}</p>"), "{")).toBe("<p>{{ | }}</p>");
    expect(type(view("{|"), "#")).toBe("{# | #}");
    // Not in a script, where `{` is JavaScript's.
    expect(type(view("<script>let a = {|</script>"), "{")).toBe("<script>let a = {{|</script>");
  });

  it("adds the end tag of a block tag when its %} is typed", () => {
    expect(type(view("{% block content %|"), "}")).toBe("{% block content %}|{% endblock %}");
    expect(type(view("{% if a %|}"), "}")).toBe("{% if a %}|{% endif %}");
    // It has one already.
    expect(type(view("{% if a %|\n{% endif %}"), "}")).toBe("{% if a %}|\n{% endif %}");
    expect(type(view("{% if a %|{% if b %}{% endif %}"), "}")).toBe("{% if a %}|{% endif %}{% if b %}{% endif %}");
    // Not a block tag.
    expect(type(view("{% csrf_token %|"), "}")).toBe("{% csrf_token %}|");
  });

  it("completes the end tags of the open blocks, innermost first", () => {
    const doc = "{% block a %}{% for x in y %}{% end";
    const s = state(doc);
    const sources = s.languageDataAt<CompletionSource>("autocomplete", doc.length);
    const result = sources.map((src) => src(new CompletionContext(s, doc.length, false))).find(Boolean) as
      | CompletionResult
      | undefined;
    expect(result?.options.map((o) => o.label)).toEqual(["endfor", "endblock"]);
  });

  it("comments each line with {# #}, and several lines with a comment tag", () => {
    const v = view("|<p>a</p>\n  <p>b</p>");
    v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    commentLine(v);
    expect(v.state.doc.toString()).toBe("{# <p>a</p> #}\n  {# <p>b</p> #}");
    v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    commentLine(v);
    expect(v.state.doc.toString()).toBe("<p>a</p>\n  <p>b</p>");
    v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    commentBlock(v);
    expect(v.state.doc.toString()).toBe("{% comment %}<p>a</p>\n  <p>b</p>{% endcomment %}");
    commentBlock(v);
    expect(v.state.doc.toString()).toBe("<p>a</p>\n  <p>b</p>");
  });

  it("is the Django Template mode", async () => {
    const desc = findLanguageDescription("Django Template", "/p/templates/index.html");
    expect((await loadSupport(desc!))?.language).toBe(djangoLanguage);
  });
});
