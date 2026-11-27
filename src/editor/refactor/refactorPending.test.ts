import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands } from "@/platform/ipc";

type QueryResult = Awaited<ReturnType<typeof commands.lspCodeActionQuery>>;
const { lspCodeActionQuery, cancelRequest } = vi.hoisted(() => ({
  lspCodeActionQuery: vi.fn<typeof commands.lspCodeActionQuery>(),
  cancelRequest: vi.fn<typeof commands.cancelRequest>(async () => {}),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspCodeActionQuery, cancelRequest } };
});

const { runRefactoring } = await import("./refactorThis");
const { lspDoc } = await import("@/editor/lsp/lsp");

const hint = () => document.querySelector(".cm-lsp-hint")?.textContent ?? null;
const empty: QueryResult = { status: "ok", data: { actions: [], advertisedKinds: null } };
const cancelled: QueryResult = { status: "error", error: { kind: "cancelled", message: "cancelled" } };

let view: EditorView;
beforeEach(() => {
  vi.useFakeTimers();
  view = new EditorView({
    state: EditorState.create({
      doc: "fn main() { run(); }",
      selection: { anchor: 13 },
      extensions: [lspDoc.of({ doc: 1, path: "/p/main.rs", language: "rust", uiMode: "Rust", readOnly: false })],
    }),
    parent: document.body,
  });
});
afterEach(() => {
  view.destroy();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// #6381: a busy server (jdtls searching usages) can take seconds to list the refactorings.
describe("Refactor menu actions while the server is busy", () => {
  it("say they are waiting until the server answers", async () => {
    let answer!: (r: QueryResult) => void;
    lspCodeActionQuery.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const running = runRefactoring(view, "move");
    await vi.advanceTimersByTimeAsync(250);
    expect(hint()).toBe("Looking for refactorings…");
    answer(empty);
    await running;
    expect(hint()).not.toBe("Looking for refactorings…");
  });

  it("keep saying so when pressed again while the first press is waiting", async () => {
    const answers: Array<(r: QueryResult) => void> = [];
    lspCodeActionQuery.mockImplementation(() => new Promise((r) => answers.push(r)));
    const first = runRefactoring(view, "move");
    await vi.advanceTimersByTimeAsync(250);
    expect(hint()).toBe("Looking for refactorings…");
    const second = runRefactoring(view, "move");
    // The superseded query comes back cancelled at once.
    answers[0]!(cancelled);
    await first;
    await vi.advanceTimersByTimeAsync(250);
    expect(hint()).toBe("Looking for refactorings…");
    answers[1]!(empty);
    await second;
    expect(hint()).not.toBe("Looking for refactorings…");
  });
});
