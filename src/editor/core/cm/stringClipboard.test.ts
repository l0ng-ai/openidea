import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { history, redo, undo } from "@codemirror/commands";
import { validateEditorExtras } from "@/platform/editorSettings";
import { copiedText } from "../clipboardHistory";
import { dispatchPaste } from "./clipboard";
import { findLanguageDescription, loadSupport } from "./languages";
import { prefsExtension } from "./prefs";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

const modes = [
  ["Java", "java"],
  ["Kotlin", "kotlin"],
  ["JavaScript", "javascript"],
  ["TypeScript", "typescript"],
  ["Python", "python"],
  ["Rust", "rust"],
  ["Go", "go"],
  ["C", "c"],
  ["C++", "cpp"],
] as const;

async function make(mode: string, language: string, marked: string, settings: unknown = {}) {
  const support = await loadSupport(findLanguageDescription(mode, "")!);
  const ranges: ReturnType<typeof EditorSelection.cursor>[] = [];
  let doc = "";
  let anchor = 0;
  for (const ch of marked) {
    if (ch === "|") ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === "«") anchor = doc.length;
    else if (ch === "»") ranges.push(EditorSelection.range(anchor, doc.length));
    else doc += ch;
  }
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges),
      extensions: [
        support!,
        EditorState.allowMultipleSelections.of(true),
        history(),
        prefsExtension({
          prefs: validateEditorExtras(settings),
          path: "",
          softWrap: false,
          showWhitespace: false,
          hardWrapAt: 120,
          readOnly: false,
          language,
        }),
      ],
    }),
  });
  views.push(view);
  ensureSyntaxTree(view.state, doc.length, 1000);
  return view;
}

