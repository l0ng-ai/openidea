import { afterEach, describe, expect, it } from "vitest";
import { languages } from "@codemirror/language-data";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeCompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import type { CompletionItem } from "@/platform/ipc";
import type { EditorDocContext } from "@/editor/api";
import { setInvokeRoute } from "@/platform/tauriCore";
import { lspDoc } from "./lsp";
import { basicCompletion, completionExtension, smartTypeCompletion } from "./completion";
import {
  expectedFromSignature,
  expectedFromText,
  itemType,
  mentionedNames,
  smartItems,
  typeFit,
  typeParts,
} from "./smartCompletion";

const item = (label: string, kind: CompletionItem["kind"], doc?: string): CompletionItem =>
  ({
    label,
    kind,
    detail: null,
    labelDescription: null,
    documentation: doc ? { kind: "markdown", value: "```python\n" + doc + "\n```" } : null,
  }) as CompletionItem;

describe("types", () => {
  it("splits unions, drops module prefixes and reads Optional / Union / typing aliases alike", () => {
    expect(typeParts("Optional[models.Task]")).toEqual(["Task", "None"]);
    expect(typeParts("int | None")).toEqual(["int", "None"]);
    expect(typeParts("Union[int, dict[str, int]]")).toEqual(["int", "dict[str, int]"]);
    expect(typeParts("typing.List[a.b.Task]")).toEqual(["list[Task]"]);
    expect(typeParts("dict[str,int]")).toEqual(typeParts("dict[str, int]"));
    expect(typeParts("List[Optional[int]]")).toEqual(typeParts("list[int | None]"));
  });

  it("reads unions with nested typing aliases and single-member unions", () => {
    expect(typeParts("Optional[int] | list[str]")).toEqual(["int", "None", "list[str]"]);
    expect(typeParts("typing.Union[int]")).toEqual(["int"]);
    expect(typeParts("Union[int, float] | Optional[list[str]]")).toEqual(["int", "float", "list[str]", "None"]);
  });

  it("fits a member of the expected union, a promoted number or a subclass", () => {
    const want = (t: string) => typeParts(t);
    expect(typeFit("date", want("date | None"))).toBe("yes");
    expect(typeFit("date | None", want("date"))).toBe("no");
    expect(typeFit("list[Task]", want("list[Task]"))).toBe("yes");
    expect(typeFit("list[int]", want("list[Task]"))).toBe("no");
    expect(typeFit("int", want("float"))).toBe("yes");
    expect(typeFit("float", want("int"))).toBe("no");
    const bases = (name: string) => ({ Dog: ["Pet"], Pet: ["Animal"] })[name] ?? [];
    expect(typeFit("Dog", want("Animal"), bases)).toBe("yes");
    expect(typeFit("Animal", want("Dog"), bases)).toBe("no");
    expect(typeFit("Any", want("Task"))).toBe("maybe");
    expect(typeFit("list[Unknown]", want("list[Task]"))).toBe("maybe");
  });
});

const python = await languages.find((language) => language.name === "Python")!.load();

describe("expected type", () => {
  const expected = (doc: string) => expectedFromText(EditorState.create({ doc, extensions: python }), doc.length);

  it("reads the active parameter's annotation", () => {
    const label = "(p: Priority, d: date = ...) -> Task";
    const help = (active: number) => ({
      signatures: [
        {
          label,
          documentation: null,
          parameters: [
            [1, 12],
            [14, 27],
          ] as [number, number][],
        },
      ],
      activeSignature: 0,
      activeParameter: active,
    });
    expect(expectedFromSignature(help(0))).toBe("Priority");
    expect(expectedFromSignature(help(1))).toBe("date");
    expect(expectedFromSignature(null)).toBeNull();
  });

  it("reads annotated assignments and return annotations, also around a member access", () => {
    expect(expected("due: date | None = ")).toBe("date | None");
    expect(expected("due: date = task.")).toBe("date");
    expect(expected("due: date = self.items[0].owner().")).toBe("date");
    const lines = ["class A:", "    def f(", "        self,", "    ) -> list[Task]:", "        x = 1"];
    expect(expected([...lines, "        return "].join("\n"))).toBe("list[Task]");
    expect(expected([...lines, "        return self."].join("\n"))).toBe("list[Task]");
    expect(expected("async def g() -> int:\n    return ")).toBe("int");
    expect(expected("def f(\n    value: int,\n) -> str:\n    return ")).toBe("str");
    expect(expected("def h():\n    return ")).toBeNull();
    expect(expected("take(")).toBeNull();
  });

  it("finds the enclosing function rather than a closed sibling definition", () => {
    const lines = ["def outer() -> str:", "    def inner() -> int: return 1", "    if True:", "        return "];
    expect(expected(lines.join("\n"))).toBe("str");
    expect(expected('def f() -> int:\n    """Example:\n    return ')).toBeNull();
  });

  it("takes no keyword or comparison for an annotated assignment", () => {
    expect(expected("else: x = ")).toBeNull();
    expect(expected("ok: bool = a <= ")).toBeNull();
    expect(expected("ok: bool = a == ")).toBeNull();
  });
});

