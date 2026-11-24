import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commit = vi.hoisted(() => vi.fn());
const createPatch = vi.hoisted(() => vi.fn());

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    isTauri: () => false,
    call: async (p: Promise<{ status: "ok"; data: unknown }>) => (await p).data,
    commands: {
      ...real.commands,
      vcsCommit: commit.mockImplementation(() => ok("commit1")),
      vcsConfigGet: () => ok("configured"),
      vcsPendingPatch: createPatch.mockImplementation(() => ok("diff --git a/p b/p\n")),
    },
  };
});

import type { CommitSelection, FileStatus } from "@/bindings";
import { useProject } from "@/platform/project";
import { deferred } from "@/test/deferred";
import { maybeCommitService, registerCommitCheckProvider } from "@/workbench/contributions";
import { checkCommitChanges, commitChanges } from "../changeOps";
import { registerCommitCheck } from "../commitCheckRegistry";
import { draftRevision, installDraftRevision, provideCommit } from "../commitSelection";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

const files: FileStatus[] = ["a", "b"].map((n) => ({
  path: `/p/${n}.ts`,
  relPath: `${n}.ts`,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
}));

let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  useProject.setState({ settings: null });
  commit.mockClear();
  createPatch.mockClear();
  useVcs.setState({
    available: false,
    root: "/p",
    repo: "/p",
    roots: ["/p"],
    status: files,
    branch: null,
    operations: {},
    heads: {},
  });
  useCommit.setState({
    message: "feat: x",
    amend: false,
    groupByRepo: true,
    excludedStagedRepos: new Set(),
    checks: new Map([["/p/b.ts", "none" as const]]),
    excludedHunks: new Map(),
    checkResult: null,
  });
  disposers = [installDraftRevision(), provideCommit()];
});

afterEach(() => disposers.reverse().forEach((d) => d()));

