import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitOptions, CommitSelection, FileStatus, LineHunk } from "@/bindings";
import { commands } from "@/platform/ipc";
import { useTodoSettings } from "@/platform/todo";
import { badFileName, installCommitChecks, runCommitChecks } from "../commitChecks";
import { getCommitChecks, registerCommitCheck, type CommitCheck } from "../commitCheckRegistry";
import { todosForCommit } from "../commitTodo";
import { useVcs } from "../store";

const disposers: Array<() => void> = [];
const file: FileStatus = {
  path: "/p/a.ts",
  relPath: "a.ts",
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
};
const selection = (options: Partial<CommitOptions> = {}): CommitSelection => ({
  revision: 1,
  message: "Changes",
  amend: options.amend ?? false,
  repositories: [{ root: "/p", options: { amend: false, signOff: false, author: null, runHooks: true, ...options } }],
});
const prepare = async () => selection();

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
});

describe("badFileName", () => {
  const root = "/repo";

  it("flags names reserved on Windows, with or without an extension", () => {
    expect(badFileName(["/repo/src/con.ts"], root)).toEqual({ name: "con.ts", kind: "reserved" });
    expect(badFileName(["/repo/LPT1/a.txt"], root)).toEqual({ name: "LPT1", kind: "reserved" });
  });

  it("flags characters Windows rejects", () => {
    expect(badFileName(["/repo/docs/what?.md"], root)).toEqual({ name: "what?.md", kind: "char" });
    expect(badFileName(["/repo/a:b"], root)).toEqual({ name: "a:b", kind: "char" });
  });

  it("accepts ordinary names, including ones that merely contain a reserved word", () => {
    expect(badFileName(["/repo/src/console.ts", "/repo/com10.txt", "/repo/.auxrc"], root)).toBeNull();
  });
});

describe("the commit check registry", () => {
  const register = (id: string, order: CommitCheck["order"], run: CommitCheck["run"]) =>
    disposers.push(registerCommitCheck({ id, title: id, order, run }));

  it("runs checks by order, then id", async () => {
    const seen: string[] = [];
    const record = (id: string) => {
      seen.push(id);
      return null;
    };
    register("vcs.z", 20, () => record("vcs.z"));
    register("vcs.b", 10, () => record("vcs.b"));
    register("vcs.a", 10, () => record("vcs.a"));
    register("vcs.early", undefined, () => record("vcs.early"));

    expect(getCommitChecks().map((check) => check.id)).toEqual(["vcs.early", "vcs.a", "vcs.b", "vcs.z"]);
    await runCommitChecks([], false, prepare);
    expect(seen).toEqual(["vcs.early", "vcs.a", "vcs.b", "vcs.z"]);
  });

  it("blocks the commit on an error", async () => {
    register("vcs.error", 1, () => ({ severity: "error", text: "Fix this first" }));
    const run = await runCommitChecks([file], false, prepare);
    expect(run.blocked).toBe(true);
    expect(run.problems).toMatchObject([{ title: "vcs.error", text: "Fix this first" }]);
  });

  it("does not block the commit on a warning", async () => {
    register("vcs.warning", 1, () => ({ severity: "warning", text: "Worth a look" }));
    const run = await runCommitChecks([file], false, prepare);
    expect(run.blocked).toBe(false);
    expect(run.problems).toMatchObject([{ title: "vcs.warning", text: "Worth a look" }]);
  });

  it("offers the result's fix in the commit panel, and runs it", async () => {
    const fix = vi.fn();
    register("vcs.fix", 1, () => ({
      severity: "warning",
      text: "Something to review",
      fix: { label: "Review", run: fix },
    }));
    const run = await runCommitChecks([], false, prepare);
    expect(run.problems[0]!.details).toMatchObject({ label: "Review" });
    run.problems[0]!.details!.run();
    expect(fix).toHaveBeenCalledOnce();
  });

  it("reports a check that throws as an error instead of breaking the commit", async () => {
    register("vcs.broken", 1, () => {
      throw new Error("boom");
    });
    const run = await runCommitChecks([], false, prepare);
    expect(run.blocked).toBe(true);
    expect(run.problems).toMatchObject([{ title: "vcs.broken", text: "The check could not run: boom" }]);
  });
});