describe("smartItems", () => {
  const items = [
    item("today", "variable", "today: date"),
    item("count", "variable", "count: int"),
    item("make", "function", "def make(\n    n: int\n) -> date"),
    item("later", "function", "async def later() -> date"),
    item("loose", "variable", "loose: Any"),
    item("date", "class"),
    item("d=", "variable"),
    item("None", "keyword"),
    item("True", "keyword"),
  ];
  const resolve = async (i: CompletionItem) => i;
  const opts = {
    typed: "",
    member: false,
    mentioned: mentionedNames("today = make(1) + later() + date(1, 2, 3) + loose"),
  };

  it("keeps variables, calls and classes of the expected type, with that type", async () => {
    const { items: kept, lower } = await smartItems(
      [...items, item("today_utc", "variable", "today_utc: date")],
      "date | None",
      resolve,
      opts,
    );
    expect(kept.map((i) => [i.label, i.labelDescription])).toEqual([
      ["today", "date"],
      ["make", "date"],
      ["loose", "Any"],
      ["date", "date"],
      ["None", null],
    ]);
    expect([...lower].map((i) => i.label)).toEqual(["loose"]);
    expect((await smartItems(items, "bool", resolve, opts)).items.map((i) => i.label)).toEqual(["loose", "True"]);
  });

  it("keeps everything for Any or object", async () => {
    expect((await smartItems(items, "Any", resolve, opts)).items).toHaveLength(items.length);
    expect((await smartItems(items, "object", resolve, opts)).items).toHaveLength(items.length);
  });

  it("resolves attributes after a dot and only what the typed letters match", async () => {
    const asked: string[] = [];
    const track = async (i: CompletionItem) => (asked.push(i.label), i);
    const attrs = [item("due", "field", "due: date"), item("title", "field", "title: str")];
    const kept = await smartItems(attrs, "date", track, { ...opts, member: true, typed: "d" });
    expect(kept.items.map((i) => i.label)).toEqual(["due"]);
    expect(asked).toEqual(["due"]);
  });

  it("sends a few resolves at a time and stops once aborted", async () => {
    const many = Array.from({ length: 40 }, (_, n) => item(`v${n}`, "variable", `v${n}: int`));
    let open = 0;
    let most = 0;
    let sent = 0;
    let aborted = false;
    const slow = async (i: CompletionItem) => {
      sent++;
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 2));
      open--;
      if (sent === 12) aborted = true;
      return i;
    };
    await smartItems(many, "int", slow, {
      ...opts,
      mentioned: new Set(many.map((i) => i.label)),
      aborted: () => aborted,
    });
    expect(most).toBeLessThanOrEqual(8);
    expect(sent).toBeLessThan(40);
  });

  it("reads a type from the documentation", () => {
    expect(
      itemType(item("tl", "variable"), { kind: "markdown", value: "```python\n(variable) tl: TaskList\n```" }),
    ).toBe("TaskList");
  });
});

describe("Smart Type mode", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    setInvokeRoute(null);
  });

  function editor(text: string) {
    const lsp = [item("count", "variable", "count: int"), item("label", "variable", "label: str")].map((i) => ({
      ...i,
      insertText: i.label,
      filterText: null,
      sortText: null,
      labelDetail: null,
      preselect: false,
      deprecated: false,
      isSnippet: false,
      replaceRange: null,
      replaceRangeTab: null,
      additionalEdits: [],
      commitCharacters: [],
      command: null,
      data: null,
      server: 1,
    }));
    setInvokeRoute((cmd, args) => {
      if (cmd === "lsp_completion") return Promise.resolve({ items: lsp, isIncomplete: false });
      if (cmd === "lsp_resolve_completion") return Promise.resolve((args as { item: CompletionItem }).item);
      if (cmd === "nav_inheritance") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    const other = () => ({ from: text.length, options: [{ label: "template" }] });
    view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: { anchor: text.length },
        extensions: [completionExtension(), EditorState.languageData.of(() => [{ openideaCompletion: other }])],
      }),
      parent: document.body,
    });
    view.dispatch({
      effects: StateEffect.appendConfig.of(lspDoc.of({ doc: 1, language: "python" } as EditorDocContext)),
    });
    return view;
  }
  const labels = (v: EditorView) => currentCompletions(v.state).map((c) => c.label);

  it("lists only fitting server items, until Basic or closing the lookup leaves it", async () => {
    const v = editor("count = 1\nlabel = 'a'\nn: int = ");
    smartTypeCompletion(v);
    await expect.poll(() => labels(v), { timeout: 2000 }).toEqual(["count"]);

    // ⌃Space with the Smart list open switches to Basic.
    basicCompletion(v);
    await expect.poll(() => labels(v).sort(), { timeout: 2000 }).toEqual(["count", "label", "template"]);

    smartTypeCompletion(v);
    await expect.poll(() => labels(v), { timeout: 2000 }).toEqual(["count"]);
    closeCompletion(v);
    await new Promise((r) => setTimeout(r, 20));
    startCompletion(v);
    await expect.poll(() => labels(v).sort(), { timeout: 2000 }).toEqual(["count", "label", "template"]);
  });
});