describe("the commit plugins see", () => {
  it("is what Commit would commit, and the message is replaced only at its revision", async () => {
    const service = maybeCommitService()!;
    const selection = (await service.selection())!;
    expect(selection.message).toBe("feat: x");
    expect(selection.repositories).toEqual([
      { root: "/p", options: expect.objectContaining({ stage: ["/p/a.ts"], exclude: [], partial: [] }) },
    ]);

    // The user types meanwhile: the plugin's message would overwrite it.
    useCommit.setState({ message: "feat: typed" });
    expect(service.setMessage(selection.revision, "generated")).toBe(false);
    expect(useCommit.getState().message).toBe("feat: typed");

    expect(service.setMessage(draftRevision(), "generated")).toBe(true);
    expect(useCommit.getState().message).toBe("generated");
    // Including another file is a new draft too.
    const before = draftRevision();
    useCommit.setState({ checks: new Map() });
    expect(draftRevision()).toBeGreaterThan(before);
  });

  it("leaves another repository's staged files out of the only repository committed", async () => {
    const staged: FileStatus = {
      path: "/w/b/new.yml",
      relPath: "new.yml",
      staged: "added",
      unstaged: null,
      renamedFrom: null,
    };
    const changed: FileStatus = { ...files[0]!, path: "/w/a/Foo.java", relPath: "Foo.java" };
    useVcs.setState({ root: "/w", repo: "/w/a", roots: ["/w/a", "/w/b"], status: [changed, staged] });
    useCommit.setState({ checks: new Map([["/w/b/new.yml", "none" as const]]) });
    const selection = (await maybeCommitService()!.selection())!;
    expect(selection.repositories).toEqual([
      { root: "/w/a", options: expect.objectContaining({ stage: ["/w/a/Foo.java"], exclude: [] }) },
    ]);
  });

  it("uses the checked staging repositories for commit checks, pending changes and Amend", async () => {
    const roots = ["/w/a", "/w/b"];
    const status = roots.map((root) => ({ ...files[0]!, path: root + "/a.ts", staged: "modified" as const }));
    useVcs.setState({ root: "/w", repo: roots[1], roots, status });
    useProject.setState({ settings: { vcs: { git: { stagingArea: true } } } as never });
    useCommit.setState({ excludedStagedRepos: new Set([roots[1]!]) });
    const service = maybeCommitService()!;
    const checks = vi.fn(async () => []);
    disposers.push(registerCommitCheckProvider({ checks: () => [{ key: "acme/scope", title: "Scope" }], run: checks }));

    expect((await service.selection())!.repositories.map(({ root }) => root)).toEqual([roots[0]]);
    expect((await service.changes())!.roots).toEqual([roots[0]]);
    await checkCommitChanges();
    expect(checks).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        repositories: [{ root: roots[0], options: expect.objectContaining({ stage: [], exclude: [] }) }],
      }),
      ["acme/scope"],
    );

    useCommit.setState({ amend: true, excludedStagedRepos: new Set(roots) });
    expect((await service.selection())!.repositories).toEqual([]);
    expect(await commitChanges()).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();

    useVcs.setState({ status: [status[0]!] });
    useVcs.setState({ status });
    expect((await service.selection())!.repositories.map(({ root }) => root)).toEqual([roots[1]]);
  });

  it("does not commit an unchecked repository when the checked index becomes empty during save", async () => {
    const [a, b] = ["/w/a", "/w/b"] as const;
    const status = [a, b].map((root) => ({ ...files[0]!, path: root + "/a.ts", staged: "modified" as const }));
    useVcs.setState({ root: "/w", repo: b, roots: [a, b], status });
    useProject.setState({ settings: { vcs: { git: { stagingArea: true } } } as never });
    useCommit.setState({ excludedStagedRepos: new Set([b]) });
    const editor = vi.spyOn(await import("@/workbench/contributions"), "maybeEditorService").mockReturnValueOnce({
      saveAll: async () => useVcs.setState({ status: [{ ...status[0]!, staged: null }, status[1]!] }),
    } as never);
    disposers.push(() => editor.mockRestore());
    expect(await commitChanges()).toBeUndefined();
    expect(useVcs.getState().status[0]?.staged).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("is null without a repository", async () => {
    useVcs.setState({ root: null });
    expect(await maybeCommitService()!.selection()).toBeNull();
    expect(await maybeCommitService()!.changes()).toBeNull();
    expect(maybeCommitService()!.setMessage(draftRevision(), "x")).toBe(false);
  });

  it("reads the diff of what Commit would commit, at the revision of the draft", async () => {
    const changes = (await maybeCommitService()!.changes())!;
    expect(createPatch).toHaveBeenCalledExactlyOnceWith("/p", expect.objectContaining({ stage: ["/p/a.ts"] }));
    expect(changes).toEqual({ revision: draftRevision(), roots: ["/p"], patch: "diff --git a/p b/p\n" });
    expect(maybeCommitService()!.setMessage(changes.revision, "generated")).toBe(true);
  });

  it("reads one diff per repository with included files", async () => {
    const other: FileStatus = { ...files[0]!, path: "/w/b/Bar.java", relPath: "Bar.java" };
    const changed: FileStatus = { ...files[0]!, path: "/w/a/Foo.java", relPath: "Foo.java" };
    useVcs.setState({ root: "/w", repo: "/w/a", roots: ["/w/a", "/w/b"], status: [changed, other] });
    useCommit.setState({ checks: new Map() });
    const changes = (await maybeCommitService()!.changes())!;
    expect(createPatch.mock.calls).toEqual([
      ["/w/b", expect.objectContaining({ stage: ["/w/b/Bar.java"] })],
      ["/w/a", expect.objectContaining({ stage: ["/w/a/Foo.java"] })],
    ]);
    expect(changes.roots).toEqual(["/w/b", "/w/a"]);
    expect(changes.patch).toBe("diff --git a/p b/p\n\ndiff --git a/p b/p\n");
  });

  it("is an empty diff when nothing is included", async () => {
    useCommit.setState({ checks: new Map(files.map((f) => [f.path, "none" as const])) });
    expect((await maybeCommitService()!.changes())!.patch).toBe("");
    expect(createPatch).not.toHaveBeenCalled();
  });
});

