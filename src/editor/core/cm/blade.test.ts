import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

async function tokens(source: string) {
  const desc = findLanguageDescription("Blade", "welcome.blade.php")!;
  const support = await loadSupport(desc);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  ensureSyntaxTree(state, source.length, 1000);
  const result: { text: string; style: string }[] = [];
  highlightTree(syntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style }),
  );
  return result;
}

const styleOf = (out: { text: string; style: string }[], text: string) => out.find((t) => t.text === text)?.style;

describe("Blade mode", () => {
  it("highlights HTML, echoes and the PHP inside them", async () => {
    const out = await tokens('<div class="x">{{ $user->name }} {!! format(1) !!}</div>\n{{-- note --}}');
    expect(styleOf(out, "div")).toBe("tok-typeName");
    expect(styleOf(out, "$user")).toContain("tok-variableName");
    expect(styleOf(out, "name")).toContain("tok-propertyName");
    expect(styleOf(out, "format")).toContain("tok-variableName");
    expect(styleOf(out, "1")).toBe("tok-number");
    expect(styleOf(out, "{{-- note --}}")).toBe("tok-comment");
    expect(out.filter((t) => ["{{", "}}", "{!!", "!!}"].includes(t.text))).toHaveLength(4);
  });

  it("highlights known directives and their arguments", async () => {
    const out = await tokens("@if ($a === ')' && count($b))\n<p>a@b.com @click</p>\n@endif @php $x = 1; @endphp");
    expect(styleOf(out, "@if")).toBe("tok-keyword");
    expect(styleOf(out, "')'")).toBe("tok-string");
    expect(styleOf(out, "$b")).toContain("tok-variableName");
    expect(styleOf(out, "@endif")).toBe("tok-keyword");
    expect(styleOf(out, "@php")).toBe("tok-keyword");
    expect(styleOf(out, "$x")).toContain("tok-variableName");
    // E-mails and Alpine attributes are not directives.
    expect(out.some((t) => t.text.includes("@b") || t.text === "@click")).toBe(false);
  });

  it("keeps state across lines", async () => {
    const out = await tokens("@include('a', [\n  'b' => $c,\n]) <p>\n{{-- x\n<p> --}}");
    expect(styleOf(out, "$c")).toContain("tok-variableName");
    expect(styleOf(out, "'b'")).toBe("tok-string");
    expect(out.filter((t) => t.text === "p")).toHaveLength(1);
  });
});
