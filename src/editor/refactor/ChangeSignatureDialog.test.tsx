import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction } from "@/bindings";

type Result = { status: "ok"; data: unknown } | { status: "error"; error: { kind: string; message: string } };
let resolved: Result = { status: "ok", data: null };
const lspResolveCodeAction = vi.fn(async (_doc: number, _action: CodeAction) => resolved);
const applyWorkspaceEdit = vi.fn(async () => ({ status: "ok", data: null }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, lspResolveCodeAction, applyWorkspaceEdit, cancelRequest: vi.fn(async () => {}) },
  };
});

const { ChangeSignatureDialog } = await import("./ChangeSignatureDialog");
const { startChangeSignature, useChangeSignatureDialog } = await import("./changeSignature");
const { lspDoc } = await import("@/editor/lsp/lsp");

const param = (oldIndex: number, name: string, type: string, extra = {}) => ({
  oldIndex,
  name,
  type,
  defaultValue: "",
  callValue: "",
  byRef: false,
  variadic: false,
  promoted: false,
  ...extra,
});

function action(signature: object): CodeAction {
  return {
    title: "Change signature",
    kind: "refactor.rewrite.changeSignature",
    isPreferred: false,
    disabledReason: null,
    edit: null,
    command: null,
    data: JSON.stringify({ position: { line: 1, col: 9 }, signature, change: null }),
    server: 3,
  };
}

const SIGNATURE = {
  name: "total",
  returnType: "float",
  constructor: false,
  parameters: [param(0, "qty", "int"), param(1, "price", "float")],
};

let view: EditorView | null = null;
function open(signature: object = SIGNATURE) {
  view = new EditorView({
    state: EditorState.create({
      doc: "<?php\nfunction total(int $qty, float $price): float {}\n",
      extensions: [lspDoc.of({ doc: 5, path: "/p/a.php", language: "php", uiMode: null, readOnly: false })],
    }),
  });
  startChangeSignature(view, [action(signature)]);
  return render(<ChangeSignatureDialog />);
}

const preview = () => document.querySelector("code")!.textContent;
const rows = () => screen.getAllByRole("row").slice(1);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(() => {
  view?.destroy();
  view = null;
  useChangeSignatureDialog.setState({ request: null });
  resolved = { status: "ok", data: null };
  vi.clearAllMocks();
});

describe("ChangeSignatureDialog", () => {
  it("shows the parameters, and Refactor only once something changed", () => {
    open();
    expect(screen.getByText("Change Signature")).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(preview()).toBe("total(int $qty, float $price): float");
    expect(button("Refactor").disabled).toBe(true);
    fireEvent.change(within(rows()[0]!).getByLabelText("Name"), { target: { value: "count" } });
    expect(preview()).toBe("total(int $count, float $price): float");
    expect(button("Refactor").disabled).toBe(false);
  });

  it("adds, moves and removes parameters", () => {
    open();
    fireEvent.click(button("Add Parameter"));
    expect(rows()).toHaveLength(3);
    expect(screen.getByRole("alert").textContent).toBe("Every parameter needs a name");
    const added = rows()[2]!;
    fireEvent.change(within(added).getByLabelText("Name"), { target: { value: "discount" } });
    fireEvent.change(within(added).getByLabelText("Type"), { target: { value: "float" } });
    expect(screen.getByRole("alert").textContent).toContain("needs a default value");
    fireEvent.change(within(added).getByLabelText("Value at call sites"), { target: { value: "0.0" } });
    expect(screen.queryByRole("alert")).toBeNull();
    // Existing parameters keep their arguments: no value at call sites.
    expect((within(rows()[0]!).getByLabelText("Value at call sites") as HTMLInputElement).disabled).toBe(true);

    fireEvent.mouseDown(rows()[2]!);
    fireEvent.click(button("Move Up"));
    expect(preview()).toBe("total(int $qty, float $discount, float $price): float");
    fireEvent.mouseDown(rows()[0]!);
    fireEvent.click(button("Remove Parameter"));
    expect(preview()).toBe("total(float $discount, float $price): float");
  });

  it("sends the new signature and closes when the change is made", async () => {
    resolved = { status: "ok", data: { ...action(SIGNATURE), edit: { files: [] } } };
    open();
    fireEvent.change(screen.getByLabelText("Return type"), { target: { value: "int" } });
    fireEvent.mouseDown(rows()[1]!);
    fireEvent.click(button("Move Up"));
    fireEvent.click(button("Refactor"));
    await vi.waitFor(() => expect(lspResolveCodeAction).toHaveBeenCalledOnce());
    const data = JSON.parse(lspResolveCodeAction.mock.calls[0]![1].data!);
    expect(data.change.returnType).toBe("int");
    expect(data.change.parameters.map((p: { oldIndex: number }) => p.oldIndex)).toEqual([1, 0]);
    // No edit: the dialog stays with the reason.
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nothing to change"));

    resolved = { status: "error", error: { kind: "invalidInput", message: "'$x' is already used in total" } };
    fireEvent.click(button("Refactor"));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("'$x' is already used in total"));
    expect(useChangeSignatureDialog.getState().request).not.toBeNull();
  });

  it("keeps promoted properties and hides the return type of a constructor", () => {
    open({
      name: "Point::__construct",
      returnType: "",
      constructor: true,
      parameters: [param(0, "x", "int", { promoted: true }), param(1, "y", "int")],
    });
    expect(screen.queryByLabelText("Return type")).toBeNull();
    expect((within(rows()[0]!).getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    fireEvent.mouseDown(rows()[0]!);
    expect(button("Remove Parameter").disabled).toBe(true);
    fireEvent.mouseDown(rows()[1]!);
    expect(button("Remove Parameter").disabled).toBe(false);
  });
});
