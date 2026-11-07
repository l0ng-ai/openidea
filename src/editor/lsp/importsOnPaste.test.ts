import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState, StateEffect, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction, Diagnostic, TextEdit } from "@/bindings";
import type { DiagnosticPublication } from "./diagnostics";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolve: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  listener: undefined as ((event?: DiagnosticPublication) => void) | undefined,
}));
vi.mock("./diagnostics", () => ({
  subscribeDiagnostics: (_path: string, listener: typeof mocks.listener) => {
    mocks.listener = listener;
    return () => {
      mocks.listener = undefined;
    };
  },
}));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      lspCodeActionQuery: mocks.query,
      lspResolveCodeAction: mocks.resolve,
      applyWorkspaceEdit: mocks.apply,
      cancelRequest: mocks.cancel,
    },
  };
});
import {
  importsOnPasteExtension,
  mergePastedImports,
  pastedDiagnostics,
  pastedImport,
  withCommandEdit,
} from "./importsOnPaste";
import { lspDoc } from "./lsp";
import { closePopup, openPopup, useLspPopup } from "./popupStore";
import { useProject } from "@/platform/project";
import { validateEditorExtras } from "@/platform/editorSettings";
import { documentSynced, mirroredChange } from "@/editor/api";

const path = "/p/Main.java";
const range = (line = 0, col = 0, endCol = 9) => ({ start: { line, col }, end: { line, col: endCol } });
const diagnostic = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  range: range(),
  severity: "error",
  message: "ArrayList cannot be resolved to a type",
  code: "16777218",
  source: "Java",
  ...over,
});
const edit = (text = "import java.util.ArrayList;\n", r = range(0, 0, 0)): TextEdit => ({ range: r, new_text: text });
const action = (over: Partial<CodeAction> = {}): CodeAction => ({
  title: "Import 'ArrayList' (java.util)",
  kind: "quickfix",
  isPreferred: false,
  disabledReason: null,
  edit: { files: [{ kind: "edit", path, edits: [edit()], version: 7 }], preconditions: [{ path, hash: "snapshot" }] },
  command: null,
  data: null,
  server: 1,
  ...over,
});
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const views: EditorView[] = [];
const mode = (importsOnPaste: string) =>
  useProject.setState({ settings: { editor: { autoImport: { importsOnPaste } } } as never });
function editor(readOnly = false, stateReadOnly = false, compartment?: Compartment) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      extensions: [
        lspDoc.of({ doc: 3, path, language: "java", virtual: false, readOnly, uiMode: "code" }),
        compartment ? compartment.of(EditorState.readOnly.of(stateReadOnly)) : EditorState.readOnly.of(stateReadOnly),
        importsOnPasteExtension(),
      ],
    }),
  });
  views.push(view);
  return view;
}
function paste(view: EditorView, text = "ArrayList<String> items;", userEvent = "input.paste") {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent });
}
async function publish(items = [diagnostic()], source = "jdtls") {
  await vi.advanceTimersByTimeAsync(0);
  mocks.listener?.({ source, items });
}
const settle = () => vi.advanceTimersByTimeAsync(250);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mode("ask");
  mocks.query.mockResolvedValue(ok({ actions: [action()], advertisedKinds: ["quickfix"] }));
  mocks.resolve.mockImplementation(async (_doc, a) => ok({ ...a, edit: action().edit }));
  mocks.apply.mockResolvedValue(ok(null));
  mocks.cancel.mockResolvedValue(ok(null));
});
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  closePopup();
  useProject.setState({ settings: null });
  vi.useRealTimers();
});

