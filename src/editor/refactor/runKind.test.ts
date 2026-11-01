import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction } from "@/bindings";

let answer: () => unknown = () => ({ status: "ok", data: [] });
const lspCodeActions = vi.fn(async () => answer());
// applyCodeAction resolves the picked action, then executes it (interactive command support).
const lspResolveCodeAction = vi.fn(async (_doc: number, action: CodeAction) => ({ status: "ok", data: action }));
const lspExecuteCodeAction = vi.fn(async () => ({ status: "ok", data: [] }));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, lspCodeActions, lspResolveCodeAction, lspExecuteCodeAction },
  };
});
const showHint = vi.fn();
vi.mock("@/editor/lsp/hint", () => ({ showHint }));

const { runKindAction } = await import("@/editor/lsp/intentions");
const { lspDoc } = await import("@/editor/lsp/lsp");

const action = (title: string, disabledReason: string | null = null): CodeAction => ({
  title,
  kind: "refactor.extract.constant",
  isPreferred: false,
  disabledReason,
  edit: null,
  command: null,
  data: null,
  server: 1,
});

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  showHint.mockClear();
  lspResolveCodeAction.mockClear();
  lspExecuteCodeAction.mockClear();
});

function run(fallback: (reason: "notReady" | "error" | "empty") => Promise<boolean>) {
  view = new EditorView({
    state: EditorState.create({
      doc: "const a = 1;",
      extensions: [lspDoc.of({ doc: 1, path: "/a.ts", language: "typescript", uiMode: null, readOnly: false })],
    }),
  });
  return runKindAction(view, "refactor.extract", {
    title: /constant/i,
    none: "Nothing",
    label: "Introduce Constant",
    fallback,
  });
}

describe("runKindAction fallback", () => {
  it("uses the server's action when there is one", async () => {
    answer = () => ({ status: "ok", data: [action("Extract to constant")] });
    const fallback = vi.fn(async () => true);
    await run(fallback);
    expect(fallback).not.toHaveBeenCalled();
    expect(lspExecuteCodeAction).toHaveBeenCalledOnce();
  });

  it("falls back when the server is not ready or fails", async () => {
    answer = () => ({ status: "error", error: { kind: "unavailable", message: "no server" } });
    const fallback = vi.fn(async () => true);
    await run(fallback);
    expect(fallback).toHaveBeenCalledWith("notReady");
    answer = () => ({ status: "error", error: { kind: "protocol", message: "boom" } });
    await run(fallback);
    expect(fallback).toHaveBeenLastCalledWith("error");
    expect(showHint).not.toHaveBeenCalled();
  });

  it("asks the fallback on an empty answer and keeps the server's reason when it declines", async () => {
    answer = () => ({ status: "ok", data: [action("Extract to constant", "Cannot extract empty range")] });
    const fallback = vi.fn(async () => false);
    await run(fallback);
    expect(fallback).toHaveBeenCalledWith("empty");
    expect(showHint).toHaveBeenCalledWith(expect.anything(), "Cannot extract empty range");
  });
});
