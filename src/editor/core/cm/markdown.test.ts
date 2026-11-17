import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { LanguageDescription, syntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { completedSyntaxState } from "@/test/syntax";
import type { DocBackend, LanguageInfo } from "../backend";
import { _resetLanguages, fencedCodeMode, findLanguageDescription, loadLanguageInfos, loadSupport } from "./languages";
import { fencedCodeScopes } from "./markdown";

const SHELL = [
  "```shell",
  "# list the pods that are not running",
  'namespace="${1:-default}"',
  "if kubectl get pods | grep -v 'Running'; then",
  "  exit 1",
  "fi",
  "```",
];
const JSON_BLOCK = ["```json", "{", '  "name": "example-service",', '  "replicas": 3,', '  "tier": null', "}", "```"];
const YAML_BLOCK = ["```yaml", "# deployment settings", "name: example-service", "enabled: true", "```"];
const TEXT_BLOCK = ["```text", "# not a comment", "name: plain", "```"];
const DOC = [...SHELL, "", ...JSON_BLOCK, "", ...YAML_BLOCK, "", ...TEXT_BLOCK].join("\n");

const highlighter = tagHighlighter([
  { tag: t.comment, class: "comment" },
  { tag: t.keyword, class: "keyword" },
  { tag: [t.string, t.special(t.string)], class: "string" },
  { tag: t.number, class: "number" },
  { tag: [t.bool, t.null], class: "literal" },
  { tag: t.propertyName, class: "property" },
]);

async function markdownState(doc: string) {
  const support = await loadSupport(findLanguageDescription("Markdown", "/p/README.md")!);
  for (const info of ["shell", "json", "yaml"]) {
    const language = fencedCodeMode(info)!.language;
    // A block language not loaded yet: Markdown parses the block again once it is.
    if (language instanceof LanguageDescription) await language.load();
  }
  return completedSyntaxState(EditorState.create({ doc, extensions: [support!] }));
}

function highlighted(state: EditorState) {
  const found: Array<[string, string]> = [];
  highlightTree(syntaxTree(state), highlighter, (from, to, cls) => found.push([state.sliceDoc(from, to), cls]));
  return found;
}

describe("Markdown fenced code (#3808)", () => {
  afterEach(() => _resetLanguages());

  it("resolves info strings like mode names, backend language ids and file extensions", async () => {
    const language = (id: string, extensions: string[], uiMode: string | null) =>
      ({ id, name: id, extensions, uiMode, lineComment: null, blockComment: null, indent: null }) as LanguageInfo;
    await loadLanguageInfos({
      languages: async () => [
        language("plaintext", ["txt", "text"], null),
        language("shellscript", ["sh", "bash", "zsh"], "Shell"),
        language("python", ["py"], "Python"),
        language("kotlin", ["kt", "kts"], "Kotlin"),
        language("csharp", ["cs"], "C#"),
      ],
    } as Partial<DocBackend> as DocBackend);
    for (const [info, name] of [
      ["shell", "Shell"],
      ["bash", "Shell"],
      ["sh", "Shell"],
      ["zsh", "Shell"],
      ["shellscript", "Shell"],
      ["JSON", "JSON"],
      ["yaml", "YAML"],
      ["yml", "YAML"],
      ["python", "Python"],
      ["py", "Python"],
      ["kotlin", "Kotlin"],
      ["kt", "Kotlin"],
      ["csharp", "C#"],
      ["java", "Java"],
      ["markdown", "Markdown"],
    ] as const)
      expect(fencedCodeMode(info)?.name, info).toBe(name);
    for (const info of ["", "text", "txt", "plaintext", "nonsense"]) expect(fencedCodeMode(info), info).toBeNull();
  });

  it("highlights shell, JSON and YAML blocks in their language and leaves unknown ones plain", async () => {
    const found = highlighted(await markdownState(DOC));
    const has = (text: string, cls: string) => found.some(([s, c]) => s === text && c.split(" ").includes(cls));
    expect(has("# list the pods that are not running", "comment")).toBe(true);
    expect(has("if", "keyword")).toBe(true);
    expect(has("fi", "keyword")).toBe(true);
    expect(has("'Running'", "string")).toBe(true);
    expect(has('"name"', "property")).toBe(true);
    expect(has("3", "number")).toBe(true);
    expect(has("null", "literal")).toBe(true);
    expect(has("# deployment settings", "comment")).toBe(true);
    // YAML keys get the same keyword colour as in a YAML file.
    expect(has("name", "keyword")).toBe(true);
    expect(found.filter(([s]) => s.includes("not a comment") || s.includes("plain"))).toEqual([]);
  });

  it("scopes each recognised block body to its language for per-language colours", async () => {
    const state = await markdownState(DOC);
    const scopes: Array<[string, string]> = [];
    fencedCodeScopes(state, [{ from: 0, to: state.doc.length }], fencedCodeMode).between(
      0,
      state.doc.length,
      (from, to, deco) => {
        scopes.push([state.sliceDoc(from, to).split("\n")[0]!, deco.spec.attributes["data-language"]]);
      },
    );
    expect(scopes).toEqual([
      ["# list the pods that are not running", "Shell"],
      ["{", "JSON"],
      ["# deployment settings", "YAML"],
    ]);
  });
});