describe("commit target checks", () => {
  const worker = "/p/worker";
  const workerFile = { ...file, path: worker + "/b.ts", relPath: "b.ts" };
  const pending = (root: string) => {
    const draft = selection();
    return { ...draft, repositories: [{ ...draft.repositories[0]!, root }] };
  };

  function setup(interactiveRebase = false, operation?: string) {
    const previous = useVcs.getState();
    useVcs.setState({
      root: "/p",
      repo: "/p",
      roots: ["/p", worker],
      operations: operation ? { [worker]: operation } : {},
      heads: {
        "/p": { head: "main", headCommit: "main-id" },
        [worker]: { head: null, headCommit: "worker-id", interactiveRebase },
      },
    });
    const large = vi.spyOn(commands, "vcsCommitLargeFiles").mockResolvedValue({ status: "ok", data: [] });
    const crlf = vi.spyOn(commands, "vcsCommitCrlfPaths").mockResolvedValue({ status: "ok", data: [] });
    disposers.push(
      () => useVcs.setState(previous, true),
      installCommitChecks(),
      () => large.mockRestore(),
      () => crlf.mockRestore(),
    );
  }

  it("warns for a selected detached repository even when the toolbar shows a different branch", async () => {
    setup();
    const result = await runCommitChecks([workerFile], false, async () => pending(worker));
    expect(result).toMatchObject({
      blocked: true,
      problems: [
        {
          title: "Commit in detached HEAD",
          text: "worker is in detached HEAD. Create a branch to keep new commits.",
          details: { label: "More about detached HEAD" },
        },
      ],
    });
    expect(await runCommitChecks([file], false, async () => pending("/p"))).toEqual({ blocked: false, problems: [] });
  });

  it("warns during a regular rebase and permits commits at interactive edit stops", async () => {
    setup(false, "rebase");
    const run = () => runCommitChecks([workerFile], false, async () => pending(worker));
    expect(await run()).toMatchObject({
      blocked: true,
      problems: [{ title: "Commit during rebase", details: { label: "More about Git rebase" } }],
    });
    const { heads } = useVcs.getState();
    useVcs.setState({ heads: { ...heads, [worker]: { ...heads[worker]!, interactiveRebase: true } } });
    expect(await run()).toEqual({ blocked: false, problems: [] });
  });
});

