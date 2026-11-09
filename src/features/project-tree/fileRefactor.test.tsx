import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FileMove, WorkspaceEdit } from "@/bindings";
import { provideNotificationService } from "@/workbench/contributions";
import {
  lastFileRefactoring,
  mergeEdits,
  movedPath,
  runFileRefactoring,
  setRefactorBackendForTests,
  touchesOtherFiles,
  undoFileRefactoring,
  type FileRefactorBackend,
} from "./fileRefactor";
import { RefactoringPreviewHost } from "./RefactoringPreview";

const r = (line: number, a: number, b: number) => ({ start: { line, col: a }, end: { line, col: b } });
const edit = (path: string, ...ranges: [number, number, number, string][]): WorkspaceEdit["files"][number] => ({
  kind: "edit",
  path,
  edits: ranges.map(([l, a, b, t]) => ({ range: r(l, a, b), new_text: t })),
});

describe("file refactoring edits", () => {
  it("retains version guards and both sources' preview fingerprints", () => {
    const lsp: WorkspaceEdit = {
      files: [{ kind: "edit", path: "/p/main.ts", edits: [{ range: r(0, 0, 3), new_text: "new" }], version: 7 }],
      preconditions: [{ path: "/p/main.ts", hash: "source" }],
    };
    const text: WorkspaceEdit = { files: [], preconditions: [{ path: "/p/README.md", hash: "text" }] };
    const merged = mergeEdits(lsp, text);
    expect(merged.files[0]).toMatchObject({ version: 7 });
    expect(merged.preconditions).toEqual([...lsp.preconditions!, ...text.preconditions!]);
  });
  it("merges text occurrences that no server edit covers and drops file operations", () => {
    const lsp: WorkspaceEdit = {
      files: [edit("/p/main.ts", [0, 20, 26, "./b/util"]), { kind: "rename", from: "/p/a", to: "/p/b" }],
    };
    const text: WorkspaceEdit = {
      files: [
        edit("/p/main.ts", [0, 22, 26, "b/util"], [3, 3, 10, "b/util.ts"]),
        edit("/p/README.md", [1, 0, 9, "b/util.ts"]),
      ],
    };
    const merged = mergeEdits(lsp, text);
    expect(merged.files.map((f) => f.kind === "edit" && [f.path, f.edits.length])).toEqual([
      ["/p/main.ts", 2],
      ["/p/README.md", 1],
    ]);
  });

  it("knows when other files change and where paths move", () => {
    const moves: FileMove[] = [{ from: "/p/a", to: "/p/b/a" }];
    expect(touchesOtherFiles({ files: [edit("/p/a/x.ts", [0, 0, 1, "y"])] }, moves)).toBe(false);
    expect(touchesOtherFiles({ files: [edit("/p/main.ts", [0, 0, 1, "y"])] }, moves)).toBe(true);
    expect(movedPath("/p/a/x.ts", moves)).toBe("/p/b/a/x.ts");
    expect(movedPath("/p/ab.ts", moves)).toBe("/p/ab.ts");
  });
});

describe("runFileRefactoring", () => {
  let backend: FileRefactorBackend & { calls: string[] };
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockReset();
    provideNotificationService({ notify });
    backend = {
      calls: [],
      edits: vi.fn(async () => ({
        edit: {
          files: [edit("/p/main.ts", [0, 20, 26, "./b/util"])],
          preconditions: [{ path: "/p/main.ts", hash: "preview" }],
        },
        errors: ["tsserver: busy"],
      })),
      move: vi.fn(async (moves: FileMove[], e: WorkspaceEdit) => {
        backend.calls.push(`move ${moves.length} ${e.files.length}`);
        return 7;
      }),
      undo: vi.fn(async () => ({ moves: [{ from: "/p/b/util.ts", to: "/p/a/util.ts" }], conflicts: [] })),
    } as FileRefactorBackend & { calls: string[] };
    setRefactorBackendForTests(backend);
  });

  afterEach(() => setRefactorBackendForTests(null));

  const moves: FileMove[] = [{ from: "/p/a/util.ts", to: "/p/b/util.ts" }];

  it("previews edits in other files, applies the move and offers Undo", async () => {
    render(<RefactoringPreviewHost />);
    let status: Promise<string> = Promise.resolve("");
    act(() => {
      status = runFileRefactoring(moves, { references: true, textOccurrences: false }, "Move");
    });
    const dialog = await screen.findByRole("dialog", { name: /Refactoring Preview: Move 'util.ts' to 'b'/ });
    expect(dialog).toHaveTextContent("1 occurrence in 1 file");
    expect(within(dialog).getByText("main.ts")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Do Refactor" }));
    expect(await status).toBe("done");
    expect(backend.calls).toEqual(["move 1 1"]);
    expect(backend.move).toHaveBeenCalledWith(
      moves,
      expect.objectContaining({ preconditions: [{ path: "/p/main.ts", hash: "preview" }] }),
      "Move",
    );
    expect(lastFileRefactoring()?.id).toBe(7);
    // Server failures are reported; the result offers Undo.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "warning", body: "tsserver: busy" }));
    const done = notify.mock.calls.map((c) => c[0]).find((n) => n.actions);
    expect(done.title).toBe("Move 'util.ts' to 'b'");
    expect(await undoFileRefactoring()).toBe(true);
    expect(backend.undo).toHaveBeenCalledWith(7);
    expect(lastFileRefactoring()).toBeNull();
  });

  it("excluded files are left out and Cancel keeps everything", async () => {
    render(<RefactoringPreviewHost />);
    let status: Promise<string> = Promise.resolve("");
    act(() => {
      status = runFileRefactoring(moves, { references: true, textOccurrences: true }, "Move");
    });
    let dialog = await screen.findByRole("dialog", { name: /Refactoring Preview/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await status).toBe("cancelled");
    expect(backend.move).not.toHaveBeenCalled();

    act(() => {
      status = runFileRefactoring(moves, { references: true, textOccurrences: false }, "Move");
    });
    dialog = await screen.findByRole("dialog", { name: /Refactoring Preview/ });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Include main.ts" }));
    await waitFor(() => expect(dialog).toHaveTextContent("0 occurrences in 0 files"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Do Refactor" }));
    expect(await status).toBe("done");
    expect(backend.calls).toEqual(["move 1 0"]);
  });

  it("skips the search without options and stops when cancelled", async () => {
    expect(await runFileRefactoring(moves, { references: false, textOccurrences: false }, "Rename")).toBe("done");
    expect(backend.edits).not.toHaveBeenCalled();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(
      await runFileRefactoring(moves, { references: true, textOccurrences: false }, "Move", { signal: ctrl.signal }),
    ).toBe("cancelled");
  });
});
