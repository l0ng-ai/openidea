import { describe, expect, it } from "vitest";
import type { Commit } from "@/bindings";
import { operationActions } from "../BranchWidget";
import { controlLabel, inProgress, operationControls, operationTitle, validateTagName } from "../operations";
import { suggestedPatchName } from "../patches";
import { commitMenu } from "../GitLog";
import { extendCommitSelection, selectCommit, selectedCommits, toggleCommitSelection, useGitLog } from "../logStore";

const commit = (summary: string, id = "0123456789abcdef0123456789abcdef01234567"): Commit => ({
  id,
  shortId: id.slice(0, 8),
  parents: [],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary,
  message: summary,
  refs: [],
});

describe("operations in progress", () => {
  it("recognises the operations git can continue or abort", () => {
    expect(inProgress("rebase")).toBe("rebase");
    expect(inProgress("cherry-pick")).toBe("cherry-pick");
    expect(inProgress("bisect")).toBeNull();
    expect(inProgress(null)).toBeNull();
  });

  it("offers IDEA's controls and wording", () => {
    expect(operationControls("rebase")).toEqual(["continue", "skip", "abort"]);
    expect(operationControls("merge")).toEqual(["abort"]);
    expect(operationControls("cherry-pick")).toEqual(["continue", "abort"]);
    expect(controlLabel("rebase", "continue")).toBe("Continue Rebase");
    expect(controlLabel("cherry-pick", "abort")).toBe("Abort Cherry-Pick");
    expect(controlLabel("rebase", "skip")).toBe("Skip Commit");
    expect(operationTitle("rebase", "feature")).toBe("Rebasing feature");
    expect(operationTitle("merge", null)).toBe("Merging");
  });

  it("puts the controls at the top of the Branches popup", () => {
    expect(operationActions(null, 0)).toEqual([]);
    expect(operationActions("rebase", 2).map((a) => a.label)).toEqual([
      "Resolve Conflicts…",
      "Continue Rebase",
      "Skip Commit",
      "Abort Rebase",
    ]);
    expect(operationActions("merge", 0).map((a) => a.id)).toEqual(["vcs.merge.abort"]);
  });
});

describe("Git Log commit actions", () => {
  it("lists IDEA's commit context menu actions, all bound to the commit", () => {
    const c = commit("Fix it");
    const items = commitMenu(c);
    const ids = items.flatMap((i) => ("action" in i && i.kind === "action" ? [i.action] : []));
    expect(ids).toEqual([
      "vcs.log.copyRevision",
      "vcs.log.createPatch",
      "vcs.log.cherryPick",
      "vcs.log.checkoutRevision",
      "vcs.log.compareWithLocal",
      "vcs.log.resetToHere",
      "vcs.log.revert",
      "vcs.log.undoCommit",
      "vcs.log.editMessage",
      "vcs.log.fixup",
      "vcs.log.squashInto",
      "vcs.log.dropCommit",
      "vcs.log.interactiveRebase",
      "vcs.log.pushUpToHere",
      "vcs.log.rebaseOntoCommit",
      "vcs.log.newBranch",
      "vcs.log.newTag",
      "vcs.log.goToChild",
      "vcs.log.goToParent",
      "vcs.log.openInBrowser",
    ]);
    expect(items.every((i) => !("arg" in i) || i.arg === c)).toBe(true);
  });

  it("disables history rewriting for pushed commits", () => {
    const local = commit("Local", "1".repeat(40));
    const pushed = commit("Pushed", "2".repeat(40));
    useGitLog.setState({ outgoing: new Set([local.id]) });
    const disabled = (c: Commit) => commitMenu(c).flatMap((i) => (i.kind === "action" && i.disabled ? [i.action] : []));
    expect(disabled(local)).not.toContain("vcs.log.editMessage");
    expect(disabled(pushed)).toEqual(
      expect.arrayContaining([
        "vcs.log.editMessage",
        "vcs.log.fixup",
        "vcs.log.squashInto",
        "vcs.log.dropCommit",
        "vcs.log.interactiveRebase",
        "vcs.log.pushUpToHere",
      ]),
    );
    useGitLog.setState({ outgoing: null });
  });

  it("offers the multi-commit actions for a multiple selection", () => {
    const a = commit("A", "a".repeat(40));
    const b = commit("B", "b".repeat(40));
    const c = commit("C", "c".repeat(40));
    const ids = (sel: Commit[]) => commitMenu(a, sel).flatMap((i) => (i.kind === "action" ? [i.action] : []));
    expect(ids([a, b])).toEqual([
      "vcs.log.copyRevision",
      "vcs.log.createPatch",
      "vcs.log.cherryPick",
      "vcs.log.compareVersions",
      "vcs.log.revert",
      "vcs.log.squashCommits",
      "vcs.log.dropCommit",
    ]);
    // Compare Versions needs exactly two commits (IDEA).
    expect(ids([a, b, c])).not.toContain("vcs.log.compareVersions");
    expect(ids([a, b, c])).toContain("vcs.log.cherryPick");
  });

  it("extends and toggles the log selection", () => {
    const list = ["1", "2", "3", "4"].map((d) => commit(d, d.repeat(40)));
    useGitLog.setState({ commits: list });
    selectCommit(list[1]!.id);
    extendCommitSelection(list[3]!.id, list);
    expect(selectedCommits().map((c) => c.summary)).toEqual(["2", "3", "4"]);
    extendCommitSelection(list[0]!.id, list);
    expect(selectedCommits().map((c) => c.summary)).toEqual(["1", "2"]);
    toggleCommitSelection(list[3]!.id);
    expect(selectedCommits().map((c) => c.summary)).toEqual(["1", "2", "4"]);
    toggleCommitSelection(list[3]!.id);
    expect(useGitLog.getState().selected).toBe(list[0]!.id);
    useGitLog.setState({ commits: [], selection: [], selected: null });
  });

  it("validates tag names like git check-ref-format", () => {
    expect(validateTagName("v1.0")).toBeNull();
    expect(validateTagName("release/2024.1")).toBeNull();
    expect(validateTagName("")).toMatch(/empty/);
    expect(validateTagName("bad name")).toMatch(/Invalid/);
    expect(validateTagName("a..b")).toMatch(/Invalid/);
    expect(validateTagName("-x")).toMatch(/Invalid/);
    expect(validateTagName("v1", ["v1"])).toMatch(/already exists/);
  });

  it("suggests patch file names from the change list or commit", () => {
    expect(suggestedPatchName({ kind: "changes", files: [] }, "Changes")).toBe("Changes.patch");
    expect(suggestedPatchName({ kind: "commits", commits: [commit("Fix: crash on start!")] }, "x")).toBe(
      "Fix_crash_on_start.patch",
    );
    expect(suggestedPatchName({ kind: "commits", commits: [commit("a"), commit("b")] }, "x")).toBe("2_commits.patch");
    expect(suggestedPatchName({ kind: "changes", files: [] }, "///")).toBe("changes.patch");
  });
});
