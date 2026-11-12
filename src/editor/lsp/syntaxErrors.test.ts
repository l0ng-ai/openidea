import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

const published: Array<[string, string, unknown[]]> = [];
let servers: Array<{ status: string; languages: string[] }> = [];
const serverListeners: Array<() => void> = [];

vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  call: (p: Promise<unknown>) => p,
  commands: { lspServers: () => Promise.resolve(servers) },
  onIdeEvent: (_type: string, l: () => void) => {
    serverListeners.push(l);
    return () => {};
  },
}));
vi.mock("@/editor/api", () => ({ whenSynced: () => Promise.resolve() }));
vi.mock("@/editor/structure", () => ({
  structure: {
    syntaxErrors: () =>
      Promise.resolve({
        errors: [
          {
            kind: "unexpected",
            range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } },
            expected: null,
            message: "unexpected `iqTask`",
          },
          {
            kind: "missing",
            range: { start: { line: 2, character: 3 }, end: { line: 2, character: 3 } },
            expected: ";",
            message: "missing `;`",
          },
        ],
        truncated: false,
      }),
  },
}));
vi.mock("./diagnostics", () => ({
  setFileDiagnostics: (path: string, source: string, items: unknown[]) => published.push([path, source, items]),
}));

const { lspDoc } = await import("./lsp");
const { syntaxErrorsExtension } = await import("./syntaxErrors");
const { SYNTAX_ERRORS_PRODUCER } = await import("@/platform/inspections");

const ctx = { doc: 1, path: "/p/a.php", language: "php", uiMode: null, readOnly: false };
const views: EditorView[] = [];
function open(doc = ctx) {
  const view = new EditorView({
    state: EditorState.create({
      doc: "<?php\n$a = A::geUn iqTask\nb()\n",
      extensions: [lspDoc.of(doc), syntaxErrorsExtension()],
    }),
  });
  views.push(view);
  return view;
}
const settle = () => vi.advanceTimersByTimeAsync(600);
const last = () => published.filter(([, s]) => s === SYNTAX_ERRORS_PRODUCER).at(-1)?.[2];

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  published.length = 0;
  vi.useRealTimers();
});

describe("syntax errors without a language server", () => {
  it("reports the parser's errors when no server checks the language", async () => {
    vi.useFakeTimers();
    servers = [{ status: "missing", languages: ["php"] }];
    open();
    await settle();
    expect(last()).toEqual([
      expect.objectContaining({ severity: "error", message: "Unexpected token", source: "Syntax" }),
      expect.objectContaining({ severity: "error", message: "';' expected" }),
    ]);
  });

  it("skips Django templates, whose tags the borrowed HTML grammar can't read", async () => {
    vi.useFakeTimers();
    servers = [{ status: "missing", languages: ["django-html"] }];
    open({ ...ctx, path: "/p/templates/a.html", language: "django-html" });
    await settle();
    expect(last()).toBeUndefined();
  });

  it("leaves them to a running server, and checks again when the server stops", async () => {
    vi.useFakeTimers();
    servers = [{ status: "ready", languages: ["php"] }];
    serverListeners.forEach((l) => l());
    open();
    await settle();
    expect(last()).toEqual([]);
    servers = [{ status: "crashed", languages: ["php"] }];
    serverListeners.forEach((l) => l());
    await settle();
    expect(last()).toHaveLength(2);
  });
});
