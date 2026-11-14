import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeLens as ServerLens, Command } from "@/bindings";

const ipc = vi.hoisted(() => ({
  lspExecuteCommand: vi.fn(async () => ({ status: "ok" as const, data: null })),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const { editorLenses } = await import("./serverLens");
const { registerClientCommand, runCommand } = await import("./clientCommands");
const { lspDoc } = await import("./lsp");

const view = (text: string) =>
  new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [lspDoc.of({ doc: 7, path: "/p/app/Http/Controllers/PostController.php", language: "php" } as never)],
    }),
  });

const command = (name: string, title = "GET /posts · posts.index"): Command => ({
  title,
  command: name,
  arguments: ['[{"uri":"/posts"}]'],
});

describe("language service code lenses", () => {
  it("become editor lenses at their range, without the ones lacking a command", () => {
    const v = view("<?php\nclass PostController {\n    public function index() {}\n}\n");
    const lenses: ServerLens[] = [
      { range: { start: { line: 2, col: 20 }, end: { line: 2, col: 25 } }, command: command("laravel.routeActions") },
      { range: { start: { line: 1, col: 6 }, end: { line: 1, col: 20 } }, command: null },
    ];
    const out = editorLenses(v, lenses);
    expect(out.map((l) => [l.pos, l.title])).toEqual([[v.state.doc.line(3).from + 20, "GET /posts · posts.index"]]);
    expect(out[0]?.run).toBeTypeOf("function");
    v.destroy();
  });

  it("run their command in the client when a handler knows it, else in the language server", async () => {
    const v = view("<?php\n");
    const seen: unknown[][] = [];
    const off = registerClientCommand("laravel.routeActions", (args) => void seen.push([...args]));
    await runCommand(v, command("laravel.routeActions"));
    expect(seen).toEqual([['[{"uri":"/posts"}]']]);
    expect(ipc.lspExecuteCommand).not.toHaveBeenCalled();

    off();
    await runCommand(v, command("laravel.routeActions"));
    expect(seen).toHaveLength(1);
    expect(ipc.lspExecuteCommand).toHaveBeenCalledWith(7, command("laravel.routeActions"));
    v.destroy();
  });
});