describe("TODO checks of the pending commit", () => {
  const staged = { ...file, staged: "modified" as const };
  const hunk = (start: number, lines: number, oldStart: number, oldText: string): LineHunk => ({
    start,
    lines,
    oldStart,
    oldLines: oldText.split("\n").length - 1,
    oldText,
    kind: "modified",
  });
  const ok = <T>(data: T) => ({ status: "ok" as const, data });

  it("ignores TODOs only in unstaged text when committing the index", async () => {
    vi.spyOn(commands, "vcsFileAt").mockImplementation(async (_path, rev) =>
      ok(rev === ":0" ? "Staged\r\n" : "Original\n"),
    );
    const working = vi.spyOn(commands, "fsReadText").mockResolvedValue(ok("// TODO only in unstaged text\n"));
    vi.spyOn(commands, "vcsDiffHunks").mockResolvedValue([hunk(0, 1, 0, "Original\n")]);
    expect(await todosForCommit([staged], selection())).toEqual({ files: [], skipped: [] });
    expect(working).not.toHaveBeenCalled();
  });

  it("maps staged TODOs into the working file or keeps the selected diff when a line no longer exists", async () => {
    const before = "Original\nBase\nLast\n";
    const index = "// TODO staged and kept\nBase\n// FIXME staged and removed\n";
    const work = "Inserted\n// TODO staged and kept\nBase\n";
    vi.spyOn(commands, "vcsFileAt").mockImplementation(async (_path, rev) => ok(rev === ":0" ? index : before));
    vi.spyOn(commands, "fsReadText").mockResolvedValue(ok(work));
    vi.spyOn(commands, "vcsDiffHunks").mockImplementation(async (old) =>
      old === index
        ? [hunk(0, 1, 0, ""), hunk(3, 0, 2, "// FIXME staged and removed\n")]
        : [hunk(0, 1, 0, "Original\n"), hunk(2, 1, 2, "Last\n")],
    );
    const {
      files: [review],
      skipped,
    } = await todosForCommit([staged], selection());
    expect(skipped).toEqual([]);
    expect(review).toMatchObject({
      text: index,
      items: [
        { line: 0, text: "TODO staged and kept" },
        { line: 2, text: "FIXME staged and removed" },
      ],
      diff: { left: { text: before }, right: { text: index, label: "Staged (index)" } },
    });
    expect(review?.worktreeLines).toEqual(new Map([[0, 1]]));
  });

  it("checks only selected hunks and reveals their lines in the worktree", async () => {
    const before = "Top\nBase\nOld line\n";
    const working = "// TODO excluded\nTop\nBase\n// FIXME included\n";
    const selected = "Top\nBase\n// FIXME included\n";
    const partial = hunk(3, 1, 2, "Old line\n");
    vi.spyOn(commands, "vcsFileAt").mockResolvedValue(ok(before));
    vi.spyOn(commands, "fsReadText").mockResolvedValue(ok(working));
    const preview = vi.spyOn(commands, "vcsPreviewPartialCommit").mockResolvedValue(ok(selected));
    vi.spyOn(commands, "vcsDiffHunks").mockImplementation(async (old, next) => {
      if (old === selected) return [hunk(0, 1, 0, "")];
      expect(next).toBe(selected);
      return [hunk(2, 1, 2, "Old line\n")];
    });
    const { files: hits } = await todosForCommit(
      [file],
      selection({ partial: [{ path: file.path, hunks: [partial] }] }),
    );
    expect(hits).toMatchObject([
      { items: [{ path: file.path, line: 2, col: 3, text: "FIXME included" }], text: selected },
    ]);
    expect(hits[0]?.worktreeLines).toEqual(new Map([[2, 3]]));
    expect(preview).toHaveBeenCalledWith({ path: file.path, hunks: [partial] });
  });

  it("checks an amended partial commit against its parent", async () => {
    const parent = "First\nBase\nLast\n";
    const head = "// TODO kept from the commit\nBase\nLast\n";
    const working = "Removed from the worktree\nBase\nSelected edit\n";
    const amended = "// TODO kept from the commit\nBase\nSelected edit\n";
    const partial = hunk(2, 1, 2, "Last\n");
    vi.spyOn(commands, "vcsFileAt").mockImplementation(async (_path, rev) => ok(rev === "HEAD~1" ? parent : head));
    vi.spyOn(commands, "fsReadText").mockResolvedValue(ok(working));
    vi.spyOn(commands, "vcsPreviewPartialCommit").mockResolvedValue(ok(amended));
    vi.spyOn(commands, "vcsDiffHunks").mockImplementation(async (old, next) => {
      if (old === amended) return [hunk(0, 1, 0, "// TODO kept from the commit\n")];
      expect([old, next]).toEqual([parent, amended]);
      return [hunk(0, 1, 0, "First\n"), partial];
    });
    const { files: hits } = await todosForCommit(
      [file],
      selection({ amend: true, partial: [{ path: file.path, hunks: [partial] }] }),
    );
    expect(hits).toMatchObject([
      {
        items: [{ line: 0, text: "TODO kept from the commit" }],
        text: amended,
        diff: { left: { text: parent }, right: { text: amended } },
      },
    ]);
  });

  it("uses custom patterns, matching case and comment rules for changed lines", async () => {
    const saved = useTodoSettings.getState();
    useTodoSettings.setState({
      caseSensitive: false,
      commentsOnly: true,
      patterns: [
        { id: "review", enabled: true, keyword: "REVIEW", color: "var(--info)" },
        { id: "todo", enabled: false, keyword: "TODO", color: "var(--info)" },
      ],
    });
    try {
      const original = "Original\n";
      const index = 'const marker = "REVIEW";\n// review deployment\n// TODO ignored\n';
      vi.spyOn(commands, "vcsFileAt").mockImplementation(async (_path, rev) => ok(rev === ":0" ? index : original));
      vi.spyOn(commands, "fsReadText").mockResolvedValue(ok(index));
      vi.spyOn(commands, "vcsDiffHunks").mockResolvedValue([hunk(0, 3, 0, original)]);
      expect(await todosForCommit([staged], selection())).toMatchObject({
        files: [{ items: [{ path: file.path, line: 1, col: 3, text: "review deployment" }] }],
        skipped: [],
      });
    } finally {
      useTodoSettings.setState(saved, true);
    }
  });

  it("keeps findings when another file is unreadable and ignores binary files and submodule pointers", async () => {
    const withPath = (relPath: string) => ({ ...staged, path: `/p/${relPath}`, relPath });
    const locked = withPath("locked.ts");
    const binary = withPath("binary.dat");
    const submodule = withPath("submodule");
    const indexed = "// TODO in the selected file\n";
    vi.spyOn(commands, "vcsFileAt").mockImplementation(async (path, rev) => {
      if (rev !== ":0") return ok(null);
      if (path === locked.path) return { status: "error", error: { kind: "io", message: "File locked", data: null } };
      if (path === submodule.path) return ok(null);
      return ok(path === binary.path ? "\0binary" : indexed);
    });
    vi.spyOn(commands, "vcsDiffEntries").mockImplementation(async (entries) =>
      ok(entries.map(({ path }) => (path === submodule.path ? { mode: "160000", gitlink: "submodule-head" } : null))),
    );
    vi.spyOn(commands, "fsReadText").mockResolvedValue(ok(indexed));

    const result = await todosForCommit([staged, locked, binary, submodule], selection());
    expect(result.files).toMatchObject([{ items: [{ text: "TODO in the selected file" }] }]);
    expect(result.skipped).toEqual([
      { path: locked.path, reason: "Could not read the selected version.", detail: "File locked" },
    ]);
  });

  it("reports an unreadable base only when it needs the base to classify a TODO", async () => {
    const clean = { ...staged, path: "/p/clean.ts", relPath: "clean.ts" };
    vi.spyOn(commands, "vcsFileAt").mockImplementation(async (path, rev) => {
      if (rev === ":0") return ok(path === staged.path ? "// TODO from unknown base\n" : "No tasks\n");
      return { status: "error", error: { kind: "io", message: "Could not read object", data: null } };
    });
    const diff = vi.spyOn(commands, "vcsDiffHunks");
    expect(await todosForCommit([staged, clean], selection())).toEqual({
      files: [],
      skipped: [{ path: staged.path, reason: "Could not read the previous version.", detail: "Could not read object" }],
    });
    expect(diff).not.toHaveBeenCalled();
  });

  it("compares a staged rename with its original path", async () => {
    const base = "// TODO already there\n";
    const reads = vi.spyOn(commands, "vcsFileAt").mockResolvedValue(ok(base));
    vi.spyOn(commands, "vcsDiffHunks").mockResolvedValue([]);
    const renamed = { ...staged, staged: "renamed" as const, renamedFrom: "old.ts" };
    expect(await todosForCommit([renamed], selection())).toEqual({ files: [], skipped: [] });
    expect(reads.mock.calls).toEqual([
      ["/p/old.ts", "HEAD"],
      [file.path, ":0"],
    ]);
  });
});
