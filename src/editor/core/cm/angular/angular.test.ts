import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, foldable, matchBrackets } from "@codemirror/language";
import { NodeProp, type Tree } from "@lezer/common";
import { buildParserFile } from "@lezer/generator";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "../languages";
import { angular, angularLanguage } from "./index";

const highlighter = tagHighlighter([
  { tag: t.controlKeyword, class: "control" },
  { tag: t.keyword, class: "keyword" },
  { tag: t.definitionKeyword, class: "let" },
  { tag: t.definition(t.variableName), class: "def" },
  { tag: t.function(t.variableName), class: "call" },
  { tag: t.variableName, class: "var" },
  { tag: t.propertyName, class: "prop" },
  { tag: t.special(t.attributeName), class: "event" },
  { tag: t.attributeName, class: "attr" },
  { tag: t.attributeValue, class: "value" },
  { tag: t.operator, class: "op" },
  { tag: t.number, class: "num" },
  { tag: t.string, class: "str" },
  { tag: t.character, class: "entity" },
  { tag: t.brace, class: "brace" },
  { tag: t.tagName, class: "tag" },
  { tag: t.comment, class: "comment" },
]);

/** `text:class` of the styled tokens of `doc`, from `tree` or a fresh parse. */
function tokens(doc: string, tree: Tree = angularLanguage.parser.parse(doc)): string[] {
  const out: string[] = [];
  highlightTree(tree, highlighter, (from, to, cls) => out.push(`${doc.slice(from, to)}:${cls}`));
  return out;
}

/** The tree of `state`, parsed to the end. */
function stateTree(state: EditorState): Tree {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (!tree) throw new Error("parse did not finish");
  return tree;
}

/** A ~6 KB template starting with an element, with blocks and `@let` at the top level. */
function template(): string {
  let doc = "";
  for (let i = 0; i < 40; i++) {
    doc +=
      `<section>\n  <h2>{{ title${i} }}</h2>\n</section>\n` +
      `@if (show${i}) {\n  <p [title]="t${i}">a &amp; b {{ v${i} }}</p>\n} @else {\n  none\n}\n` +
      `@let n${i} = count${i} + 1;\n`;
  }
  return doc;
}

