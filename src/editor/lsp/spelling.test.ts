import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Settings, Typo } from "@/bindings";

let typos: Typo[] = [];
const commentTypo: Typo = { range: { start: { line: 0, col: 3 }, end: { line: 0, col: 9 } }, word: "mesage", context: "comment" };
const spellCheck = vi.fn(async () => ({ status: "ok" as const, data: typos }));
const settingsSet = vi.fn(async (_scope: string, _key: string, value: string) => ({
  status: "ok" as const,
  data: { spelling: { ideWords: [], projectWords: JSON.parse(value), customDictionaries: [] } } as unknown as Settings,
}));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, spellCheck, settingsSet, cancelRequest: vi.fn(async () => {}) },
  };
});

const { spellingExtension, spellingIntentions, isNamePart } = await import("./spelling");
const { diagnosticsFor, toLintDiagnostics, diagnosticMarks } = await import("./diagnostics");
const { lspDoc } = await import("./lsp");
const { useProject } = await import("@/platform/project");

const views: EditorView[] = [];
const ALL = { code: true, literals: true, comments: true };
beforeEach(() => {
  typos = [commentTypo];
});
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
        lspDoc.of({ doc: 7, path: "/p/a.rs", language: "rust", uiMode: null, readOnly: false }),
        spellingExtension(),
      ],
    }),
  });
  views.push(view);
  return view;
}

async function settle() {
  await vi.advanceTimersByTimeAsync(1000);
}

describe("Typo inspection", () => {
  it("renames a name part only to words that fit in an identifier", () => {
    expect(["message", "menage", "Mesa", "ünïcode1"].every(isNamePart)).toBe(true);
    expect(["me sage", "me-sage", "mes_age", ""].some(isNamePart)).toBe(false);
  });

  it("reports typos at the Typo level and offers fixes at the caret", async () => {
    vi.useFakeTimers();
    useProject.setState({ project: { root: "/p" } as never, settings: {} as never });
    const view = editor("// mesage here");
    await settle();
    expect(spellCheck).toHaveBeenCalledWith(7, ALL, expect.any(Number));
    const [diag] = diagnosticsFor("/p/a.rs");
    expect(diag).toMatchObject({ message: "Typo: In word 'mesage'", severity: "info", typo: true });
    const lint = toLintDiagnostics(view.state.doc, diagnosticsFor("/p/a.rs"));
    expect(lint[0]!.markClass).toBe("cm-lsp-typo");
    expect(diagnosticMarks(lint)).toEqual([]);

    view.dispatch({ selection: { anchor: 5 } });
    expect(spellingIntentions(view).map((i) => i.label)).toEqual([
      "Typo: Change to…",
      "Save 'mesage' to project-level dictionary",
      "Save 'mesage' to application-level dictionary",
    ]);
    // IDEA's → menu: the dictionaries and the inspection's controls.
    expect(spellingIntentions(view)[0]!.submenu?.map((i) => ("label" in i ? i.label : "-"))).toEqual([
      "Save 'mesage' to project-level dictionary",
      "Save 'mesage' to application-level dictionary",
      "-",
      "Edit inspection profile setting",
      "Disable inspection",
    ]);
    view.dispatch({ selection: { anchor: 12 } });
    expect(spellingIntentions(view)).toEqual([]);

    view.dispatch({ selection: { anchor: 5 } });
    await spellingIntentions(view)[1]!.run();
    expect(settingsSet).toHaveBeenCalledWith("project", "spelling.projectWords", JSON.stringify(["mesage"]));
    // The dictionary change re-checks the file.
    await settle();
    expect(spellCheck).toHaveBeenCalledTimes(2);
  });

  it("does not run while the inspection is disabled", async () => {
    vi.useFakeTimers();
    useProject.setState({
      settings: { inspections: { default: { "builtin:spelling": { enabled: false } } } } as never,
    });
    const view = editor("// mesage");
    await settle();
    expect(spellCheck).not.toHaveBeenCalled();
    view.dispatch({ selection: { anchor: 5 } });
    expect(spellingIntentions(view)).toEqual([]);
  });

  it("renames declared names instead of replacing one occurrence", async () => {
    vi.useFakeTimers();
    typos = [{ ...commentTypo, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 6 } }, context: "code" }];
    useProject.setState({ project: { root: "/p" } as never, settings: {} as never });
    const view = editor("mesage = 1\nprint(mesage)");
    await settle();
    view.dispatch({ selection: { anchor: 2 } });
    expect(spellingIntentions(view)[0]!.label).toBe("Typo: Rename to…");
  });

  it("checks only what the Typo options include, and re-checks when they change", async () => {
    vi.useFakeTimers();
    const options = (o: Record<string, boolean>) =>
      ({ inspections: { default: { "builtin:spelling": { options: o } } } }) as never;
    useProject.setState({ project: { root: "/p" } as never, settings: options({ processCode: false, processLiterals: false }) });
    editor("// mesage");
    await settle();
    expect(spellCheck).toHaveBeenLastCalledWith(7, { code: false, literals: false, comments: true }, expect.any(Number));
    useProject.setState({ settings: options({ processComments: false }) });
    await settle();
    expect(spellCheck).toHaveBeenCalledTimes(2);
    expect(spellCheck).toHaveBeenLastCalledWith(7, { code: true, literals: true, comments: false }, expect.any(Number));
  });

  it("keeps lint conversion of plain info diagnostics unchanged", () => {
    const doc = Text.of(["abc"]);
    const out = toLintDiagnostics(doc, [
      { range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } }, severity: "info", message: "m", source: null, code: null },
    ]);
    expect(out[0]!.markClass).toBeUndefined();
  });
});
