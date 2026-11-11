import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

const { MemberChooserDialog } = await import("./MemberChooserDialog");
const { chooserTitle, initialChoice, memberChooserData, startMemberChooser, toggled, useMemberChooser } =
  await import("./memberChooser");
const { lspDoc } = await import("@/editor/lsp/lsp");

const member = (id: string, detail: string, selected = true) => ({ id, label: `$${id}`, detail, selected });

const DATA = {
  range: { start: { line: 4, col: 0 }, end: { line: 4, col: 0 } },
  generator: "accessors",
  title: "Generate getters and setters…",
  members: [member("id", "int"), member("name", "string"), member("tags", "array", false)],
  chosen: null,
};

function action(data: object = DATA): CodeAction {
  return {
    title: "Generate getters and setters…",
    kind: "source.generate.chooser",
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
      doc: "<?php\nclass Item\n{\n    private int $id;\n}\n",
      extensions: [lspDoc.of({ doc: 5, path: "/p/a.php", language: "php", uiMode: null, readOnly: false })],
    }),
  });
  expect(startMemberChooser(view, action(data))).toBe(true);
  return render(<MemberChooserDialog />);
}

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(() => {
  view?.destroy();
  view = null;
  useMemberChooser.setState({ request: null });
  resolved = { status: "ok", data: null };
  vi.clearAllMocks();
});

describe("member chooser data", () => {
  it("reads the action's members and keeps the members' order", () => {
    const data = memberChooserData(action())!;
    expect(chooserTitle(data)).toBe("Generate getters and setters");
    expect(initialChoice(data)).toEqual(["id", "name"]);
    expect(toggled(data, ["name"], "id", true)).toEqual(["id", "name"]);
    expect(toggled(data, ["id", "name"], "id", false)).toEqual(["name"]);
    // Other actions, and actions with an edit, are not choosers.
    expect(memberChooserData({ ...action(), kind: "source.generate.accessors" })).toBeNull();
    expect(memberChooserData({ ...action(), edit: { files: [] } as never })).toBeNull();
    expect(memberChooserData({ ...action(), data: "{" })).toBeNull();
  });
});

describe("MemberChooserDialog", () => {
  it("lists the members with their types, chosen as the server says", () => {
    open();
    expect(screen.getByText("Generate getters and setters")).toBeTruthy();
    expect(box("$id").checked).toBe(true);
    expect(box("$tags").checked).toBe(false);
    expect(screen.getByText("array")).toBeTruthy();
    fireEvent.click(button("Select None"));
    expect(box("$name").checked).toBe(false);
    expect(button("OK").disabled).toBe(true);
    fireEvent.click(button("Select All"));
    expect(box("$tags").checked).toBe(true);
  });

  it("sends the chosen members, applies the edit and closes", async () => {
    const edit = { files: [] };
    resolved = { status: "ok", data: { ...action(), edit } };
    open();
    fireEvent.click(box("$id"));
    fireEvent.click(button("OK"));
    await vi.waitFor(() => expect(applyWorkspaceEdit).toHaveBeenCalledOnce());
    const data = JSON.parse(lspResolveCodeAction.mock.calls[0]![1].data!);
    expect(data.chosen).toEqual(["name"]);
    expect(useMemberChooser.getState().request).toBeNull();
  });

  it("stays open with the server's reason", async () => {
    resolved = { status: "error", error: { kind: "invalidInput", message: "Nothing to generate" } };
    open();
    fireEvent.click(button("OK"));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nothing to generate"));
    expect(useMemberChooser.getState().request).not.toBeNull();
    expect(applyWorkspaceEdit).not.toHaveBeenCalled();
  });

  it("allows a constructor of no member", () => {
    open({ ...DATA, generator: "constructor", members: [] });
    expect(screen.getByText("No members")).toBeTruthy();
    expect(button("OK").disabled).toBe(false);
  });

  it("needs a method chosen to override", () => {
    open({ ...DATA, generator: "overrides", title: "Override methods…", members: [member("Base::a()", "", false)] });
    expect(screen.getByText("Override methods")).toBeTruthy();
    expect(button("OK").disabled).toBe(true);
    fireEvent.click(box("$Base::a()"));
    expect(button("OK").disabled).toBe(false);
  });
});
