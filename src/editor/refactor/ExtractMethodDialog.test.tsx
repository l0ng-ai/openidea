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

const { ExtractMethodDialog } = await import("./ExtractMethodDialog");
const {
  choiceProblem,
  cleanChoice,
  declarationText,
  extractMethodData,
  moveParameter,
  startExtractMethod,
  useExtractMethodDialog,
} = await import("./extractMethod");
const { lspDoc } = await import("@/editor/lsp/lsp");

const param = (name: string, type: string) => ({ oldName: name, name, type, included: true });

const DATA = {
  range: { start: { line: 5, col: 8 }, end: { line: 5, col: 30 } },
  function: false,
  className: "Shop",
  defaults: {
    name: "extracted",
    parameters: [param("a", "int"), param("b", "int")],
    returnType: "int",
    visibility: "private" as const,
    static: false,
    replaceDuplicates: true,
  },
  staticRequired: false,
  usesThis: false,
  duplicates: 2,
  change: null,
};

function action(data: object = DATA): CodeAction {
  return {
    title: "Extract method…",
    kind: "refactor.extract.method.dialog",
    isPreferred: false,
    disabledReason: null,
    edit: null,
    command: null,
    data: JSON.stringify(data),
    server: 3,
  };
}

let view: EditorView | null = null;
function open(data: object = DATA) {
  view = new EditorView({
    state: EditorState.create({
      doc: "<?php\nclass Shop {}\n",
      extensions: [lspDoc.of({ doc: 5, path: "/p/a.php", language: "php", uiMode: null, readOnly: false })],
    }),
  });
  expect(startExtractMethod(view, [action(data)])).toBe(true);
  return render(<ExtractMethodDialog />);
}

const preview = () => document.querySelector("code")!.textContent;
const rows = () => screen.getAllByRole("row").slice(1);
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(() => {
  view?.destroy();
  view = null;
  useExtractMethodDialog.setState({ request: null });
  resolved = { status: "ok", data: null };
  vi.clearAllMocks();
});

describe("extractMethod", () => {
  it("reads only the dialog's action", () => {
    expect(extractMethodData(action())?.className).toBe("Shop");
    expect(extractMethodData({ ...action(), edit: { files: [], preconditions: [] } })).toBeNull();
    expect(extractMethodData({ ...action(), kind: "refactor.extract.method" })).toBeNull();
    expect(extractMethodData({ ...action(), data: "not json" })).toBeNull();
    expect(extractMethodData({ ...action(), data: null })).toBeNull();
  });

  it("checks names, moves parameters and writes the declaration", () => {
    const choice = { ...DATA.defaults };
    expect(choiceProblem(choice)).toBeNull();
    expect(choiceProblem({ ...choice, name: " " })).toBe("Enter a name");
    expect(choiceProblem({ ...choice, name: "1x" })).toBe("'1x' is not a valid name");
    expect(choiceProblem({ ...choice, parameters: [param("a", ""), { ...param("b", ""), name: "$a" }] })).toBe(
      "There are two parameters named '$a'",
    );
    // An excluded parameter isn't checked.
    expect(
      choiceProblem({ ...choice, parameters: [param("a", ""), { ...param("b", ""), name: "a", included: false }] }),
    ).toBeNull();
    expect(moveParameter(choice.parameters, 1, -1).map((p) => p.oldName)).toEqual(["b", "a"]);
    expect(moveParameter(choice.parameters, 0, -1).map((p) => p.oldName)).toEqual(["a", "b"]);
    expect(declarationText(DATA, { ...choice, static: true, visibility: "public" })).toBe(
      "public static function extracted(int $a, int $b): int",
    );
    expect(declarationText({ ...DATA, function: true }, { ...choice, returnType: "" })).toBe(
      "function extracted(int $a, int $b)",
    );
    expect(cleanChoice({ ...choice, name: " go ", parameters: [{ ...param("a", " int "), name: "$x" }] })).toEqual({
      ...choice,
      name: "go",
      parameters: [{ oldName: "a", name: "x", type: "int", included: true }],
    });
  });
});

describe("ExtractMethodDialog", () => {
  it("shows the defaults and the declaration", () => {
    open();
    expect(screen.getByText("Extract Method")).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(preview()).toBe("private function extracted(int $a, int $b): int");
    expect(button("Refactor").disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Method name"), { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toBe("Enter a name");
    expect(button("Refactor").disabled).toBe(true);
  });

  it("renames, reorders and excludes parameters", () => {
    open();
    fireEvent.change(within(rows()[1]!).getByLabelText("Name"), { target: { value: "second" } });
    fireEvent.mouseDown(rows()[1]!);
    fireEvent.click(button("Move Up"));
    expect(preview()).toBe("private function extracted(int $second, int $a): int");
    fireEvent.click(within(rows()[1]!).getByLabelText("Pass this parameter"));
    expect(preview()).toBe("private function extracted(int $second): int");
    expect(screen.getByText("Parameters that are not passed are undefined in the new code.")).toBeTruthy();
  });

  it("sends the choice and closes when the change is made", async () => {
    resolved = { status: "ok", data: { ...action(), edit: { files: [] } } };
    open();
    fireEvent.change(screen.getByLabelText("Method name"), { target: { value: "combine" } });
    fireEvent.change(screen.getByLabelText("Return type"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Static"));
    fireEvent.click(screen.getByLabelText("Also replace 2 duplicates of the code"));
    fireEvent.click(button("Refactor"));
    await vi.waitFor(() => expect(lspResolveCodeAction).toHaveBeenCalledOnce());
    const data = JSON.parse(lspResolveCodeAction.mock.calls[0]![1].data!);
    expect(data.change).toEqual({
      ...DATA.defaults,
      name: "combine",
      returnType: "",
      static: true,
      replaceDuplicates: false,
    });
    // No edit: the dialog stays with the reason.
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nothing to change"));

    resolved = {
      status: "error",
      error: { kind: "invalidInput", message: "The class already has a method named 'combine'" },
    };
    fireEvent.click(button("Refactor"));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("The class already has a method named 'combine'"),
    );
    expect(useExtractMethodDialog.getState().request).not.toBeNull();

    resolved = {
      status: "ok",
      data: {
        ...action(),
        edit: {
          files: [
            {
              kind: "edit",
              path: "/p/a.php",
              edits: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, newText: "" }],
              version: null,
            },
          ],
        },
      },
    };
    fireEvent.click(button("Refactor"));
    await vi.waitFor(() => expect(useExtractMethodDialog.getState().request).toBeNull());
    expect(applyWorkspaceEdit).toHaveBeenCalledOnce();
  });

  it("hides the method options for a function and locks static when it is required", () => {
    const { unmount } = open({ ...DATA, function: true, className: "", duplicates: 0 });
    expect(screen.getByText("Extract Function")).toBeTruthy();
    expect(screen.queryByLabelText("Static")).toBeNull();
    expect(screen.queryByLabelText("Visibility")).toBeNull();
    expect(preview()).toBe("function extracted(int $a, int $b): int");
    unmount();
    useExtractMethodDialog.setState({ request: null });
    open({ ...DATA, staticRequired: true, defaults: { ...DATA.defaults, static: true } });
    expect((screen.getByLabelText("Static") as HTMLInputElement).disabled).toBe(true);
    expect(preview()).toBe("private static function extracted(int $a, int $b): int");
  });
});
