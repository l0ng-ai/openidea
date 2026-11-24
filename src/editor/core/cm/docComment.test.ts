import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, history } from "@codemirror/commands";
import { java } from "@codemirror/lang-java";
import { languages } from "@codemirror/language-data";
import {
  enterInBlockComment,
  enterInDocComment,
  enterInDocstring,
  cDocTags,
  javaDocTags,
  jsDocTags,
  phpDocTags,
  pythonDocStub,
  type PythonDocFormat,
} from "./docComment";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

const slashStar = EditorState.languageData.of(() => [
  { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
]);
const hash = EditorState.languageData.of(() => [{ commentTokens: { line: "#" } }]);
/** What Lezer PHP reports right after `<?php\n/**`: the HTML around it. */
const html = EditorState.languageData.of(() => [{ commentTokens: { block: { open: "<!--", close: "-->" } } }]);

/** `|` marks the caret. */
function enter(text: string, language = "php", tokens = slashStar) {
  const at = text.indexOf("|");
  const view = new EditorView({
    state: EditorState.create({
      doc: text.replace("|", ""),
      selection: EditorSelection.cursor(at),
      extensions: [tokens, history()],
    }),
  });
  views.push(view);
  const handled = enterInDocComment(language)(view);
  const s = view.state;
  const caret = s.selection.main.head;
  return { handled, view, text: s.doc.sliceString(0, caret) + "|" + s.doc.sliceString(caret) };
}

describe("Enter after /**", () => {
  it("lists a PHP function's parameters and return type, caret on the summary line", () => {
    const r = enter("/**|\nfunction f(int $a, $b): string {}\n/**\n * old\n */\nfunction g() {}");
    expect(r.handled).toBe(true);
    expect(r.text).toBe(
      "/**\n * |\n * @param int $a\n * @param $b\n * @return string\n */\nfunction f(int $a, $b): string {}\n/**\n * old\n */\nfunction g() {}",
    );
    undo(r.view);
    expect(r.view.state.doc.toString()).toBe(
      "/**\nfunction f(int $a, $b): string {}\n/**\n * old\n */\nfunction g() {}",
    );
  });

  it("uses the indentation of the /** line inside a class", () => {
    expect(
      enter("class A {\n    /**|\n    public static function make(?array $o = [], string ...$rest): ?static {}\n}")
        .text,
    ).toBe(
      "class A {\n    /**\n     * |\n     * @param ?array $o\n     * @param string ...$rest\n     * @return ?static\n     */\n    public static function make(?array $o = [], string ...$rest): ?static {}\n}",
    );
  });

  it("gives constructors and void methods no @return; promoted parameters keep their type", () => {
    expect(phpDocTags("public function __construct(private int $a, #[Attr] readonly Foo&Bar $b) {}")).toEqual([
      "@param int $a",
      "@param Foo&Bar $b",
    ]);
    expect(phpDocTags("function run(array &$x = array(1, 2), &$y): void {}")).toEqual(["@param array $x", "@param $y"]);
    expect(phpDocTags("abstract protected function find(int|string $id): ?Model;")).toEqual([
      "@param int|string $id",
      "@return ?Model",
    ]);
  });

  it("closes the comment with an empty summary above anything else, and in other /* */ languages", () => {
    expect(enter("/**|\nclass A {}").text).toBe("/**\n * |\n */\nclass A {}");
    expect(enter("  /**|\n\nconst x = 1;", "javascript").text).toBe("  /**\n   * |\n   */\n\nconst x = 1;");
  });

  it("only breaks the line in an existing doc block, after other text, or without /* */ comments", () => {
    expect(enter("/**|\n * old\n */\nfunction f() {}").handled).toBe(false);
    expect(enter("$a = 1; /**|").handled).toBe(false);
    expect(enter("/** x|").handled).toBe(false);
    expect(enter("/**|", "python", hash).handled).toBe(false);
  });
});

/** Enter through `enterInBlockComment`, in a parsed Java document. */
function enterBlock(text: string) {
  const at = text.indexOf("|");
  const view = new EditorView({
    state: EditorState.create({
      doc: text.replace("|", ""),
      selection: EditorSelection.cursor(at),
      extensions: [java()],
    }),
  });
  views.push(view);
  const handled = enterInBlockComment(view);
  const s = view.state;
  const caret = s.selection.main.head;
  return { handled, text: s.doc.sliceString(0, caret) + "|" + s.doc.sliceString(caret) };
}

describe("Enter after /** in PHP files and C / C++", () => {
  it("closes the stub in a PHP file where the parser reports HTML comments", () => {
    const r = enter("<?php\n/**|\nfunction add(int $a, int $b): int { return $a + $b; }", "php", html);
    expect(r.text).toBe(
      "<?php\n/**\n * |\n * @param int $a\n * @param int $b\n * @return int\n */\nfunction add(int $a, int $b): int { return $a + $b; }",
    );
  });

  it("lists a C or C++ function's parameters and return value", () => {
    expect(enter("<p>/**|</p>", "html", html).handled).toBe(false);
    expect(enter("/**|\nint add(int a, int b) { return a + b; }", "c").text).toBe(
      "/**\n * |\n * @param a\n * @param b\n * @return\n */\nint add(int a, int b) { return a + b; }",
    );
    expect(cDocTags("static const char *name(const struct S *s, size_t n[]);")).toEqual([
      "@param s",
      "@param n",
      "@return",
    ]);
    expect(cDocTags("void run(void) {}")).toEqual([]);
    expect(cDocTags("void *alloc(size_t size, int flags = 0) {}")).toEqual(["@param size", "@param flags", "@return"]);
    expect(cDocTags("template <typename T> std::vector<T> Box<T>::take(const T &x, ...) const {")).toEqual([
      "@param x",
      "@return",
    ]);
    expect(cDocTags("explicit Widget(int w) : w_(w) {}")).toEqual(["@param w"]);
    expect(cDocTags("Widget(int w) {}")).toEqual(["@param w"]);
    expect(cDocTags("struct S { int a; };")).toEqual([]);
    expect(cDocTags("return add(a, b);")).toEqual([]);
    expect(cDocTags('printf("%d", x);')).toEqual([]);
  });
});

describe("Enter in a /* */ comment", () => {
  it("starts the new line with a leading asterisk aligned under the comment's", () => {
    expect(enterBlock("/**\n * xxxx|\n **/\nclass A {}").text).toBe("/**\n * xxxx\n * |\n **/\nclass A {}");
    expect(enterBlock("class A {\n    /**\n     * a|b\n     */\n}").text).toBe(
      "class A {\n    /**\n     * a\n     * |b\n     */\n}",
    );
    expect(enterBlock("class A {\n  /* note|\n  */\n}").text).toBe("class A {\n  /* note\n   * |\n  */\n}");
  });

  it("keeps the closing */ on its own line", () => {
    expect(enterBlock("/** summary |*/\nclass A {}").text).toBe("/** summary\n * |\n */\nclass A {}");
  });

  it("leaves Enter alone outside a comment, before its asterisk, and in a string", () => {
    expect(enterBlock("/* a */ int x;|").handled).toBe(false);
    expect(enterBlock("/**\n|  * a\n */").handled).toBe(false);
    expect(enterBlock('class A { String s = "/* x|"; }').handled).toBe(false);
    expect(enterBlock("// a /* b|").handled).toBe(false);
  });
});

describe("JavaScript / TypeScript documentation stub tags", () => {
  it("lists parameters, and @returns for a declared non-void result", () => {
    expect(jsDocTags("function sum(a: number, b: number): number { return a+b; }")).toEqual([
      "@param a",
      "@param b",
      "@returns",
    ]);
    expect(jsDocTags("export async function load(url, ...rest) {")).toEqual(["@param url", "@param rest"]);
    expect(jsDocTags("const f = async (x: Map<string, number>, y = 2): Promise<void> => {")).toEqual([
      "@param x",
      "@param y",
    ]);
    expect(jsDocTags("  private static parse<T>(input: string): T {")).toEqual(["@param input", "@returns"]);
    expect(jsDocTags("constructor(private readonly db: Db) {")).toEqual(["@param db"]);
  });

  it("finds nothing for calls and statements", () => {
    expect(jsDocTags("foo(a, b);")).toEqual([]);
    expect(jsDocTags("if (x) {")).toEqual([]);
    expect(jsDocTags("const x = 1;")).toEqual([]);
  });
});

describe("Python docstring stub", async () => {
  const python = await languages.find((mode) => mode.name === "Python")!.load();
  const stub = (header: string, body: string[], format: PythonDocFormat) => {
    const text = [header, ...body].join("\n");
    return pythonDocStub(text, python.language.parser.parse(text).topNode.firstChild!, format);
  };
  const header = "def greet(self, name: str, *args, times=2, **kw) -> str:";
  const body = [
    "    if not name:",
    "        raise ValueError('empty')",
    "    def inner():",
    "        raise KeyError",
    "    raise errors.GreetError from None",
    "    raise",
    "    return name",
  ];

  it("lists parameters (not self), the return value and raised exceptions in reST", () => {
    expect(stub(header, body, "rest")).toEqual([
      ":param name:",
      ":param args:",
      ":param times:",
      ":param kw:",
      ":return:",
      ":raises ValueError:",
      ":raises errors.GreetError:",
    ]);
    expect(stub("def __init__(self, x):", [], "rest")).toEqual([":param x:"]);
    expect(stub("async def run() -> None:", [], "rest")).toEqual([]);
  });

  it("reads non-ASCII names, strings and lambdas in parameters, and raise after a colon", () => {
    expect(
      stub(
        "def größe(self, maß: int, s='a,b', t=\")\", key=lambda a, b: a, *, ä=1) -> int:",
        ["    if maß: raise MyÄrger()", "    raise ÄError", "    raise größe_fehler"],
        "rest",
      ),
    ).toEqual([
      ":param maß:",
      ":param s:",
      ":param t:",
      ":param key:",
      ":param ä:",
      ":return:",
      ":raises MyÄrger:",
      ":raises ÄError:",
      ":raises größe_fehler:",
    ]);
  });

  it("writes Epytext, Google and NumPy sections", () => {
    const h = "def f(a, b) -> int:";
    const raising = ["    raise ValueError"];
    expect(stub(h, raising, "epytext")).toEqual(["@param a:", "@param b:", "@return:", "@raise ValueError:"]);
    expect(stub(h, raising, "google")).toEqual([
      "",
      "Args:",
      "    a:",
      "    b:",
      "",
      "Returns:",
      "",
      "Raises:",
      "    ValueError:",
    ]);
    expect(stub(h, raising, "numpy")).toEqual([
      "",
      "Parameters",
      "----------",
      "a",
      "b",
      "",
      "Returns",
      "-------",
      "",
      "Raises",
      "------",
      "ValueError",
    ]);
    expect(stub(h, raising, "plain")).toEqual([]);
    expect(stub("def g(self) -> None:", [], "google")).toEqual([]);
  });

  const enter = (doc: string, format: PythonDocFormat = "rest") => {
    const at = doc.indexOf("|");
    const view = new EditorView({
      state: EditorState.create({ doc: doc.replace("|", ""), selection: { anchor: at }, extensions: [python] }),
    });
    const handled = enterInDocstring(() => format)(view);
    const s = view.state;
    const h = s.selection.main.head;
    const out = s.sliceDoc(0, h) + "|" + s.sliceDoc(h);
    view.destroy();
    return handled ? out : null;
  };

  it("expands Enter between the quotes under a def", () => {
    expect(enter('def greet(name):\n    """|"""')).toBe(
      'def greet(name):\n    """\n    |\n    :param name:\n    :return:\n    """',
    );
  });

  it("reads raised exceptions from the body below and follows the format", () => {
    expect(enter('def check(x) -> None:\n    """|\n    if x:\n        raise TypeError(x)\n\ny = 1', "google")).toBe(
      'def check(x) -> None:\n    """\n    |\n\n    Args:\n        x:\n\n    Raises:\n        TypeError:\n    """\n    if x:\n        raise TypeError(x)\n\ny = 1',
    );
  });

  it("uses Python syntax for multiline parameters and finds only actual raises", () => {
    const header = "async def f(\n    a=1 < 2,  # comment\n    b=sentinel,\n) -> (None):";
    expect(
      stub(
        header,
        [
          '    print(": raise FakeError")',
          '    text = """\n    raise AlsoFake\n    """',
          "    class Nested: raise NestedError",
          "    a = 1; raise (errors.RealError)()",
        ],
        "rest",
      ),
    ).toEqual([":param a:", ":param b:", ":raises errors.RealError:"]);
  });

  it("skips strings that are not a docstring and accepts comments before a docstring", () => {
    expect(enter('def f():\n    if True:\n        """|"""')).toBeNull();
    expect(enter('def f():\n    print(1)\n    """|"""')).toBeNull();
    expect(enter('class C:\n    # explanation\n    """|')).toBe('class C:\n    # explanation\n    """\n    |\n    """');
  });

  it("closes a class docstring with only the summary line", () => {
    expect(enter('class Greeter(Base):\n    """|"""')).toBe('class Greeter(Base):\n    """\n    |\n    """');
  });

  it("leaves a docstring that is not under a def or class alone", () => {
    expect(enter('x = 1\n"""|')).toBeNull();
  });
});

describe("Java documentation stub tags", () => {
  it("lists a method's parameters, return value and exceptions", () => {
    expect(javaDocTags("public String greet(String name, int times) {")).toEqual([
      "@param name",
      "@param times",
      "@return",
    ]);
    expect(
      javaDocTags(
        '@Override\n@SuppressWarnings({"a", "b"})\npublic static <K, V extends Comparable<V>> Map<K, List<V>> group(final Map<K, V> in, String... rest) throws IOException, java.sql.SQLException {',
      ),
    ).toEqual([
      "@param in",
      "@param rest",
      "@param <K>",
      "@param <V>",
      "@return",
      "@throws IOException",
      "@throws java.sql.SQLException",
    ]);
  });

  it("gives void methods and constructors no @return", () => {
    expect(javaDocTags("void run() {")).toEqual([]);
    expect(javaDocTags("public App(int port, String[] args) {")).toEqual(["@param port", "@param args"]);
  });

  it("lists a generic type's parameters and a record's components", () => {
    expect(javaDocTags("public final class Box<T extends Number> {")).toEqual(["@param <T>"]);
    expect(javaDocTags("public record Point<T>(int x, T y) {")).toEqual(["@param x", "@param y", "@param <T>"]);
    expect(javaDocTags("class Plain {")).toEqual([]);
  });

  it("finds nothing for fields and statements", () => {
    expect(javaDocTags("private int count = 0;")).toEqual([]);
    expect(javaDocTags("return foo(x);")).toEqual([]);
  });
});
