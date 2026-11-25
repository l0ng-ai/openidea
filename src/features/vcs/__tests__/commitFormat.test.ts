import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitOptions, DocumentInfo, FileStatus, LineHunk, Settings, TextEdit } from "@/bindings";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { runCommitModifications } from "../commitChecks";

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
}));

const path = "/p/source.ts";
const file: FileStatus = { path, relPath: "source.ts", staged: null, unstaged: "modified", renamedFrom: null };
const initial = "const a=1;\nconst b=2;\nconst c=3;\n";
const firstEdit = "const a = 1;";
const lastEdit = "const c = 3;";
const edit = (line: number, new_text: string): TextEdit => ({
  range: { start: { line, col: 0 }, end: { line, col: 10 } },
  new_text,
});
const hunk = (line: number, oldText: string): LineHunk => ({
  start: line,
  lines: 1,
  oldStart: line,
  oldLines: 1,
  oldText,
  kind: "modified",
});

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const selection = async (options: Partial<CommitOptions> = {}) => ({
  revision: 1,
  message: "Update source",
  amend: false,
  repositories: [{ root: "/p", options: { amend: false, author: null, signOff: false, runHooks: true, ...options } }],
});

beforeEach(() => {
  useProject.setState({ settings: { vcs: { commit: { reformat: true } } } as Settings });
});

afterEach(() => {
  vi.restoreAllMocks();
  useProject.setState({ settings: null });
});

function mockFormat(hunks: LineHunk[]) {
  const doc = { id: 1, text: initial, version: 3 } as DocumentInfo;
  vi.spyOn(commands, "docOpen").mockResolvedValue(ok(doc));
  vi.spyOn(commands, "docSnapshot").mockResolvedValue(ok(doc));
  vi.spyOn(commands, "docSave").mockResolvedValue(ok(null));
  vi.spyOn(commands, "docClose").mockResolvedValue(ok(null));
  vi.spyOn(commands, "vcsFileAt").mockImplementation(async (_path, rev) =>
    ok(rev === ":0" ? initial : "const a=0;\nconst b=2;\nconst c=0;\n"),
  );
  vi.spyOn(commands, "vcsFileMode").mockResolvedValue(ok("100644"));
  vi.spyOn(commands, "vcsDiffHunks").mockResolvedValue(hunks);
  vi.spyOn(commands, "lspFormat").mockResolvedValue(ok([edit(0, firstEdit), edit(2, lastEdit)]));
  return vi.spyOn(commands, "applyWorkspaceEdit").mockResolvedValue(ok(null));
}