describe("string clipboard", () => {
  it.each(modes)("%s escapes ordinary pastes into a string", async (mode, language) => {
    const view = await make(mode, language, 'value = "|"');
    dispatchPaste(view, 'say "hi"\\path\nnext');
    expect(view.state.doc.toString()).toBe('value = "say \\"hi\\"\\\\path\\nnext"');
  });

  it.each(modes)("%s unescapes copied string contents", async (mode, language) => {
    const view = await make(mode, language, 'value = "«say \\"hi\\"\\\\path\\nnext\\t!»"');
    expect(copiedText(view.state)).toBe('say "hi"\\path\nnext\t!');
  });

  it.each(modes)("%s round-trips pasted control characters and Unicode", async (mode, language) => {
    const view = await make(mode, language, 'value = "|"');
    const text = "😀\0\x01\b\t\n\f\v\u2028\u2029$";
    dispatchPaste(view, text);
    expect(view.state.doc.lines).toBe(1);
    view.dispatch({ selection: { anchor: 9, head: view.state.doc.length - 1 } });
    expect(copiedText(view.state)).toBe(text);
  });

  it.each([
    ["JavaScript", "javascript"],
    ["TypeScript", "typescript"],
    ["Python", "python"],
  ])("%s escapes only the single-quoted string's delimiter", async (mode, language) => {
    const view = await make(mode, language, "value = '|'");
    dispatchPaste(view, `say 'hi' and "bye"`);
    expect(view.state.doc.toString()).toBe(`value = 'say \\'hi\\' and "bye"'`);
  });

  it.each(["input.pastePlain", "input.type", "input.drop"])("leaves %s unchanged", async (userEvent) => {
    const view = await make("JavaScript", "javascript", 'value = "|"');
    dispatchPaste(view, '"\\\n', userEvent);
    expect(view.state.doc.toString()).toBe('value = ""\\\n"');
  });

  it("disables both escaping and unescaping with the setting", async () => {
    const settings = { smartKeys: { escapeOnPaste: false, reformatOnPaste: "none" } };
    const view = await make("Java", "java", 'value = "«a\\nb»"', settings);
    expect(copiedText(view.state)).toBe("a\\nb");
    dispatchPaste(view, '"\\\n');
    expect(view.state.doc.toString()).toBe('value = ""\\\n"');
    expect(validateEditorExtras({}).smartKeys.escapeOnPaste).toBe(true);
  });

  it("escapes Kotlin dollars and unescapes them on copy", async () => {
    const view = await make("Kotlin", "kotlin", 'val s = "|"');
    dispatchPaste(view, "$name ${call()}");
    expect(view.state.doc.toString()).toBe('val s = "\\$name \\${call()}"');
    view.dispatch({ selection: { anchor: 9, head: view.state.doc.length - 1 } });
    expect(copiedText(view.state)).toBe("$name ${call()}");
  });

  it.each([
    ["Java", "java", 'value = """\n|\n"""'],
    ["Kotlin", "kotlin", 'val s = """\n"|"\n"""'],
    ["Kotlin", "kotlin", 'val s = """|"""'],
    ["Kotlin", "kotlin", 'val s = "before |${name} after"'],
    ["Kotlin", "kotlin", 'val s = "before ${name} |after"'],
    ["JavaScript", "javascript", "value = `|`"],
    ["TypeScript", "typescript", "value = `hello |${name}`"],
    ["Python", "python", 'value = r"|"'],
    ["Python", "python", 'value = f"|{name}"'],
    ["Python", "python", 'value = b"|"'],
    ["Python", "python", "value = '''|'''"],
    ["Python", "python", 'value = """\n"|"\n"""'],
    ["Rust", "rust", 'let s = r#"|"#;'],
    ["Rust", "rust", 'let s = r"|";'],
    ["Rust", "rust", 'let s = b"|";'],
    ["Go", "go", 's := `"|"`'],
    ["C++", "cpp", 's = R"("|\n")";'],
    ["Java", "java", "value = '|'"],
    ["Go", "go", "s := '|'"],
    ["JavaScript", "javascript", '// "|"'],
    ["Kotlin", "kotlin", '/* "|" */'],
    ["JavaScript", "javascript", 'value = "unfinished|'],
    ["JavaScript", "javascript", 'value = |"text"'],
    ["JavaScript", "javascript", 'value = "text"|'],
    ["JavaScript", "javascript", 'value = «"text»"'],
    ["JavaScript", "plaintext", 'value = "|"'],
  ])("%s leaves unsupported literals/code unchanged: %s %s", async (mode, language, source) => {
    const view = await make(mode, language, source, { smartKeys: { reformatOnPaste: "none" } });
    const before = view.state;
    const { from, to } = before.selection.main;
    const text = '"\\\n';
    dispatchPaste(view, text);
    expect(view.state.doc.toString()).toBe(before.sliceDoc(0, from) + text + before.sliceDoc(to));
  });

  it.each([
    ["JavaScript", "javascript", 'value = «"a\\nb"»'],
    ["JavaScript", "javascript", 'value = "«a\\nb" + "c»"'],
    ["JavaScript", "javascript", "value = `«a\\nb»`"],
    ["Kotlin", "kotlin", 'val s = """\n"«a\\nb»"\n"""'],
    ["Python", "python", 'value = r"«a\\nb»"'],
    ["Python", "python", 'value = f"«a\\nb»{name}"'],
    ["Rust", "rust", 'let s = r#"«a\\nb»"#;'],
    ["Go", "go", "s := `«a\\nb»`"],
  ])("%s preserves copied source outside one plain string: %s %s", async (mode, language, source) => {
    const view = await make(mode, language, source);
    const { from, to } = view.state.selection.main;
    expect(copiedText(view.state)).toBe(view.state.sliceDoc(from, to));
  });

  it("requires every caret to be inside a plain string", async () => {
    const view = await make("JavaScript", "javascript", 'value = "|"; other = |');
    dispatchPaste(view, '"');
    expect(view.state.doc.toString()).toBe('value = """; other = "');
  });

  it("escapes per-caret inserts with each literal's delimiter and maps all carets", async () => {
    const view = await make("JavaScript", "javascript", `a = "|"; b = '«old»'; c = "|";`);
    dispatchPaste(view, `one"\ntwo'\nthree\\`);
    expect(view.state.doc.toString()).toBe(`a = "one\\""; b = 'two\\''; c = "three\\\\";`);
    for (const range of view.state.selection.ranges) {
      expect(range.empty).toBe(true);
      expect(view.state.sliceDoc(range.head, range.head + 1)).toMatch(/["']/);
    }
  });

  it("copies multiple string selections as decoded fragments", async () => {
    const view = await make("JavaScript", "javascript", "a = \"«one\\n»\"; b = '«two\\t»'");
    expect(copiedText(view.state)).toBe("one\n\ntwo\t");
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(5, 10),
        EditorSelection.range(18, view.state.doc.length),
      ]),
    });
    expect(copiedText(view.state)).toBe(
      view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n"),
    );
  });

  it("replaces a substring and preserves the caret, undo and redo", async () => {
    const view = await make("JavaScript", "javascript", 'value = "before «old» after"');
    dispatchPaste(view, '😀"\nnext');
    expect(view.state.doc.toString()).toBe('value = "before 😀\\"\\nnext after"');
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf(" after"));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('value = "before old after"');
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('value = "before 😀\\"\\nnext after"');
  });

  it.each(['value = "a\\|nb"', 'value = "a«\\»nb"', 'value = "a\\u12|34b"'])(
    "preserves edits that split an existing escape: %s",
    async (source) => {
      const view = await make("JavaScript", "javascript", source);
      const before = view.state;
      const { from, to } = before.selection.main;
      dispatchPaste(view, '"');
      expect(view.state.doc.toString()).toBe(before.sliceDoc(0, from) + '"' + before.sliceDoc(to));
    },
  );

  it.each([
    ["Java", "java", "\\u4f60\\u597d\\141", "你好a"],
    ["Kotlin", "kotlin", "\\u4f60\\u597d", "你好"],
    ["JavaScript", "javascript", "\\u{1f600}\\x21", "😀!"],
    ["Python", "python", "\\U0001f600\\x21\\141", "😀!a"],
    ["Rust", "rust", "\\u{1f600}\\x21", "😀!"],
    ["Go", "go", "\\U0001f600\\x21\\141", "😀!a"],
    ["JavaScript", "javascript", "\\u{bad_name}\\xZZ", "\\u{bad_name}\\xZZ"],
    ["Rust", "rust", "\\xFF\\u{d800}", "\\xFF\\u{d800}"],
  ])("%s decodes supported escapes and preserves invalid escapes", async (mode, language, text, expected) => {
    const view = await make(mode, language, `value = "«${text}»"`);
    expect(copiedText(view.state)).toBe(expected);
  });

  it("handles native paste, copy, cut and rich copy consistently", async () => {
    const view = await make("JavaScript", "javascript", 'value = "|"');
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => 'say "hi"\nnext', files: [] } });
    view.focus();
    view.contentDOM.dispatchEvent(paste);
    expect(view.state.doc.toString()).toBe('value = "say \\"hi\\"\\nnext"');
    view.dispatch({ selection: { anchor: 9, head: view.state.doc.length - 1 } });
    for (const type of ["copy", "cut"]) {
      const data = new Map<string, string>();
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          clearData: () => data.clear(),
          setData: (format: string, text: string) => data.set(format, text),
        },
      });
      view.contentDOM.dispatchEvent(event);
      expect(data.get("text/plain")).toBe('say "hi"\nnext');
      expect(data.has("text/html")).toBe(false);
    }
    expect(view.state.doc.toString()).toBe('value = ""');
  });
});
