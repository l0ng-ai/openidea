import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodeAction, CommandForm } from "@/bindings";

const { resolve, execute, cancel, openFile } = vi.hoisted(() => ({
  resolve: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, lspResolveCommand: resolve, lspExecuteCodeAction: execute, cancelRequest: cancel },
  };
});
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openFile }),
}));
import { runInteractiveCodeAction } from "./interactiveCommand";
import { InputDialogsHost } from "@/workbench/inputDialogs";

const action: CodeAction = {
  title: "Add methods to T to implement an interface...",
  kind: "refactor.rewrite.implementInterface",
  server: 1,
  isPreferred: false,
  disabledReason: null,
  edit: null,
  data: null,
  command: { title: "Implement", command: "gopls.implement_interface", arguments: [] },
};
const form = (error: string | null = null): CommandForm => ({
  command: action.command!,
  formAnswers: [],
  formFields: [{ id: "interface", description: "Enter interface name", required: true, default: null, error }],
});
const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const submit = async (value: string) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "OK" })));
};

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockResolvedValue(ok(form()));
  execute.mockResolvedValue(ok([]));
  render(<InputDialogsHost />);
});
afterEach(cleanup);

describe("interactive code actions", () => {
  it("keeps server errors in the prompt, retries, and executes only validated answers", async () => {
    resolve
      .mockResolvedValueOnce(ok(form()))
      .mockResolvedValueOnce(ok(form("Unknown interface")))
      .mockResolvedValueOnce(ok({ ...form(), formFields: [], formAnswers: [{ id: "interface", value: "pkg.I" }] }));
    const result = runInteractiveCodeAction(7, action);
    await screen.findByRole("textbox", { name: "Enter interface name" });
    const dialog = screen.getByRole("dialog");
    await submit("bad");
    expect(screen.getByText("Unknown interface")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(execute).not.toHaveBeenCalled();
    await submit("pkg.I");
    expect(await result).toBe(true);
    expect(resolve.mock.calls[1]!.slice(1)).toEqual([7, 1, action.command, [{ id: "interface", value: "bad" }]]);
    expect(execute.mock.calls[0]!.slice(1)).toEqual([7, action, [{ id: "interface", value: "pkg.I" }]]);
  });

  it("Cancel executes nothing", async () => {
    const result = runInteractiveCodeAction(7, action);
    await screen.findByRole("textbox");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(await result).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels pending validation and ignores its late response", async () => {
    let finish!: (v: ReturnType<typeof ok<CommandForm>>) => void;
    resolve.mockResolvedValueOnce(ok(form())).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const result = runInteractiveCodeAction(7, action);
    await screen.findByRole("textbox");
    await submit("pkg.I");
    expect(screen.getByRole("button", { name: "OK" }).hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(await result).toBe(false);
    expect(cancel).toHaveBeenCalledWith(resolve.mock.calls[1]![0]);
    await act(async () => finish(ok({ ...form(), formFields: [] })));
    expect(execute).not.toHaveBeenCalled();
  });

  it("opens the created test returned by the applied edit", async () => {
    resolve.mockResolvedValue(ok(null));
    execute.mockResolvedValue(ok(["/p/probe_test.go"]));
    expect(await runInteractiveCodeAction(7, { ...action, kind: "source.addTest" })).toBe(true);
    expect(openFile).toHaveBeenCalledWith("/p/probe_test.go");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("executes other servers without a prompt or form answers", async () => {
    resolve.mockResolvedValue(ok(null));
    expect(await runInteractiveCodeAction(7, action)).toBe(true);
    expect(execute.mock.calls[0]!.slice(1)).toEqual([7, action, []]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