describe("before-commit formatting", () => {
  it("organizes imports and cleans up the staged snapshot without applying working-tree edits", async () => {
    useProject.setState({ settings: { vcs: { commit: { optimizeImports: true, cleanup: true } } } as Settings });
    const before = "import unused;\nconst a=1;\n";
    vi.spyOn(commands, "vcsStagedText").mockResolvedValue(ok({ text: before, version: "stage-zero" }));
    const source = vi.spyOn(commands, "lspSourceActionText").mockImplementation(async (_path, _text, kind) => {
      if (kind === "source.organizeImports")
        return ok([{ range: { start: { line: 0, col: 0 }, end: { line: 1, col: 0 } }, new_text: "" }]);
      return ok([edit(0, "const a = 1;")]);
    });
    const staged = vi.spyOn(commands, "vcsSaveStagedText").mockResolvedValue(ok("new-version"));
    const working = vi.spyOn(commands, "applyWorkspaceEdit");

    await runCommitModifications([{ ...file, staged: "modified" }], () => selection());

    expect(source).toHaveBeenNthCalledWith(1, path, before, "source.organizeImports", expect.anything());
    expect(source).toHaveBeenNthCalledWith(2, path, "const a=1;\n", "source.fixAll", expect.anything());
    expect(staged).toHaveBeenCalledExactlyOnceWith(path, "stage-zero", "const a = 1;\n");
    expect(working).not.toHaveBeenCalled();
  });

  it("applies only edits on changed lines and checks the document version", async () => {
    const applied = mockFormat([hunk(2, "const c=0;\n")]);
    await runCommitModifications([file], () => selection({ stage: [path] }));
    expect(applied).toHaveBeenCalledWith({ files: [{ kind: "edit", path, edits: [edit(2, lastEdit)], version: 3 }] });
  });

  it("leaves excluded hunks in a partially selected file alone", async () => {
    const excluded = hunk(0, "const a=0;\n");
    const selected = hunk(2, "const c=0;\n");
    const applied = mockFormat([excluded, selected]);
    await runCommitModifications([file], () => selection({ partial: [{ path, hunks: [selected] }] }));
    expect(applied).toHaveBeenCalledWith({ files: [{ kind: "edit", path, edits: [edit(2, lastEdit)], version: 3 }] });
  });

  it.each([
    { cleanupLine: 4, accepted: true },
    { cleanupLine: 3, accepted: false },
  ])(
    "maps source edits back to the working file only when they avoid excluded text ($accepted)",
    async ({ cleanupLine, accepted }) => {
      useProject.setState({ settings: { vcs: { commit: { optimizeImports: true, cleanup: true } } } as Settings });
      const imports = "import z;\nimport a;\n";
      const head = imports + "\nconst a=0;\nconst b=0;\n";
      const working = imports + "\nconst a=1;\nconst b=2;\n";
      const before = imports + "\nconst b=0;\nconst a=1;\n";
      const range = { start: 3, lines: 2, oldStart: 3, oldLines: 2 };
      const lines = {
        range,
        oldText: "const a=0;\nconst b=0;\n",
        newText: "const a=1;\nconst b=2;\n",
        deletions: [0],
        additions: [0],
      };
      vi.spyOn(commands, "vcsFileAt").mockResolvedValue(ok(head));
      vi.spyOn(commands, "fsReadText").mockResolvedValue(ok(working));
      vi.spyOn(commands, "vcsPreviewPartialCommit").mockResolvedValue(ok(before));
      vi.spyOn(commands, "vcsDiffHunks").mockImplementation(async (old) =>
        old === head
          ? [{ ...range, oldText: lines.oldText, kind: "modified" }]
          : [
              { start: 0, lines: 2, oldStart: 0, oldLines: 2, oldText: "import a;\nimport z;\n", kind: "modified" },
              hunk(3, firstEdit + "\n"),
            ],
      );
      const source = vi.spyOn(commands, "lspSourceActionText").mockImplementation(async (_path, _text, kind) =>
        ok(
          kind === "source.organizeImports"
            ? [
                {
                  range: { start: { line: 0, col: 0 }, end: { line: 2, col: 0 } },
                  new_text: "import a;\nimport z;\n",
                },
              ]
            : [edit(cleanupLine, firstEdit)],
        ),
      );
      const applied = vi.spyOn(commands, "applyWorkspaceEdit");
      const result = await runCommitModifications([file], () =>
        selection({ partial: [{ path, hunks: [], lineHunks: [lines] }] }),
      );
      expect(source).toHaveBeenNthCalledWith(1, path, before, "source.organizeImports", expect.anything());
      expect(source).toHaveBeenNthCalledWith(
        2,
        path,
        "import a;\nimport z;\n\nconst b=0;\nconst a=1;\n",
        "source.fixAll",
        expect.anything(),
      );
      expect(result).toMatchObject([
        {
          path,
          prepared: {
            before,
            text: "import a;\nimport z;\n\nconst b=0;\n" + (accepted ? firstEdit + "\n" : "const a=1;\n"),
          },
          workingBefore: working,
          workingEdits: [
            expect.objectContaining({ new_text: "import a;\nimport z;\n" }),
            ...(accepted ? [edit(3, firstEdit)] : []),
          ],
        },
      ]);
      expect(applied).not.toHaveBeenCalled();
    },
  );

  it("stages only the formatter output for an otherwise fully staged file", async () => {
    mockFormat([hunk(2, "const c=0;\n")]);
    const staged = vi.spyOn(commands, "vcsStageFormattedText").mockResolvedValue(ok(null));
    await runCommitModifications([{ ...file, staged: "modified", unstaged: null }], () => selection());
    expect(staged).toHaveBeenCalledExactlyOnceWith(path, initial, initial.replace("const c=3;", lastEdit));
  });

  it.each(["modified", "deleted"] as const)("formats only the index when the worktree file is %s", async (unstaged) => {
    const applied = mockFormat([hunk(2, "const c=0;\n")]);
    const opened = vi.spyOn(commands, "docOpen");
    const format = vi.spyOn(commands, "lspFormatText").mockResolvedValue(ok([edit(0, firstEdit), edit(2, lastEdit)]));
    const staged = vi.spyOn(commands, "vcsStageFormattedText").mockResolvedValue(ok(null));
    await runCommitModifications([{ ...file, staged: "modified", unstaged }], () => selection());
    expect(format).toHaveBeenCalledExactlyOnceWith(path, initial, { tabSize: 4, insertSpaces: true });
    expect(staged).toHaveBeenCalledExactlyOnceWith(path, initial, initial.replace("const c=3;", lastEdit));
    expect(opened).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
    expect(commands.docSave).not.toHaveBeenCalled();
  });

  it("formats the index when an open buffer has already diverged from the selection", async () => {
    const applied = mockFormat([hunk(2, "const c=0;\n")]);
    vi.spyOn(commands, "docSnapshot").mockResolvedValue(
      ok({ id: 1, text: initial + "// unsaved\n", version: 4 } as DocumentInfo),
    );
    const format = vi.spyOn(commands, "lspFormatText").mockResolvedValue(ok([edit(2, lastEdit)]));
    const staged = vi.spyOn(commands, "vcsStageFormattedText").mockResolvedValue(ok(null));
    await runCommitModifications([{ ...file, staged: "modified", unstaged: null }], () => selection());
    expect(format).toHaveBeenCalledExactlyOnceWith(path, initial, { tabSize: 4, insertSpaces: true });
    expect(staged).toHaveBeenCalledExactlyOnceWith(path, initial, initial.replace("const c=3;", lastEdit));
    expect(applied).not.toHaveBeenCalled();
  });

  it("skips symlinks in the index", async () => {
    mockFormat([]);
    vi.spyOn(commands, "vcsFileMode").mockResolvedValue(ok("120000"));
    const format = vi.spyOn(commands, "lspFormatText");
    await runCommitModifications([{ ...file, staged: "added" }], () => selection());
    expect(format).not.toHaveBeenCalled();
  });
});
