import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction, WorkspaceEdit } from "@/bindings";

type Result = { status: "ok"; data: unknown } | { status: "error"; error: { kind: string; message: string } };
const ok = (data: unknown): Result => ({ status: "ok", data });
const refused = (message: string): Result => ({ status: "error", error: { kind: "invalidInput", message } });

let resolved: Result = ok(null);
const lspResolveCodeAction = vi.fn(async (_doc: number, _action: CodeAction) => resolved);
const applyWorkspaceEdit = vi.fn(async () => ok(null));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, lspResolveCodeAction, applyWorkspaceEdit, cancelRequest: vi.fn(async () => {}) },
  };
});

const {
  changeOf,
  changeSignatureData,
  initialRows,
  isChanged,
  moveRow,
  newRow,
  parameterText,
  refactorChangeSignature,
  rowProblem,
  signatureText,
  startChangeSignature,
  useChangeSignatureDialog,
} = await import("./changeSignature");
const { useLspPopup, closePopup } = await import("@/editor/lsp/popupStore");
const { lspDoc } = await import("@/editor/lsp/lsp");

const SIGNATURE = {
  name: "App\\repeat",
  returnType: "string",
  constructor: false,
  parameters: [
    {
      oldIndex: 0,
      name: "count",
      type: "int",
      defaultValue: "",
      callValue: "",
      byRef: false,
      variadic: false,
      promoted: false,
    },
    {
      oldIndex: 1,
      name: "label",
      type: "string",
      defaultValue: "'x'",
      callValue: "",
      byRef: false,
      variadic: false,
      promoted: false,
    },
  ],
};
const DATA = { position: { line: 3, col: 9 }, signature: SIGNATURE, change: null };
const ACTION: CodeAction = {
  title: "Change signature of 'App\\repeat'",
  kind: "refactor.rewrite.changeSignature",
  isPreferred: false,
  disabledReason: null,
  edit: null,
  command: null,
  data: JSON.stringify(DATA),
  server: 3,
};
const at = (line: number) => ({ start: { line, col: 0 }, end: { line, col: 0 } });
const EDIT = {
  files: [
    { kind: "edit", path: "/p/util.php", edits: [{ range: at(3), new_text: "x" }] },
    { kind: "edit", path: "/p/main.php", edits: [{ range: at(1), new_text: "y" }] },
  ],
} as WorkspaceEdit;