describe("contributed before-commit checks", () => {
  it("stop the commit with their problems, and run on what it commits", async () => {
    const seen: Array<{ selection: CommitSelection; keys: string[] }> = [];
    disposers.push(
      registerCommitCheckProvider({
        checks: () => [{ key: "acme/markers", title: "Markers" }],
        run: async (selection, keys) => {
          seen.push({ selection, keys });
          return [{ title: "Markers", message: "Remove the marker.", path: "/p/a.ts", line: 3 }];
        },
      }),
    );
    expect(await commitChanges()).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.keys).toEqual(["acme/markers"]);
    expect(seen[0]!.selection.repositories[0]!.options.stage).toEqual(["/p/a.ts"]);
    const [problem] = useCommit.getState().checkResult!.problems;
    expect(problem).toMatchObject({ title: "Markers", text: "Remove the marker.", details: { label: "a.ts:4" } });

    // Commit Anyway: the shown problems are not asked again.
    expect(await commitChanges()).toEqual([{ repo: "/p", id: "commit1" }]);
    expect(seen).toHaveLength(1);
  });

  it("checks the included changes without committing and reruns previous failures", async () => {
    const checks = vi
      .fn()
      .mockResolvedValueOnce([{ title: "Markers", message: "Remove the marker." }])
      .mockResolvedValue([]);
    disposers.push(
      registerCommitCheckProvider({ checks: () => [{ key: "acme/markers", title: "Markers" }], run: checks }),
    );
    await checkCommitChanges();
    expect(useCommit.getState().checkResult).toMatchObject({ blocked: true });
    expect(checks.mock.calls[0]![0].repositories[0].options.stage).toEqual(["/p/a.ts"]);

    await checkCommitChanges();
    expect(checks).toHaveBeenCalledTimes(2);
    expect(useCommit.getState().checkResult).toEqual({ problems: [], blocked: false });
    expect(useCommit.getState().message).toBe("feat: x");
    expect(commit).not.toHaveBeenCalled();
  });

  it("runs checks again for a commit after a standalone warning", async () => {
    const check = vi.fn().mockReturnValueOnce({ severity: "warning", text: "Review this file." }).mockReturnValue(null);
    disposers.push(registerCommitCheck({ id: "test.review", title: "Review", run: check }));
    await checkCommitChanges();
    expect(useCommit.getState().checkResult).toMatchObject({ blocked: false, problems: [{ title: "Review" }] });

    expect(await commitChanges()).toEqual([{ repo: "/p", id: "commit1" }]);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps previous issues available for review but rechecks after the included file changes", async () => {
    const check = vi.fn().mockReturnValue({ severity: "error", text: "Review this file." });
    disposers.push(registerCommitCheck({ id: "test.review", title: "Review", run: check }));
    await checkCommitChanges();
    useCommit.setState({ checks: new Map([["/p/a.ts", "none"]]) });
    expect(useCommit.getState().checkResult).toMatchObject({ stale: true, problems: [{ title: "Review" }] });

    expect(await commitChanges()).toBeUndefined();
    expect(check.mock.calls.map(([ctx]) => ctx.existing)).toEqual([["/p/a.ts"], ["/p/b.ts"]]);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rechecks when an included repository detaches at the same commit", () => {
    const worker = "/p/worker";
    const other = "/p/other";
    const onBranch = { head: "main", headCommit: "same-id" };
    const heads = { "/p": onBranch, [worker]: onBranch, [other]: onBranch };
    useVcs.setState({
      roots: ["/p", worker, other],
      heads,
      status: [files[0]!, { ...files[1]!, path: worker + "/b.ts" }],
    });
    useCommit.setState({ checkResult: { blocked: true, problems: [{ title: "Review", text: "Review first." }] } });

    useVcs.setState({ heads: { ...heads } });
    useVcs.setState({ heads: { ...heads, [other]: { ...onBranch, head: null } } });
    expect(useCommit.getState().checkResult?.stale).toBeUndefined();

    useVcs.setState({ heads: { ...heads, [worker]: { ...onBranch, head: null } } });
    expect(useCommit.getState().checkResult?.stale).toBe(true);
  });

  it("discards feedback for an in-flight check when the draft changes and guards concurrent commits", async () => {
    const result = deferred<{ severity: "error"; text: string }>();
    const check = vi.fn(() => result.promise);
    disposers.push(registerCommitCheck({ id: "test.review", title: "Review", run: check }));
    const pending = checkCommitChanges();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(await commitChanges()).toBeUndefined();
    useCommit.setState({ checks: new Map([["/p/a.ts", "none"]]) });
    result.resolve({ severity: "error", text: "Old result." });
    await pending;
    expect(useCommit.getState().checkResult).toBeNull();
    expect(useCommit.getState().operation).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });
});
