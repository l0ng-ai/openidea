import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { javascriptLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { TreeFragment, type Tree } from "@lezer/common";
import { semanticRanges } from "../index";
import { decoratorRanges } from "./index";

// tsserver's legend (vtsls and typescript-language-server send the same one).
const tokenTypes = ["class", "variable", "function", "member", "property"];
const tokenModifiers = ["declaration", "static", "async", "readonly", "defaultLibrary", "local"];

function classes(language: string, lines: string[], tokens: Array<[number, string, string, string[]]>) {
  const doc = Text.of(lines);
  const data = tokens.flatMap(([line, word, type, mods]) => [
    line,
    lines[line]!.indexOf(word),
    word.length,
    tokenTypes.indexOf(type),
    mods.reduce((m, n) => m | (1 << tokenModifiers.indexOf(n)), 0),
  ]);
  const parser = language.startsWith("type") ? typescriptLanguage.parser : javascriptLanguage.parser;
  const ranges = semanticRanges(
    doc,
    { data, tokenTypes, tokenModifiers },
    false,
    language,
    parser.parse(doc.toString()),
  );
  return (line: number, word: string) =>
    ranges.find((r) => r.from === doc.line(line + 1).from + lines[line]!.indexOf(word))?.className;
}

describe("JavaScript and TypeScript semantic tokens (#4059)", () => {
  it.each(["typescript", "javascript", "typescriptreact", "javascriptreact"])(
    "colours a decorator's whole name as a decorator in %s",
    (language) => {
      const lines = [
        "@Component({ selector: 'a' })",
        "class A {",
        "  @core.Input() name = 1;",
        "  @Output",
        "  x = 2;",
        "}",
      ];
      const at = classes(language, lines, [
        [0, "Component", "class", []],
        [2, "core", "variable", ["readonly"]],
        [2, "Input", "function", []],
        [3, "Output", "variable", ["readonly"]],
      ]);
      expect(at(0, "Component")).toBe("cm-sem-annotation");
      expect(at(2, "core")).toBe("cm-sem-annotation");
      expect(at(2, "Input")).toBe("cm-sem-annotation");
      expect(at(3, "Output")).toBe("cm-sem-annotation");
      // The arguments are not part of the name.
      expect(at(0, "selector")).toBeUndefined();
    },
  );

  it("colours the decorator name before the server answers", () => {
    const at = classes("typescript", ["@Injectable()", "class S {}"], []);
    expect(at(0, "Injectable")).toBe("cm-sem-annotation");
  });

  it("marks module-level variables and functions as globals, locals and library symbols not", () => {
    const lines = [
      "const total = inject(Store) + QUESTION_TYPES.length;",
      "function run() { const n = helper(); return Math.max(n, parseInt('1')); }",
    ];
    const at = classes("typescript", lines, [
      [0, "total", "variable", ["declaration", "readonly"]],
      [0, "inject", "function", []],
      [0, "QUESTION_TYPES", "variable", ["readonly"]],
      [1, "run", "function", ["declaration"]],
      [1, "n", "variable", ["declaration", "readonly", "local"]],
      [1, "helper", "function", ["local"]],
      [1, "Math", "variable", ["defaultLibrary"]],
      [1, "parseInt", "function", ["defaultLibrary"]],
    ]);
    expect(at(0, "total")).toBe("cm-sem-declaration cm-sem-global");
    expect(at(0, "inject")).toBe("cm-sem-function cm-sem-global-function");
    expect(at(0, "QUESTION_TYPES")).toBe("cm-sem-global");
    expect(at(1, "run")).toBe("cm-sem-function cm-sem-declaration cm-sem-global-function");
    expect(at(1, "n")).toBe("cm-sem-declaration");
    expect(at(1, "helper")).toBe("cm-sem-function");
    expect(at(1, "Math")).toBe("cm-sem-builtin");
    expect(at(1, "parseInt")).toBe("cm-sem-function cm-sem-builtin");
  });
});

describe("decorator names after an edit", () => {
  const parser = typescriptLanguage.parser;
  const decorated = "@Component({ selector: 'a' })\nexport class Home {\n  @Input() title = ''\n}\n\n";
  const plain = (count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `/** Service ${i}, documented. */\nexport class Service${i} {\n  load(id: number) {\n    return id\n  }\n}\n\n`,
    ).join("");

  /** The decorator names by walking the whole tree: what each edit used to cost. */
  function everyDecorator(tree: Tree): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    tree.iterate({
      enter(ref) {
        if (ref.name !== "Decorator") return;
        let head = ref.node.firstChild?.nextSibling ?? null;
        while (head) {
          if (head.name === "CallExpression") head = head.firstChild;
          else if (head.name === "MemberExpression") {
            if (head.lastChild?.name === "PropertyName") out.push([head.lastChild.from, head.lastChild.to]);
            head = head.firstChild;
          } else {
            if (head.name === "VariableName") out.push([head.from, head.to]);
            head = null;
          }
        }
      },
    });
    return out;
  }

  /** Scans the tree of a file that is `count` services after its decorated classes, then the tree of the same file after one typed letter. */
  function scanAfterTyping(count: number) {
    const doc = decorated + plain(count) + decorated;
    const tree = parser.parse(doc);
    decoratorRanges(tree);
    const at = doc.indexOf("return", doc.length >> 1);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: at, toA: at, fromB: at, toB: at + 1 },
    ]);
    const edited = parser.parse(doc.slice(0, at) + "a" + doc.slice(at), fragments);
    const probe = { visited: 0 };
    const ranges = decoratorRanges(edited, probe);
    return { edited, ranges, visited: probe.visited };
  }

  it("finds the decorators of the whole file", () => {
    const { edited, ranges } = scanAfterTyping(50);
    expect(ranges.map((r) => [r.from, r.to])).toEqual(everyDecorator(edited));
    expect(ranges).toHaveLength(4);
  });

  it("looks at as many tree nodes in a long file as in a short one", () => {
    // The nodes an edit leaves alone were already known to hold no decorator.
    const short = scanAfterTyping(100).visited;
    const long = scanAfterTyping(1600).visited;
    expect(long).toBeLessThan(short * 2);
  });
});