describe("paste import selection", () => {
  it("limits unresolved diagnostics to pasted ranges, using UTF-16 offsets", () => {
    const doc = Text.of(["😀 ArrayList old", "missing"]);
    const inside = diagnostic({ range: range(0, 3, 12) });
    const warning = diagnostic({
      range: range(1, 0, 7),
      severity: "warning",
      message: '"missing" is not defined',
      code: "reportUndefinedVariable",
    });
    expect(
      pastedDiagnostics(
        doc,
        [
          { from: 3, to: 12 },
          { from: 17, to: 24 },
        ],
        [
          inside,
          warning,
          diagnostic({ range: range(0, 0, 2) }),
          diagnostic({ range: range(0, 3, 13) }),
          diagnostic({ range: range(0, 3, 3) }),
          diagnostic({ range: range(8, 0, 4) }),
          diagnostic({ range: range(0, 3, 90) }),
          diagnostic({ range: range(0, 12, 3) }),
          diagnostic({ range: inside.range, message: "Incompatible types", code: "2322" }),
          diagnostic({ range: inside.range, unnecessary: true }),
        ],
      ),
    ).toEqual([inside, warning]);
  });

  it.each([
    "Import 'ArrayList' (java.util)",
    'Add import from "react"',
    'Update import from "react"',
    "Import `std::collections::HashMap`",
    'Add import: "fmt"',
    "Add 'useState' to existing import declaration from 'react'",
  ])("recognizes the import quick fix %s", (title) => {
    expect(pastedImport([action({ title }), action({ title: "Create class ArrayList" })])?.title).toBe(title);
  });

  it("skips ambiguous, disabled, source and unrelated import actions", () => {
    expect(pastedImport([action(), action({ title: "Import 'ArrayList' (other)" })])).toBeNull();
    for (const over of [
      { disabledReason: "unavailable" },
      { disabledReason: "" },
      { kind: "source.organizeImports" },
      { kind: "quickfixOther" },
      { title: "Remove unused import" },
      { title: "Import all missing names" },
      { title: "Optimize imports" },
    ])
      expect(pastedImport([action(over)])).toBeNull();
    expect(pastedImport([action({ isPreferred: true }), action({ title: "Import 'ArrayList' (other)" })])).toBeNull();
  });

  it("merges independent insertions once, preserving preconditions and versions", () => {
    const first = action();
    const second = action({
      edit: { ...first.edit!, files: [{ kind: "edit", path, version: 7, edits: [edit("import java.util.List;\n")] }] },
    });
    const merged = mergePastedImports(path, [first, second, first])!;
    expect(merged.preconditions).toEqual(first.edit!.preconditions);
    expect(merged.files).toEqual([
      { kind: "edit", path, version: 7, edits: [edit("import java.util.ArrayList;\nimport java.util.List;\n")] },
    ]);
    expect(first.edit!.files[0]).toEqual(action().edit!.files[0]);
  });

  it("rejects conflicting replacements, cross-file edits, file operations, and command-only fixes", () => {
    const replacing = action({
      edit: { files: [{ kind: "edit", path, edits: [edit("import A;", range(0, 0, 10))] }] },
    });
    const conflict = action({ edit: { files: [{ kind: "edit", path, edits: [edit("import B;", range(0, 0, 10))] }] } });
    expect(mergePastedImports(path, [replacing, conflict])).toBeNull();
    expect(mergePastedImports(path, [action({ edit: null })])).toBeNull();
    expect(
      mergePastedImports(path, [action({ edit: { files: [{ kind: "create", path, overwrite: false }] } })]),
    ).toBeNull();
    expect(
      mergePastedImports(path, [action({ edit: { files: [{ kind: "edit", path: "/other", edits: [edit()] }] } })]),
    ).toBeNull();
    expect(
      mergePastedImports(path, [action(), action({ edit: { files: [], preconditions: [{ path, hash: "changed" }] } })]),
    ).toBeNull();
  });

  it("defaults missing and invalid settings to ask", () => {
    for (const raw of [
      undefined,
      {},
      { autoImport: { importsOnPaste: "invalid" } },
      { autoImport: { importsOnPaste: 4 } },
    ])
      expect(validateEditorExtras(raw).autoImport.importsOnPaste).toBe("ask");
    for (const importsOnPaste of ["ask", "always", "never"])
      expect(validateEditorExtras({ autoImport: { importsOnPaste } }).autoImport.importsOnPaste).toBe(importsOnPaste);
  });
});

