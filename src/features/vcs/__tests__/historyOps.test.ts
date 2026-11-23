import type { Commit } from "@/bindings";
import { describe, expect, it } from "vitest";
import { operationActions } from "../BranchWidget";
import { commitMenu } from "../log/commitMenu";
import { extendCommitSelection, selectCommit, selectedCommits, toggleCommitSelection, useGitLog } from "../logStore";
import { controlLabel, inProgress, operationControls, operationTitle, validateTagName } from "../operations";
import { suggestedPatchName } from "../patches";
import { useVcs } from "../store";

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

const menuOrder = (items: ReturnType<typeof commitMenu>) =>
  items.map((item) => (item.kind === "separator" ? "-" : item.kind === "action" ? item.action : item.label));

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

  it("offers Resolve Conflicts when conflicts remain with no operation in progress", () => {
    // Applying a stash, or the autostash of a pull, leaves conflicts and no merge or rebase.
    expect(operationActions(null, 1).map((a) => a.id)).toEqual(["vcs.resolveConflicts"]);
  });
});

describe("Git Log commit actions", () => {
  it("lists single-commit actions in the IDE's Git Log menu order, all bound to the commit", () => {
    const c = commit("Fix it");
    const items = commitMenu(c);
    expect(menuOrder(items)).toEqual([
      "vcs.log.copyRevision",
      "vcs.log.createPatch",
      "vcs.log.cherryPick",
      "-",
      "vcs.log.checkoutRevision",
      "Show Repository at Revision",
      "vcs.log.compareWithLocal",
      "-",
      "vcs.log.resetToHere",
      "vcs.log.revert",
      "vcs.log.undoCommit",
      "-",
      "vcs.log.editMessage",
      "vcs.log.fixup",
      "vcs.log.squashInto",
      "vcs.log.dropCommit",
      "vcs.log.interactiveRebase",
      "vcs.log.pushUpToHere",
      "-",
      "vcs.log.rebaseOntoCommit",
      "vcs.log.newBranch",
      "vcs.log.newTag",
      "-",
      "vcs.log.goToChild",
      "vcs.log.goToParent",
      "-",
      "vcs.log.openInBrowser",
    ]);
    expect(items.every((i) => !("arg" in i) || i.arg === c)).toBe(true);
    // Only these rows carry an icon; the others are explicitly drawn without one.
    const icons = Object.fromEntries(
      items.flatMap((i) => (i.kind === "action" && i.icon !== undefined ? [[i.action, i.icon]] : [])),
    );
    expect(icons).toMatchObject({
      "vcs.log.createPatch": "patch",
      "vcs.log.cherryPick": "cherry-pick",
      "vcs.log.resetToHere": "revert",
      "vcs.log.revert": null,
      "vcs.log.compareWithLocal": null,
      "vcs.log.goToChild": null,
    });
    expect(icons).not.toHaveProperty("vcs.log.copyRevision");
    expect(icons).not.toHaveProperty("vcs.log.openInBrowser");
  });

  it("keeps read-only commits to copying, the revision and navigation", () => {
    const c = { ...commit("Read-only"), readOnly: true };
    expect(menuOrder(commitMenu(c, [c], "/repo/file.ts"))).toEqual([
      "vcs.log.copyRevision",
      "-",
      "Show Repository at Revision",
      "vcs.log.showFileAtRevision",
      "-",
      "vcs.log.goToChild",
      "vcs.log.goToParent",
    ]);
  });

  it("adds file-scoped revision actions only to a File History commit menu", () => {
    const c = commit("Rename file");
    const items = commitMenu(c, [c], "/repo/new.txt");
    const show = items.find((i) => "action" in i && i.action === "vcs.log.showFileAtRevision");
    const compare = items.find((i) => "action" in i && i.action === "vcs.log.compareWithLocal");
    const scoped = { kind: "file-history-commit", commit: c, target: "/repo/new.txt" };
    expect(show).toMatchObject({ arg: scoped });
    expect(compare).toMatchObject({ arg: scoped });
    expect(commitMenu(c).some((i) => "action" in i && i.action === "vcs.log.showFileAtRevision")).toBe(false);
  });

  it("offers history rewriting for pushed commits too (IDEA allows it; the run confirms)", () => {
    const local = commit("Local", "1".repeat(40));
    const pushed = commit("Pushed", "2".repeat(40));
    const rewriting = (c: Commit) =>
      commitMenu(c).flatMap((i) =>
        i.kind === "action" &&
        i.disabled &&
        ["editMessage", "fixup", "squashInto", "dropCommit", "interactiveRebase"].some((a) => i.action.endsWith(a))
          ? [i.action]
          : [],
      );
    expect(rewriting(local)).toEqual([]);
    expect(rewriting(pushed)).toEqual([]);
  });

  it.each(["main", null])("offers pushing a single selected commit when HEAD is %s", (head) => {
    const { branch } = useVcs.getState();
    useVcs.setState({
      branch: {
        head,
        headCommit: "1".repeat(40),
        upstream: head ? "origin/main" : null,
        ahead: 0,
        behind: 0,
        operation: null,
      },
    });
    try {
      const selected = commit("Selected commit");
      expect(
        commitMenu(selected).some(
          (item) =>
            item.kind === "action" && item.action === "vcs.log.pushUpToHere" && !item.disabled && item.arg === selected,
        ),
      ).toBe(true);
    } finally {
      useVcs.setState({ branch });
    }
  });

  it("hides one-commit edits and disables the other single-commit actions for a multiple selection", () => {
    const a = commit("A", "a".repeat(40));
    const b = commit("B", "b".repeat(40));
    const c = commit("C", "c".repeat(40));
    const order = (selection: Commit[]) => menuOrder(commitMenu(a, selection));
    const multi = (compare: string[]) => [
      "vcs.log.copyRevision",
      "vcs.log.createPatch",
      "vcs.log.cherryPick",
      "-",
      "Show Repository at Revision",
      ...compare,
      "vcs.log.compareWithLocal",
      "-",
      "vcs.log.resetToHere",
      "vcs.log.revert",
      "-",
      "vcs.log.dropCommit",
      "vcs.log.squashCommits",
      "vcs.log.pushUpToHere",
      "-",
      "vcs.log.newBranch",
      "vcs.log.newTag",
      "-",
      "vcs.log.goToChild",
      "vcs.log.goToParent",
      "-",
      "vcs.log.openInBrowser",
    ];
    expect(order([a, b])).toEqual(multi(["vcs.log.compareVersions"]));
    expect(order([a, b, c])).toEqual(multi([]));
    const enabled = commitMenu(a, [a, b])
      .filter((i) => i.kind === "action" && !i.disabled)
      .map((i) => (i.kind === "action" ? i.action : ""));
    expect(enabled).toEqual([
      "vcs.log.copyRevision",
      "vcs.log.createPatch",
      "vcs.log.cherryPick",
      "vcs.log.compareVersions",
      "vcs.log.revert",
      "vcs.log.dropCommit",
      "vcs.log.squashCommits",
    ]);
  });

  it("scopes only File History Compare Versions to its selected file", () => {
    const older = { ...commit("Older", "a".repeat(40)), historyPath: "old/name.ts" };
    const newer = { ...commit("Newer", "b".repeat(40)), historyPath: "renamed/name.ts" };
    const target = "/repo/current/name.ts";
    const normal = commitMenu(newer, [newer, older]).find(
      (i) => i.kind === "action" && i.action === "vcs.log.compareVersions",
    );
    const history = commitMenu(newer, [newer, older], target).find(
      (i) => i.kind === "action" && i.action === "vcs.log.compareVersions",
    );

    expect(normal).toMatchObject({ arg: [newer, older] });
    expect(history).toMatchObject({
      arg: { kind: "file-history-commits", commits: [newer, older], target },
    });
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
