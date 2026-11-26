import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction } from "@/platform/ipc";

const lspCodeActions = vi.fn();
const lspApplyCodeAction = vi.fn(async () => ({ status: "ok" as const, data: null }));
vi.mock("./interactiveCommand", () => ({ runInteractiveCodeAction: vi.fn(async () => false) }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspCodeActions, lspApplyCodeAction } };
});

const { lspDoc } = await import("./lsp");
const { removeUnusedImports } = await import("./actions");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
});

const editor = (language: string) => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'import { a, b } from "./m";\na();\n',
      extensions: [lspDoc.of({ doc: 1, path: "/p/x", language, uiMode: null, readOnly: false })],
    }),
  });
  views.push(view);
  return view;
};

const action = (kind: string): CodeAction =>
  ({
    title: "Remove Unused Imports",
    kind,
    isPreferred: false,
    disabledReason: null,
    edit: null,
    command: null,
    data: null,
    server: 1,
  }) as unknown as CodeAction;

describe("Optimize Imports in JavaScript / TypeScript", () => {
  it("removes unused imports with the server's own action", async () => {
    lspCodeActions.mockResolvedValue({ status: "ok", data: [action("source.removeUnusedImports.ts")] });
    expect(await removeUnusedImports(editor("typescript"))).toBe(true);
    expect(lspCodeActions.mock.calls[0]![2]).toEqual(["source.removeUnusedImports"]);
    expect(lspApplyCodeAction).toHaveBeenCalledTimes(1);
  });

  it("leaves other languages to organize imports", async () => {
    expect(await removeUnusedImports(editor("java"))).toBe(false);
    expect(lspCodeActions).not.toHaveBeenCalled();
  });
});
