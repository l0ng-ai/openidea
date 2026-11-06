import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { HierarchyMembers, HierarchyRefactored, WorkspaceEdit } from "@/bindings";

type Result = { status: "ok"; data: unknown } | { status: "error"; error: { kind: string; message: string } };
const ok = (data: unknown): Result => ({ status: "ok", data });
const refused = (message: string): Result => ({ status: "error", error: { kind: "invalidInput", message } });

let members: Result = ok(null);
let refactored: Result = ok(null);
const lspHierarchyMembers = vi.fn(async () => members);
const lspHierarchyRefactor = vi.fn(async () => refactored);
const applyWorkspaceEdit = vi.fn(async () => ok(null));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      lspHierarchyMembers,
      lspHierarchyRefactor,
      applyWorkspaceEdit,
      cancelRequest: vi.fn(async () => undefined),
    },
  };
});
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));
let answer = "continue";
const ask = vi.fn(async () => ({ button: answer }));
vi.mock("@/workbench/messages", () => ({ ask }));

const {
  abstractForced,
  choicesOf,
  conflicts,
  fatalProblem,
  initialRows,
  refactorHierarchy,
  startHierarchyRefactoring,
  useHierarchyDialog,
} = await import("./hierarchy");
const { useLspPopup, closePopup } = await import("@/editor/lsp/popupStore");
const { lspDoc } = await import("@/editor/lsp/lsp");

const INFO: HierarchyMembers = {
  className: "Dog",
  targets: [
    { id: "animal", name: "Animal", qualifiedName: "zoo.Animal", interface: false },
    { id: "speaker", name: "Speaker", qualifiedName: "zoo.Speaker", interface: true },
  ],
  members: [
    { id: "tail", label: "tail : int", kind: "field", selected: false, abstractable: false },
    { id: "bark", label: "bark() : String", kind: "method", selected: true, abstractable: true },
  ],
};
const at = (line: number) => ({ start: { line, col: 0 }, end: { line, col: 0 } });
const EDIT = {
  files: [
    { kind: "edit", path: "/p/Dog.java", edits: [{ range: at(1), new_text: "" }] },
    { kind: "edit", path: "/p/Animal.java", edits: [{ range: at(2), new_text: "String bark() {}" }] },
  ],
} as WorkspaceEdit;
const done = (problems: HierarchyRefactored["problems"], edit: WorkspaceEdit | null = EDIT): Result =>
  ok({ problems, edit } satisfies HierarchyRefactored);