let view: EditorView | null = null;
function editor() {
  view = new EditorView({
    state: EditorState.create({
      doc: "<?php\nfunction repeat(int $count, string $label = 'x'): string {}\n",
      selection: { anchor: 16 },
      extensions: [lspDoc.of({ doc: 7, path: "/p/util.php", language: "php", uiMode: null, readOnly: false })],
    }),
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
  closePopup();
  useChangeSignatureDialog.setState({ request: null });
  resolved = ok(null);
  vi.clearAllMocks();
});

describe("the parameter table", () => {
  it("reads the signature from actions that ask for it, and only those", () => {
    expect(changeSignatureData(ACTION)?.signature.name).toBe("App\\repeat");
    expect(changeSignatureData({ ...ACTION, edit: EDIT })).toBeNull();
    expect(changeSignatureData({ ...ACTION, kind: "refactor.rewrite" })).toBeNull();
    expect(changeSignatureData({ ...ACTION, data: "not json" })).toBeNull();
    expect(changeSignatureData({ ...ACTION, data: null })).toBeNull();
  });

  it("previews the signature as PHP writes it", () => {
    const rows = initialRows(SIGNATURE);
    expect(signatureText("repeat", rows, "string")).toBe("repeat(int $count, string $label = 'x'): string");
    expect(parameterText({ type: "", byRef: true, variadic: true, name: "$rest", defaultValue: "" })).toBe("&...$rest");
    expect(signatureText("f", [], " ")).toBe("f()");
  });

  it("moves rows within the table", () => {
    const rows = initialRows(SIGNATURE);
    expect(moveRow(rows, 1, -1).map((r) => r.name)).toEqual(["label", "count"]);
    expect(moveRow(rows, 1, 1).map((r) => r.name)).toEqual(["count", "label"]);
    expect(moveRow(rows, 0, -1)).toEqual(rows);
  });

  it("says what is wrong before asking the server", () => {
    const rows = initialRows(SIGNATURE);
    expect(rowProblem(rows)).toBeNull();
    expect(rowProblem([...rows, newRow()])).toBe("Every parameter needs a name");
    expect(rowProblem([...rows, { ...newRow(), name: "count" }])).toBe("There are two parameters named '$count'");
    expect(rowProblem([...rows, { ...newRow(), name: "upper" }])).toBe(
      "The new parameter '$upper' needs a default value or a value for the existing calls",
    );
    expect(rowProblem([...rows, { ...newRow(), name: "upper", callValue: "false" }])).toBeNull();
    expect(rowProblem([{ ...rows[0]!, variadic: true }, rows[1]!])).toBe(
      "The variadic parameter '$count' must be the last one",
    );
  });

  it("knows when nothing changed, and sends the new signature", () => {
    const rows = initialRows(SIGNATURE);
    expect(isChanged(SIGNATURE, rows, "string")).toBe(false);
    expect(isChanged(SIGNATURE, rows, "?string")).toBe(true);
    expect(isChanged(SIGNATURE, moveRow(rows, 0, 1), "string")).toBe(true);
    const renamed = [{ ...rows[0]!, name: "$times" }, rows[1]!, { ...newRow(), name: "upper", callValue: " true " }];
    expect(isChanged(SIGNATURE, renamed, "string")).toBe(true);
    const change = changeOf(SIGNATURE, renamed, " string ");
    expect(change.returnType).toBe("string");
    expect(change.parameters.map((p) => [p.oldIndex, p.name, p.callValue])).toEqual([
      [0, "times", ""],
      [1, "label", ""],
      [null, "upper", "true"],
    ]);
    expect(change.parameters[0]).not.toHaveProperty("key");
  });
});

describe("Change Signature", () => {
  it("opens the dialog for an action that asks for the new signature", () => {
    const v = editor();
    expect(startChangeSignature(v, [{ ...ACTION, data: null }])).toBe(false);
    expect(useChangeSignatureDialog.getState().request).toBeNull();
    expect(startChangeSignature(v, [ACTION])).toBe(true);
    const request = useChangeSignatureDialog.getState().request!;
    expect(request.doc).toBe(7);
    expect(request.data.signature.parameters).toHaveLength(2);
  });

  it("has the server resolve the action with the new signature and applies the edit", async () => {
    resolved = ok({ ...ACTION, edit: EDIT, data: null });
    startChangeSignature(editor(), [ACTION]);
    const request = useChangeSignatureDialog.getState().request!;
    const change = changeOf(SIGNATURE, moveRow(initialRows(SIGNATURE), 0, 1), "string");
    expect(await refactorChangeSignature(request, change, false)).toEqual({ status: "done" });
    const sent = lspResolveCodeAction.mock.calls[0]!;
    expect(sent[0]).toBe(7);
    const data = JSON.parse(sent[1].data!);
    expect(data.position).toEqual(DATA.position);
    expect(data.change.parameters.map((p: { name: string }) => p.name)).toEqual(["label", "count"]);
    expect(applyWorkspaceEdit).toHaveBeenCalledWith(EDIT);
  });

  it("keeps the dialog with the server's reason", async () => {
    resolved = refused("'$total' is already used in App\\repeat");
    startChangeSignature(editor(), [ACTION]);
    const request = useChangeSignatureDialog.getState().request!;
    expect(await refactorChangeSignature(request, SIGNATURE, false)).toEqual({
      status: "stay",
      error: "'$total' is already used in App\\repeat",
    });
    resolved = ok({ ...ACTION, edit: { files: [] }, data: null });
    expect(await refactorChangeSignature(request, SIGNATURE, false)).toEqual({
      status: "stay",
      error: "Nothing to change",
    });
    expect(applyWorkspaceEdit).not.toHaveBeenCalled();
  });

  it("refuses when the file changed under the dialog", async () => {
    const v = editor();
    startChangeSignature(v, [ACTION]);
    v.dispatch({ changes: { from: 0, insert: "\n" } });
    const request = useChangeSignatureDialog.getState().request!;
    expect(await refactorChangeSignature(request, SIGNATURE, false)).toEqual({
      status: "stay",
      error: "The file changed; open the dialog again",
    });
    expect(lspResolveCodeAction).not.toHaveBeenCalled();
  });

  it("previews the edit before applying it when asked", async () => {
    resolved = ok({ ...ACTION, edit: EDIT, data: null });
    startChangeSignature(editor(), [ACTION]);
    const request = useChangeSignatureDialog.getState().request!;
    expect((await refactorChangeSignature(request, SIGNATURE, true)).status).toBe("done");
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("preview");
    if (popup?.kind !== "preview") return;
    expect(popup.title).toBe("Change Signature of 'App\\repeat'");
    expect(popup.summary.files).toBe(2);
    expect(applyWorkspaceEdit).not.toHaveBeenCalled();
    popup.onConfirm();
    await vi.waitFor(() => expect(applyWorkspaceEdit).toHaveBeenCalledWith(EDIT));
  });
});
