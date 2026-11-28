import { afterEach, describe, expect, it } from "vitest";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import type { PythonDocFormat } from "@/editor/core/cm/docComment";
import { useI18n } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import zh from "@/platform/locales/text/zh.json";
import { completedSyntaxState } from "@/test/syntax";
import { languages } from "@codemirror/language-data";
import { lspDoc } from "../../lsp";
import { languageSemantics } from "../languages";
import { pythonDocstringIntentions } from "./docstring";
import "./index";

const python = (await languages.find((mode) => mode.name === "Python")!.load()).language;
const ctx: EditorDocContext = { doc: 3, path: "/p/m.py", language: "python", uiMode: "Python", readOnly: false };
const views: EditorView[] = [];
const initialSettings = useProject.getState().settings;
const initialI18n = useI18n.getState();

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  useProject.setState({ settings: initialSettings });
  useI18n.setState(initialI18n);
});

function mount(doc: string, marker = "f", unit = "    ", readOnly = false) {
  const declaration = doc.indexOf(`def ${marker}`);
  const markerAt = declaration >= 0 ? declaration + 4 : doc.indexOf(marker);
  const state = completedSyntaxState(
    EditorState.create({
      doc,
      selection: { anchor: markerAt + Math.floor(marker.length / 2) },
      extensions: [python, indentUnit.of(unit), lspDoc.of({ ...ctx, readOnly })],
    }),
  );
  const view = new EditorView({ state });
  views.push(view);
  return view;
}

function marked(view: EditorView): string {
  const caret = view.state.selection.main.head;
  return view.state.doc.sliceString(0, caret) + "|" + view.state.doc.sliceString(caret);
}

function apply(view: EditorView): string {
  const found = pythonDocstringIntentions(view);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ id: "python.insertDocstring", label: "Insert a documentation string stub" });
  found[0]!.run();
  return marked(view);
}

function useFormat(format: PythonDocFormat): void {
  useProject.setState({ settings: { editor: { docstringFormat: format } } as never });
}

const header = ["class Service:", "    async def fetch(", "        self,", "        key: str,", "    ) -> str:"];
const body = ["        if not key:", "            raise ValueError('empty')", "        return key", ""];
const formats: Array<[PythonDocFormat, string[]]> = [
  ["plain", ['        """', "        |", '        """']],
  [
    "rest",
    [
      '        """',
      "        |",
      "        :param key:",
      "        :return:",
      "        :raises ValueError:",
      '        """',
    ],
  ],
  [
    "google",
    [
      '        """',
      "        |",
      "",
      "        Args:",
      "            key:",
      "",
      "        Returns:",
      "",
      "        Raises:",
      "            ValueError:",
      '        """',
    ],
  ],
  [
    "numpy",
    [
      '        """',
      "        |",
      "",
      "        Parameters",
      "        ----------",
      "        key",
      "",
      "        Returns",
      "        -------",
      "",
      "        Raises",
      "        ------",
      "        ValueError",
      '        """',
    ],
  ],
];

describe("Python insert documentation string stub", () => {
  it.each(formats)("inserts an async function's %s stub after its multiline header", (format, stub) => {
    useFormat(format);
    const view = mount([...header, ...body].join("\n"), "fetch");
    expect(apply(view)).toBe([...header, ...stub, ...body].join("\n"));
  });

  it("is registered among Python semantic intentions", () => {
    const view = mount("def f():\n    pass\n", "f");
    expect(languageSemantics("python")!.intentions!(view).map((intention) => intention.id)).toContain(
      "python.insertDocstring",
    );
  });

  it.each([
    'def f():\n    """Already documented."""\n    pass\n',
    "def f():\n    'Already documented.'\n    pass\n",
    'def f():\n    # explanation\n    """Already documented."""\n    pass\n',
    'def f():\n    ("Already " "documented.")\n    pass\n',
    'def f(): "Already documented."\n',
  ])("does not offer the intention for an existing docstring: %s", (doc) => {
    expect(pythonDocstringIntentions(mount(doc))).toEqual([]);
  });

  it("still offers it when a string appears after the first statement", () => {
    const view = mount('def f():\n    pass\n    "not a docstring"\n');
    expect(pythonDocstringIntentions(view)).toHaveLength(1);
  });

  it("only offers it on the function name, with an empty selection in an editable Python document", () => {
    expect(pythonDocstringIntentions(mount("def f(value):\n    return value\n", "value"))).toEqual([]);
    expect(pythonDocstringIntentions(mount("def f():\n    return 1\n", "return"))).toEqual([]);
    expect(pythonDocstringIntentions(mount("class C:\n    pass\n", "C"))).toEqual([]);
    expect(pythonDocstringIntentions(mount("def f():\n    pass\n", "f", "    ", true))).toEqual([]);
    const view = mount("def f():\n    pass\n");
    const name = view.state.doc.line(1).text.indexOf("f");
    view.dispatch({ selection: { anchor: name, head: name + 1 } });
    expect(pythonDocstringIntentions(view)).toEqual([]);
  });

  it("keeps a nested function body's two-space indentation", () => {
    useFormat("plain");
    const view = mount("def outer():\n  def inner(value):\n    return value\n", "inner");
    expect(apply(view)).toBe('def outer():\n  def inner(value):\n    """\n    |\n    """\n    return value\n');
  });

  it("uses tabs for an empty body when tabs are the indent unit", () => {
    useFormat("plain");
    const view = mount("class C:\n\tdef f(self):\n", "f", "\t");
    expect(apply(view)).toBe('class C:\n\tdef f(self):\n\t\t"""\n\t\t|\n\t\t"""\n');
  });

  it("moves an inline body below the new docstring and keeps its comment", () => {
    useFormat("plain");
    const view = mount("def f(value): return value  # keep\n", "f", "  ");
    expect(apply(view)).toBe('def f(value):\n  """\n  |\n  """\n  return value  # keep\n');
  });

  it("keeps a header comment on the definition line", () => {
    useFormat("plain");
    const view = mount("def f(value):  # header\n    return value\n");
    expect(apply(view)).toBe('def f(value):  # header\n    """\n    |\n    """\n    return value\n');
  });

  it("translates the intention label through the active source-text catalog", () => {
    useI18n.setState({ locale: "zh", texts: zh });
    const found = pythonDocstringIntentions(mount("def f():\n    pass\n"));
    expect(found[0]!.label).toBe(zh["Insert a documentation string stub"]);
  });
});
