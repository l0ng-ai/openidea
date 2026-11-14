import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Diagnostic } from "@/bindings";

const suppress = {
  title: "Suppress 'PhpUnknownArtisanOption' for statement",
  kind: "quickfix",
  isPreferred: false,
  disabledReason: null,
  edit: null,
  command: null,
  data: null,
  server: "php",
};
const lspCodeActions = vi.fn(async () => ({ status: "ok", data: [suppress] }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspCodeActions } };
});
const { setFileDiagnostics, diagnosticsFor, toLintDiagnostics, isLocalDiagnostic } = await import("./diagnostics");
const { quickFixesAt } = await import("./intentions");
const { lspDoc } = await import("./lsp");

const text = "<?php\n$this->call('x', ['--dryrun' => 1]);\n";
const typo: Diagnostic = {
  range: { start: { line: 1, col: 20 }, end: { line: 1, col: 26 } },
  severity: "info",
  message: "Typo: In word 'dryrun'",
  source: "Spelling",
  code: null,
};

afterEach(() => {
  setFileDiagnostics("/p/a.php", "spelling", []);
  vi.clearAllMocks();
});

describe("problems the UI finds", () => {
  it("are told apart from a language server's", () => {
    setFileDiagnostics("/p/a.php", "spelling", [typo]);
    const doc = Text.of(text.split("\n"));
    const [local] = toLintDiagnostics(doc, diagnosticsFor("/p/a.php"));
    expect(isLocalDiagnostic(local!)).toBe(true);
    const [server] = toLintDiagnostics(doc, [
      { ...typo, source: "php", code: "PhpUnknownArtisanOption", server: "php" },
    ]);
    expect(isLocalDiagnostic(server!)).toBe(false);
  });

  it("don't offer the server's fixes for the same range", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [lspDoc.of({ doc: 3, path: "/p/a.php", language: "php", uiMode: "PHP", readOnly: false })],
      }),
    });
    const from = text.indexOf("--dryrun") + 2;
    expect(await quickFixesAt(view, from, from + 6, undefined, { localOnly: true })).toEqual([]);
    expect(lspCodeActions).not.toHaveBeenCalled();
    expect((await quickFixesAt(view, from, from + 6)).map((fix) => fix.title)).toEqual([suppress.title]);
    view.destroy();
  });
});
