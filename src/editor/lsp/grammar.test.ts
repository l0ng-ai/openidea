import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { GrammarProblem, Settings } from "@/bindings";

// "// This is an test." — `an` at columns 11–13.
const problem: GrammarProblem = {
  range: { start: { line: 0, col: 11 }, end: { line: 0, col: 13 } },
  text: "an",
  rule: "AnA",
  message: "Incorrect indefinite article.",
  fixes: [{ range: { start: { line: 0, col: 11 }, end: { line: 0, col: 13 } }, text: "a" }],
  unknownWord: false,
};
const grammarCheck = vi.fn(async () => ({ status: "ok" as const, data: [problem] }));
const settingsSet = vi.fn(async (_scope: string, key: string, value: string) => ({
  status: "ok" as const,
  data: (key === "grammar.disabledRules"
    ? { grammar: { disabledRules: JSON.parse(value) } }
    : { spelling: { projectWords: JSON.parse(value) } }) as unknown as Settings,
}));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, grammarCheck, settingsSet, cancelRequest: vi.fn(async () => {}) },
  };
});

const { grammarExtension, grammarIntentions, fixLabel, isWord } = await import("./grammar");
const { diagnosticsFor } = await import("./diagnostics");
const { lspDoc } = await import("./lsp");
const { useProject } = await import("@/platform/project");
const { offsetAt } = await import("@/features/vcs/CommitGrammar");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  useProject.setState({ project: null, settings: null });
  vi.clearAllMocks();
  vi.useRealTimers();
});

function editor(doc: string) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        lspDoc.of({ doc: 3, path: "/p/a.rs", language: "rust", uiMode: null, readOnly: false }),
        grammarExtension(),
      ],
    }),
  });
  views.push(view);
  return view;
}

describe("Grammar inspection", () => {
  it("labels fixes by what they do and offers dictionary saves for words only", () => {
    expect(fixLabel({ text: "an" }, { text: "a", empty: false })).toBe("Replace with 'a'");
    expect(fixLabel({ text: "the" }, { text: "", empty: false })).toBe("Remove 'the'");
    expect(fixLabel({ text: "and" }, { text: ",", empty: true })).toBe("Insert ','");
    expect(["OpenIDEA", "don't", "re-run"].every(isWord)).toBe(true);
    expect(["two words", "a.b", "x1", ""].some(isWord)).toBe(false);
  });

  it("maps commit message positions to string offsets", () => {
    const text = "Fix it\n\nThis is an test.";
    expect(offsetAt(text, { line: 2, col: 8 })).toBe(text.indexOf("an test"));
    expect(offsetAt(text, { line: 9, col: 0 })).toBe(text.length);
  });

  it("reports problems and applies a fix or turns the rule off at the caret", async () => {
    vi.useFakeTimers();
    useProject.setState({ project: { root: "/p" } as never, settings: {} as never });
    const view = editor("// This is an test.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(grammarCheck).toHaveBeenCalledWith(3, expect.any(Number));
    expect(diagnosticsFor("/p/a.rs")[0]).toMatchObject({ message: "Incorrect indefinite article.", code: "AnA" });

    view.dispatch({ selection: { anchor: 12 } });
    const items = grammarIntentions(view);
    // `an` is a word Harper knows: nothing to save to a dictionary.
    expect(items.map((i) => i.label)).toEqual(["Replace with 'a'", "Disable grammar rule 'AnA'"]);
    await items[0]!.run();
    expect(view.state.doc.toString()).toBe("// This is a test.");
    // The fixed text no longer matches the problem: no fixes until the next check.
    expect(grammarIntentions(view)).toEqual([]);

    // Undo the fix; the next check reports the problem again.
    view.dispatch({ changes: { from: 12, insert: "n" } });
    await vi.advanceTimersByTimeAsync(1000);
    view.dispatch({ selection: { anchor: 12 } });
    await grammarIntentions(view)[1]!.run();
    expect(settingsSet).toHaveBeenCalledWith("global", "grammar.disabledRules", JSON.stringify(["AnA"]));
  });

  it("saves a word Harper does not know to the spelling dictionary", async () => {
    vi.useFakeTimers();
    useProject.setState({ project: { root: "/p" } as never, settings: {} as never });
    grammarCheck.mockResolvedValueOnce({
      status: "ok",
      data: [
        {
          ...problem,
          range: { start: { line: 0, col: 11 }, end: { line: 0, col: 17 } },
          text: "Gradle",
          rule: "ProperNoun",
          fixes: [],
          unknownWord: true,
        },
      ],
    });
    const view = editor("// This is Gradle.");
    await vi.advanceTimersByTimeAsync(1000);
    view.dispatch({ selection: { anchor: 12 } });
    const save = grammarIntentions(view).find((i) => i.id === "grammar.addWord");
    expect(save?.label).toBe("Save 'Gradle' to dictionary");
    await save!.run();
    expect(settingsSet).toHaveBeenCalledWith("project", "spelling.projectWords", JSON.stringify(["gradle"]));
  });
});
