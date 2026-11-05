import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, history } from "@codemirror/commands";
import { enterInDocComment, phpDocTags } from "./docComment";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

const slashStar = EditorState.languageData.of(() => [
  { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
]);
const hash = EditorState.languageData.of(() => [{ commentTokens: { line: "#" } }]);

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