describe("Angular templates", () => {
  it("highlights bindings and interpolations as expressions", () => {
    expect(tokens(`<input [id]="label() ? inputId() : undefined" (click)="save($event)">{{ user.name }}`)).toEqual([
      "input:tag",
      "id:attr",
      "=:op",
      '":value',
      "label:call",
      "?:op",
      "inputId:call",
      "::op",
      "undefined:var",
      '":value',
      "click:event",
      "=:op",
      '":value',
      "save:call",
      "$event:var",
      '":value',
      "{{:brace",
      "user:var",
      ".:op",
      "name:prop",
      "}}:brace",
    ]);
  });

  it("highlights @if and @else blocks, across entities and elements", () => {
    expect(tokens(`<div>@if (user() && ok; as u) {<b>&amp;</b>} @else if (x) {} @else {}</div>`)).toEqual([
      "div:tag",
      "@if:control",
      "user:call",
      "&&:op",
      "ok:var",
      "as:keyword",
      "u:def",
      "{:brace",
      "b:tag",
      "&amp;:entity",
      "b:tag",
      "}:brace",
      "@else:control",
      "if:control",
      "x:var",
      "{:brace",
      "}:brace",
      "@else:control",
      "{:brace",
      "}:brace",
      "div:tag",
    ]);
  });

  it("highlights @for, @switch and @let", () => {
    expect(tokens(`@for (item of items(); track item.id; let i = $index) {} @empty {}`)).toEqual([
      "@for:control",
      "item:def",
      "of:keyword",
      "items:call",
      "track:keyword",
      "item:var",
      ".:op",
      "id:prop",
      "let:let",
      "i:def",
      "=:op",
      "$index:var",
      "{:brace",
      "}:brace",
      "@empty:control",
      "{:brace",
      "}:brace",
    ]);
    expect(tokens(`@switch (mode) { @case ('a') {} @default {} }`)).toEqual([
      "@switch:control",
      "mode:var",
      "{:brace",
      "@case:control",
      "'a':str",
      "{:brace",
      "}:brace",
      "@default:control",
      "{:brace",
      "}:brace",
      "}:brace",
    ]);
    expect(tokens(`@let total = price() * 2;`)).toEqual([
      "@let:let",
      "total:def",
      "=:op",
      "price:call",
      "*:op",
      "2:num",
    ]);
  });

  it("highlights @defer triggers and timings", () => {
    expect(
      tokens(`@defer (on viewport(el), timer(5s); prefetch when ready) {} @placeholder (minimum 500ms) {}`),
    ).toEqual([
      "@defer:keyword",
      "on:keyword",
      "viewport:keyword",
      "el:var",
      "timer:keyword",
      "5s:num",
      "prefetch:keyword",
      "when:keyword",
      "ready:var",
      "{:brace",
      "}:brace",
      "@placeholder:keyword",
      "minimum:keyword",
      "500ms:num",
      "{:brace",
      "}:brace",
    ]);
  });

  it("keeps an @ of text as text", () => {
    expect(tokens(`<p>mail a@b.com, use @for loops, @if</p>`)).toEqual(["p:tag", "p:tag"]);
  });

  it("parses `{{{` in an ICU case as a brace and an interpolation", () => {
    expect(tokens(`{n, plural, other {{{n}} items}}`)).toEqual([
      "{:brace",
      "{:brace",
      "{{:brace",
      "n:var",
      "}}:brace",
      "}:brace",
      "}:brace",
    ]);
  });

  it("matches a block's braces around its elements", () => {
    const doc = `@if (a) {\n  <p>{{ a }}</p>\n}`;
    const state = EditorState.create({ doc, extensions: angular() });
    ensureSyntaxTree(state, doc.length, 5000);
    expect(matchBrackets(state, doc.indexOf("{"), 1)).toMatchObject({
      matched: true,
      end: { from: doc.lastIndexOf("}") },
    });
  });

  it("folds a block from its `{` to its `}`", () => {
    const doc = [
      "@if (a && b) {",
      "  <p>{{ x }}</p>",
      "} @else if (c) {",
      "  <ul>",
      "    @for (i of is; track i) {",
      "      <li>{ i }</li>",
      "    }",
      "  </ul>",
      "} @else {",
      "  none",
      "}",
      "@switch (m) {",
      "  @case (1) { one }",
      "  @default {",
      "    other",
      "  }",
      "}",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: angular() });
    stateTree(state);
    const folds = [];
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      const fold = foldable(state, line.from, line.to);
      if (fold)
        folds.push([
          n,
          state.doc.lineAt(fold.to).number,
          state.sliceDoc(fold.from - 1, fold.from),
          state.sliceDoc(fold.to, fold.to + 1),
        ]);
    }
    expect(folds).toEqual([
      [1, 3, "{", "}"],
      [3, 9, "{", "}"],
      // The element's own fold.
      [4, 8, ">", "<"],
      [5, 7, "{", "}"],
      [9, 11, "{", "}"],
      [12, 17, "{", "}"],
      [14, 16, "{", "}"],
    ]);
  });

  it("highlights key, unit and animation binding names", () => {
    const doc = `<input (keydown.enter)="save()" (window:resize)="fit()" [style.width.%]="w" [@fade]="s" (@fade.done)="end()">`;
    expect(tokens(doc)).toEqual([
      "input:tag",
      "keydown.enter:event",
      "=:op",
      '":value',
      "save:call",
      '":value',
      "window:resize:event",
      "=:op",
      '":value',
      "fit:call",
      '":value',
      "style.width.%:attr",
      "=:op",
      '":value',
      "w:var",
      '":value',
      "@fade:attr",
      "=:op",
      '":value',
      "s:var",
      '":value',
      "@fade.done:event",
      "=:op",
      '":value',
      "end:call",
      '":value',
    ]);
  });

  it("highlights structural directives' microsyntax", () => {
    expect(tokens(`<li *ngFor="let item of items(); index as i; trackBy: byId"></li>`)).toEqual([
      "li:tag",
      "*ngFor:keyword",
      "=:op",
      '":value',
      "let:let",
      "item:def",
      "of:keyword",
      "items:call",
      "index:var",
      "as:keyword",
      "i:def",
      "trackBy:keyword",
      "byId:var",
      '":value',
      "li:tag",
    ]);
    expect(
      tokens(
        `<p *ngIf="user$ | async as user, else loading"></p><b *ngTemplateOutlet="tpl; context: { $implicit: x }"></b>`,
      ),
    ).toEqual([
      "p:tag",
      "*ngIf:keyword",
      "=:op",
      '":value',
      "user$:var",
      "|:op",
      "async:var",
      "as:keyword",
      "user:def",
      "else:keyword",
      "loading:var",
      '":value',
      "p:tag",
      "b:tag",
      "*ngTemplateOutlet:keyword",
      "=:op",
      '":value',
      "tpl:var",
      "context:keyword",
      "{:brace",
      "$implicit:prop",
      "x:var",
      "}:brace",
      '":value',
      "b:tag",
    ]);
    expect(tokens(`<i *cdkVirtualFor="let row of rows | slice: 0 : 5; let n = count"></i>`)).toEqual([
      "i:tag",
      "*cdkVirtualFor:keyword",
      "=:op",
      '":value',
      "let:let",
      "row:def",
      "of:keyword",
      "rows:var",
      "|:op",
      "slice:var",
      "0:num",
      "5:num",
      "let:let",
      "n:def",
      "=:op",
      "count:var",
      '":value',
      "i:tag",
    ]);
  });

  it("ends a directive's expressions at keys without separators", () => {
    expect(tokens(`<p *ngIf="ok; then yes else no"></p>`)).toEqual([
      "p:tag",
      "*ngIf:keyword",
      "=:op",
      '":value',
      "ok:var",
      "then:keyword",
      "yes:var",
      "else:keyword",
      "no:var",
      '":value',
      "p:tag",
    ]);
    expect(tokens(`<p *ngFor="let a of xs, let i = index"></p>`).slice(4, -2)).toEqual([
      "let:let",
      "a:def",
      "of:keyword",
      "xs:var",
      "let:let",
      "i:def",
      "=:op",
      "index:var",
    ]);
    expect(tokens(`<p *ngFor="let a of xs index as i"></p>`).slice(4, -2)).toEqual([
      "let:let",
      "a:def",
      "of:keyword",
      "xs:var",
      "index:var",
      "as:keyword",
      "i:def",
    ]);
  });

  it("parses directive values Angular accepts without errors", () => {
    const values = [
      "let a of xs; let i = index; trackBy: byId",
      "ok; then yes else no",
      "'a' in obj && x?.y as z; else no",
      "x, foo",
      "x; foo let y = z",
      "tpl; context: { a: [1, 2], b: f(c, d) }",
    ];
    for (const value of values) {
      const errors: string[] = [];
      angularLanguage.parser.parse(`<p *dir="${value}"></p>`).iterate({
        enter: (node) => void (node.type.isError && errors.push(node.name)),
      });
      expect(errors, value).toEqual([]);
    }
  });

  it("styles all of a binding's name and value", () => {
    const doc = `<p *ngIf="a?.b as c" [class.on]="d?.e()" (keydown.shift.enter)="f?.(1)" #ref></p>`;
    const tree = angularLanguage.parser.parse(doc);
    const styled = new Uint8Array(doc.length);
    highlightTree(tree, { style: (tags) => (tags.length ? "styled" : null) }, (from, to) => styled.fill(1, from, to));
    expect([...doc].filter((ch, i) => !styled[i] && ch != " ").join("")).toBe("");
  });

  it("parses block keywords as the names they can also be", () => {
    expect(tokens(`@if (change.after; as after) {} @loading (after 100ms; minimum 1s) {}`)).toEqual([
      "@if:control",
      "change:var",
      ".:op",
      "after:prop",
      "as:keyword",
      "after:def",
      "{:brace",
      "}:brace",
      "@loading:keyword",
      "after:keyword",
      "100ms:num",
      "minimum:keyword",
      "1s:num",
      "{:brace",
      "}:brace",
    ]);
    expect(tokens(`@for (on of track; track on) {}`)).toEqual([
      "@for:control",
      "on:def",
      "of:keyword",
      "track:var",
      "track:keyword",
      "on:var",
      "{:brace",
      "}:brace",
    ]);
  });

  it("keeps HTML's script, style and event handler attribute languages", () => {
    expect(tokens(`<script>let a = 1;</script><style>p { color: red }</style><b onclick="go(1)">x</b>`)).toEqual([
      "script:tag",
      "let:let",
      "a:def",
      "=:op",
      "1:num",
      "script:tag",
      "style:tag",
      "p:tag",
      "{:brace",
      "color:prop",
      "red:keyword",
      "}:brace",
      "style:tag",
      "b:tag",
      "onclick:attr",
      "=:op",
      '":value',
      "go:call",
      "1:num",
      '":value',
      "b:tag",
    ]);
  });

  it("parses the text directly in an element, not its attribute values", () => {
    const doc = `<p title="a &amp; b">x &lt; {{ y }}</p>`;
    const p = angularLanguage.parser.parse(doc).topNode.getChild("Element")!;
    const overlay = p.tree?.prop(NodeProp.mounted)?.overlay?.map((r) => doc.slice(p.from + r.from, p.from + r.to));
    expect(overlay).toEqual(["x &lt; {{ y }}"]);
  });

  it("parses headers interrupted by comments and elements", () => {
    const cases: [string, string[]][] = [
      [`<div>@if (a <!-- c -->) {}</div>`, ["div:tag", "@if:control", "a:var", "<!-- c -->:comment", "{:brace"]],
      [`<div>@for (x of xs; track x <!--c--> ) {}</div>`, ["div:tag", "@for:control", "x:def", "of:keyword"]],
      [`@let x = foo\n<p>a</p>\n`, ["@let:let", "x:def", "=:op", "foo:var", "p:tag", "p:tag"]],
      [`<div>\n  @if (u\n  <p>x</p>\n</div>`, ["div:tag", "@if:control", "u:var", "p:tag", "p:tag", "div:tag"]],
      [
        `<div>@if (a && <!-- c --> b && c) {}</div>`,
        ["div:tag", "@if:control", "a:var", "&&:op", "<!-- c -->:comment"],
      ],
    ];
    for (const [doc, start] of cases) {
      const state = EditorState.create({ doc, extensions: angular() });
      expect(tokens(doc, stateTree(state)).slice(0, start.length)).toEqual(start);
      const edited = state.update({ changes: { from: doc.indexOf("@") + 1, insert: " " } }).state;
      expect(() => stateTree(edited)).not.toThrow();
    }
  });

  it("ends an unterminated header before the blocks on the next lines", () => {
    expect(tokens(`@if (a(\n@for (x of xs; track x) {}`)).toEqual([
      "@if:control",
      "a:call",
      "@for:control",
      "x:def",
      "of:keyword",
      "xs:var",
      "track:keyword",
      "x:var",
      "{:brace",
      "}:brace",
    ]);
    expect(tokens(`@let x = foo\n  @if (a) {}`)).toEqual([
      "@let:let",
      "x:def",
      "=:op",
      "foo:var",
      "@if:control",
      "a:var",
      "{:brace",
      "}:brace",
    ]);
    expect(tokens(`@if (a &&\n    b) {}`)).toEqual(["@if:control", "a:var", "&&:op", "b:var", "{:brace", "}:brace"]);
  });

  it("ends an unfinished interpolation with its text", () => {
    expect(tokens(`{{ total\n<p>x</p>\nshipping and tax\n`)).toEqual(["{{:brace", "total:var", "p:tag", "p:tag"]);
    expect(tokens(`<ul>{{ a <li>x</li> plain words</ul>`)).toEqual([
      "ul:tag",
      "{{:brace",
      "a:var",
      "li:tag",
      "li:tag",
      "ul:tag",
    ]);
  });

  it("highlights like a fresh parse after resuming and editing", () => {
    const doc = template();
    // Opening parses the first 3000 characters; the rest resumes from that tree.
    let state = EditorState.create({ doc, extensions: angular() });
    expect(tokens(doc, stateTree(state))).toEqual(tokens(doc));
    const at = (text: string, n = 1) => {
      let pos = -1;
      for (let i = 0; i < n; i++) pos = state.doc.toString().indexOf(text, pos + 1);
      return pos;
    };
    const edits = [
      () => ({ from: at("{{ title12") + 9, insert: "x" }),
      () => ({ from: at("show15") + 6, insert: " && ok" }),
      () => ({ from: at("</section>", 20), insert: "\n@for (i of is; track i) { <b>{{ i }}</b> }\n" }),
      () => ({ from: at("none", 3), to: at("none", 3) + 4 }),
      () => ({ from: at("count7"), to: at("count7") + 6, insert: "total()" }),
      () => ({ from: 0, insert: "@if (top) {}\n" }),
      () => ({ from: at("<p [title]", 10), insert: "@let z = 2;" }),
    ];
    for (const edit of edits) {
      state = state.update({ changes: edit() }).state;
      const text = state.doc.toString();
      expect(tokens(text, stateTree(state))).toEqual(tokens(text));
    }
  });

  it("is generated from angular.grammar", () => {
    const dir = import.meta.dirname;
    const { parser, terms } = buildParserFile(readFileSync(resolve(dir, "angular.grammar"), "utf8"), {
      fileName: "src/editor/core/cm/angular/angular.grammar",
      moduleStyle: "es",
      typeScript: true,
    });
    expect(parser).toBe(readFileSync(resolve(dir, "parser.ts"), "utf8"));
    expect(terms).toBe(readFileSync(resolve(dir, "parser.terms.ts"), "utf8"));
  });

  it("is the Angular Template mode", async () => {
    const desc = findLanguageDescription("Angular Template", "/p/app.html");
    expect((await loadSupport(desc!))?.language).toBe(angularLanguage);
  });
});