describe("imports on paste", () => {
  it("waits for the paste to sync and then requires a new diagnostic publication", async () => {
    const view = editor();
    let synced!: () => void;
    const sync = new Promise<void>((resolve) => {
      synced = resolve;
    });
    view.dispatch({ effects: StateEffect.appendConfig.of(documentSynced.of(() => sync)) });
    paste(view);
    await publish();
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
    synced();
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
    await publish();
    await settle();
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("tracks each pasted range in a multi-cursor transaction", async () => {
    const view = editor();
    view.dispatch({ changes: { from: 0, insert: "old\nold" } });
    view.dispatch({
      changes: [
        { from: 0, insert: "ArrayList" },
        { from: 4, insert: "List" },
      ],
      userEvent: "input.paste",
    });
    await publish([diagnostic(), diagnostic({ range: range(1, 0, 4) }), diagnostic({ range: range(0, 9, 12) })]);
    await settle();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.map((call) => call[2])).toEqual([range(), range(1, 0, 4)]);
  });

  it("ignores paste transactions mirrored from another editor", async () => {
    const view = editor();
    view.dispatch({
      changes: { from: 0, insert: "ArrayList" },
      userEvent: "input.paste",
      annotations: mirroredChange.of(true),
    });
    await publish();
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requests quick fixes only after fresh diagnostics and asks by default", async () => {
    const view = editor();
    await publish();
    paste(view);
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
    mocks.listener?.(); // A local inspection/profile update is not fresh LSP diagnostics.
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
    await publish();
    await settle();
    expect(mocks.query.mock.calls[0]!.slice(1)).toEqual([3, range(), ["quickfix"]]);
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("importsOnPaste");
    expect(mocks.apply).not.toHaveBeenCalled();
    if (popup?.kind === "importsOnPaste") popup.onApply([0]);
    await settle();
    expect(mocks.apply).toHaveBeenCalledWith(mergePastedImports(path, [action()]));
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("Always applies all distinct imports in one edit", async () => {
    mode("always");
    const view = editor();
    paste(view, "ArrayList List ArrayList");
    const second = action({
      title: "Import 'List' (java.util)",
      edit: { files: [{ kind: "edit", path, edits: [edit("import java.util.List;\n")] }] },
    });
    mocks.query.mockResolvedValueOnce(ok({ actions: [action()] })).mockResolvedValueOnce(ok({ actions: [second] }));
    await publish([diagnostic(), diagnostic({ range: range(0, 10, 14) }), diagnostic({ range: range(0, 15, 24) })]);
    await settle();
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.apply).toHaveBeenCalledWith(mergePastedImports(path, [action(), second]));
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("collects a large paste within the deadline and lists a repeated import once", async () => {
    const view = editor();
    paste(view, Array.from({ length: 40 }, () => "ArrayList").join("\n"));
    await publish(Array.from({ length: 40 }, (_value, line) => diagnostic({ range: range(line) })));
    await settle();
    expect(mocks.query).toHaveBeenCalledTimes(40);
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind === "importsOnPaste" && popup.imports).toEqual([action().title]);
  });

  it.each(["input.pastePlain", "input.paste.image", "input.type"])("ignores %s", async (event) => {
    paste(editor(), undefined, event);
    await publish();
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(["never", "readOnly", "stateReadOnly"])("ignores %s", async (setting) => {
    if (setting === "never") mode("never");
    paste(editor(setting === "readOnly", setting === "stateReadOnly"));
    await publish();
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("ignores diagnostics outside the paste and unrelated problems inside it", async () => {
    const view = editor();
    view.dispatch({ changes: { from: 0, insert: "ArrayList old;\n" } });
    paste(view);
    await publish([diagnostic(), diagnostic({ range: range(1), message: "Type mismatch", code: "other" })]);
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("resolves lazy fixes and skips ambiguous fixes", async () => {
    const view = editor();
    paste(view, "ArrayList List");
    mocks.query
      .mockResolvedValueOnce(ok({ actions: [action({ edit: null, data: "lazy" })] }))
      .mockResolvedValueOnce(ok({ actions: [action(), action({ title: "Import other.List" })] }));
    await publish([diagnostic(), diagnostic({ range: range(0, 10, 14) })]);
    await settle();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind === "importsOnPaste" && popup.imports).toEqual([action().title]);
  });

  it("ignores lazy resolution after another paste and skips fixes with no inspectable edit", async () => {
    let resolved!: (v: ReturnType<typeof ok<CodeAction>>) => void;
    mocks.query.mockResolvedValueOnce(ok({ actions: [action({ edit: null, data: "lazy" })] }));
    mocks.resolve.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolved = r;
        }),
    );
    const view = editor();
    paste(view);
    await publish();
    await settle();
    paste(view, "\nArrayList");
    resolved(ok(action()));
    await settle();
    expect(useLspPopup.getState().popup).toBeNull();
    const commandOnly = action({ edit: null, command: { title: "Import", command: "server.import", arguments: [] } });
    mocks.query.mockResolvedValueOnce(ok({ actions: [commandOnly] }));
    mocks.resolve.mockResolvedValueOnce(ok(commandOnly));
    await publish([diagnostic({ range: range(1) })]);
    await settle();
    expect(useLspPopup.getState().popup).toBeNull();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("Cancel and an empty selection leave the pasted code alone", async () => {
    const view = editor();
    paste(view);
    await publish();
    await settle();
    closePopup();
    expect(mocks.apply).not.toHaveBeenCalled();
    paste(view, "\nArrayList");
    await publish([diagnostic({ range: range(1) })]);
    await settle();
    const popup = useLspPopup.getState().popup;
    if (popup?.kind === "importsOnPaste") popup.onApply([]);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("cancels on edits and ignores a late query result", async () => {
    let finish!: (v: ReturnType<typeof ok<{ actions: CodeAction[] }>>) => void;
    mocks.query.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const view = editor();
    paste(view);
    await publish();
    await settle();
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.query.mock.calls[0]![0]);
    finish(ok({ actions: [action()] }));
    await settle();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("expires both missing diagnostics and a stalled query", async () => {
    const view = editor();
    paste(view);
    await vi.advanceTimersByTimeAsync(8100);
    await publish();
    await settle();
    expect(mocks.query).not.toHaveBeenCalled();
    paste(view, "\nArrayList");
    mocks.query.mockImplementationOnce(() => new Promise(() => {}));
    await publish([diagnostic({ range: range(1) })]);
    await vi.advanceTimersByTimeAsync(8100);
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.query.mock.calls[0]![0]);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("closes stale dialogs on document edits and editor destruction", async () => {
    const view = editor();
    paste(view);
    await publish();
    await settle();
    expect(useLspPopup.getState().popup?.kind).toBe("importsOnPaste");
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(useLspPopup.getState().popup).toBeNull();
    paste(view, "\nArrayList");
    await publish([diagnostic({ range: range(1) })]);
    await settle();
    view.destroy();
    expect(useLspPopup.getState().popup).toBeNull();
    expect(mocks.listener).toBeUndefined();
  });

  it("cancels when reconfigured read-only and handles server errors silently", async () => {
    const compartment = new Compartment();
    const view = editor(false, false, compartment);
    paste(view);
    await publish();
    await settle();
    view.dispatch({ effects: compartment.reconfigure(EditorState.readOnly.of(true)) });
    expect(useLspPopup.getState().popup).toBeNull();
    view.dispatch({ effects: compartment.reconfigure(EditorState.readOnly.of(false)) });
    mocks.query.mockRejectedValueOnce(new Error("server stopped"));
    paste(view, "\nArrayList");
    await publish([diagnostic({ range: range(1) })]);
    await settle();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("does not replace another open popup", async () => {
    openPopup({ kind: "list", anchor: { x: 0, y: 0 }, title: "Intentions", items: [] });
    paste(editor());
    await publish();
    await settle();
    expect(useLspPopup.getState().popup?.kind).toBe("list");
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

describe("withCommandEdit", () => {
  const path = "/p/src/cart.ts";
  const action = (args: unknown[]): CodeAction => ({
    title: 'Update import from "./money.ts"',
    kind: "quickfix",
    isPreferred: false,
    disabledReason: null,
    edit: null,
    command: { title: "", command: "_typescript.applyWorkspaceEdit", arguments: args as string[] },
    data: null,
    server: 2,
  });
  const lspEdit = {
    documentChanges: [
      {
        textDocument: { uri: "file:///p/src/cart.ts", version: 6 },
        edits: [
          { range: { start: { line: 0, character: 26 }, end: { line: 0, character: 26 } }, newText: "formatMoney, " },
        ],
      },
    ],
  };

  it("lifts a command's LSP workspace edit for the pasted file", () => {
    expect(withCommandEdit(action([lspEdit]), path).edit).toEqual({
      files: [
        {
          kind: "edit",
          path,
          version: 6,
          edits: [{ range: { start: { line: 0, col: 26 }, end: { line: 0, col: 26 } }, new_text: "formatMoney, " }],
        },
      ],
    });
  });

  it("leaves commands that touch other files or carry no edit alone", () => {
    const other = { changes: { "file:///p/src/money.ts": lspEdit.documentChanges[0]!.edits } };
    expect(withCommandEdit(action([other]), path).edit).toBeNull();
    expect(withCommandEdit(action(["not json"]), path).edit).toBeNull();
  });
});