let view: EditorView | null = null;
function editor(readOnly = false) {
  view = new EditorView({
    state: EditorState.create({
      doc: 'class Dog extends Animal { String bark() { return ""; } }',
      selection: { anchor: 30 },
      extensions: [lspDoc.of({ doc: 7, path: "/p/Dog.java", language: "java", uiMode: null, readOnly })],
    }),
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
  closePopup();
  useHierarchyDialog.setState({ request: null });
  answer = "continue";
  vi.clearAllMocks();
});

describe("member choices", () => {
  it("starts from the member at the caret and sends what is checked", () => {
    const rows = initialRows(INFO);
    expect(rows.map((r) => [r.id, r.checked])).toEqual([
      ["tail", false],
      ["bark", true],
    ]);
    rows[0]!.checked = true;
    rows[1]!.makeAbstract = true;
    expect(choicesOf(rows, "pullUp", false)).toEqual([
      { id: "tail", makeAbstract: false },
      { id: "bark", makeAbstract: true },
    ]);
  });

  it("declares methods abstract in an interface, and never abstracts a field", () => {
    const rows = initialRows(INFO).map((r) => ({ ...r, checked: true, makeAbstract: true }));
    const [field, method] = rows;
    expect(abstractForced(method!, "pullUp", true)).toBe(true);
    expect(abstractForced(method!, "pushDown", true)).toBe(false);
    expect(abstractForced(field!, "pullUp", true)).toBe(false);
    rows[1]!.makeAbstract = false;
    expect(choicesOf(rows, "pullUp", true)).toEqual([
      { id: "tail", makeAbstract: false },
      { id: "bark", makeAbstract: true },
    ]);
    expect(choicesOf(rows, "pushDown", false)[1]).toEqual({ id: "bark", makeAbstract: false });
  });

  it("separates fatal problems from the ones the user may accept", () => {
    const problems = [
      { severity: "info", message: "i" },
      { severity: "warning", message: "w" },
      { severity: "error", message: "e" },
    ] as const;
    expect(fatalProblem([...problems])).toBeNull();
    expect(conflicts([...problems])).toEqual(["w", "e"]);
    expect(fatalProblem([...problems, { severity: "fatal", message: "f" }])).toBe("f");
  });
});

describe("Pull Members Up / Push Members Down", () => {
  it("opens the dialog with the server's members, at the caret", async () => {
    members = ok(INFO);
    const v = editor();
    await startHierarchyRefactoring(v, "pullUp");
    expect(lspHierarchyMembers).toHaveBeenCalledWith(expect.any(Number), 7, { line: 0, col: 30 }, "pullUp");
    const request = useHierarchyDialog.getState().request;
    expect(request?.info.className).toBe("Dog");
    expect(request?.kind).toBe("pullUp");
  });

  it("says why when the class can't be refactored, or the file is read-only", async () => {
    members = refused("Type has no super types.");
    await startHierarchyRefactoring(editor(), "pullUp");
    expect(showHint).toHaveBeenCalledWith(expect.anything(), "Cannot perform refactoring. Type has no super types");
    expect(useHierarchyDialog.getState().request).toBeNull();
    view!.destroy();
    await startHierarchyRefactoring(editor(true), "pushDown");
    expect(showHint).toHaveBeenLastCalledWith(expect.anything(), "Cannot perform refactoring. The file is read-only");
    expect(lspHierarchyMembers).toHaveBeenCalledOnce();
  });

  it("applies a clean edit at once", async () => {
    members = ok(INFO);
    refactored = done([{ severity: "info", message: "fine" }]);
    await startHierarchyRefactoring(editor(), "pullUp");
    const request = useHierarchyDialog.getState().request!;
    const choices = [{ id: "bark", makeAbstract: false }];
    expect(await refactorHierarchy(request, "animal", choices, false)).toEqual({ status: "done" });
    expect(lspHierarchyRefactor).toHaveBeenCalledWith(
      expect.any(Number),
      7,
      { line: 0, col: 30 },
      "pullUp",
      "animal",
      choices,
    );
    expect(ask).not.toHaveBeenCalled();
    expect(applyWorkspaceEdit).toHaveBeenCalledWith(EDIT);
  });

  it("asks about conflicts first; Cancel changes nothing and keeps the dialog", async () => {
    members = ok(INFO);
    refactored = done([{ severity: "error", message: "Field 'tail' is not accessible from type 'Animal'" }]);
    await startHierarchyRefactoring(editor(), "pullUp");
    const request = useHierarchyDialog.getState().request!;
    answer = "cancel";
    expect(await refactorHierarchy(request, "animal", [{ id: "bark", makeAbstract: false }], false)).toEqual({
      status: "stay",
    });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Problems Detected" }));
    expect(applyWorkspaceEdit).not.toHaveBeenCalled();
    answer = "continue";
    expect((await refactorHierarchy(request, "animal", [{ id: "bark", makeAbstract: false }], false)).status).toBe(
      "done",
    );
    expect(applyWorkspaceEdit).toHaveBeenCalledOnce();
  });

  it("keeps the dialog with the reason when nothing can be done", async () => {
    members = ok(INFO);
    await startHierarchyRefactoring(editor(), "pushDown");
    const request = useHierarchyDialog.getState().request!;
    refactored = done([{ severity: "fatal", message: "No subclasses" }], null);
    expect(await refactorHierarchy(request, null, [{ id: "bark", makeAbstract: true }], false)).toEqual({
      status: "stay",
      error: "No subclasses",
    });
    refactored = refused("The class changed; open the dialog again");
    expect(await refactorHierarchy(request, null, [{ id: "bark", makeAbstract: true }], false)).toEqual({
      status: "stay",
      error: "The class changed; open the dialog again",
    });
    expect(applyWorkspaceEdit).not.toHaveBeenCalled();
  });

  it("refuses a request whose position an edit has moved", async () => {
    members = ok(INFO);
    const v = editor();
    await startHierarchyRefactoring(v, "pullUp");
    v.dispatch({ changes: { from: 0, insert: "// moved\n" } });
    const request = useHierarchyDialog.getState().request!;
    expect(await refactorHierarchy(request, "animal", [{ id: "bark", makeAbstract: false }], false)).toEqual({
      status: "stay",
      error: "The file changed; open the dialog again",
    });
    expect(lspHierarchyRefactor).not.toHaveBeenCalled();
  });

  it("previews the edit before applying it when asked", async () => {
    members = ok(INFO);
    refactored = done([]);
    await startHierarchyRefactoring(editor(), "pullUp");
    const request = useHierarchyDialog.getState().request!;
    expect((await refactorHierarchy(request, "animal", [{ id: "bark", makeAbstract: false }], true)).status).toBe(
      "done",
    );
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("preview");
    if (popup?.kind !== "preview") return;
    expect(popup.title).toBe("Pull Members Up from 'Dog'");
    expect(popup.summary.files).toBe(2);
    expect(applyWorkspaceEdit).not.toHaveBeenCalled();
    popup.onConfirm();
    await vi.waitFor(() => expect(applyWorkspaceEdit).toHaveBeenCalledWith(EDIT));
  });
});
