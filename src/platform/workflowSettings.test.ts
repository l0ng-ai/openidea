import { describe, expect, it } from "vitest";
import { splitCommandLine } from "./commandLine";
import { DEFAULT_WORKFLOW, validateWorkflow } from "./workflowSettings";

describe("validateWorkflow", () => {
  it("recurses into submodules when cloning unless switched off", () => {
    const recurse = (cloneSubmodules: unknown) =>
      validateWorkflow({ vcs: { git: { cloneSubmodules } } }).vcs.git.cloneSubmodules;
    expect(recurse(undefined)).toBe(true);
    expect(recurse(false)).toBe(false);
    expect(recurse("off")).toBe(true);
  });

  it("keeps all four Git fetch tag modes and uses Auto for older projects", () => {
    const mode = (fetchTagsMode: unknown) =>
      validateWorkflow({ vcs: { git: { fetchTagsMode } } }).vcs.git.fetchTagsMode;
    expect(["auto", "sync", "always", "never"].map(mode)).toEqual(["auto", "sync", "always", "never"]);
    expect(mode(undefined)).toBe("auto");
    expect(mode("prune")).toBe("auto");
  });

  it("defaults inline blame off and accepts only boolean values", () => {
    expect(DEFAULT_WORKFLOW.vcs.git.inlineBlame).toBe(false);
    expect(validateWorkflow({ vcs: { git: { inlineBlame: true } } }).vcs.git.inlineBlame).toBe(true);
    expect(validateWorkflow({ vcs: { git: { inlineBlame: "true" } } }).vcs.git.inlineBlame).toBe(false);
  });

  it("keeps the inline blame label clickable unless switched off", () => {
    const clickable = (inlineBlameClickable: unknown) =>
      validateWorkflow({ vcs: { git: { inlineBlameClickable } } }).vcs.git.inlineBlameClickable;
    expect(DEFAULT_WORKFLOW.vcs.git.inlineBlameClickable).toBe(true);
    expect(clickable(false)).toBe(false);
    expect(clickable("no")).toBe(true);
  });

  it("executes branch operations on all repositories unless switched off", () => {
    const sync = (syncBranchOperations: unknown) =>
      validateWorkflow({ vcs: { git: { syncBranchOperations } } }).vcs.git.syncBranchOperations;
    expect(DEFAULT_WORKFLOW.vcs.git.syncBranchOperations).toBe(true);
    expect(sync(false)).toBe(false);
    expect(sync("off")).toBe(true);
  });

  it("records the cherry-pick origin unless explicitly turned off", () => {
    const origin = (addCherryPickOrigin: unknown) =>
      validateWorkflow({ vcs: { git: { addCherryPickOrigin } } }).vcs.git.addCherryPickOrigin;
    expect(origin(undefined)).toBe(true);
    expect(origin(false)).toBe(false);
    expect(origin("false")).toBe(true);
  });

  it("skips empty picks by default and accepts the create-empty choice", () => {
    const action = (emptyCherryPick: unknown) =>
      validateWorkflow({ vcs: { git: { emptyCherryPick } } }).vcs.git.emptyCherryPick;
    expect(action(undefined)).toBe("skip");
    expect(action("createEmpty")).toBe("createEmpty");
    expect(action("other")).toBe("skip");
  });

  it("compares stashed files against the working copy unless the parent is selected", () => {
    const target = (stashDiffTarget: unknown) =>
      validateWorkflow({ vcs: { git: { stashDiffTarget } } }).vcs.git.stashDiffTarget;
    expect(target(undefined)).toBe("local");
    expect(target("parent")).toBe("parent");
    expect(target("other")).toBe("local");
  });

  it("shelves automatically saved changes by default and accepts Stash", () => {
    const policy = (saveChangesPolicy: unknown) =>
      validateWorkflow({ vcs: { git: { saveChangesPolicy } } }).vcs.git.saveChangesPolicy;
    expect(policy(undefined)).toBe("shelve");
    expect(policy("stash")).toBe("stash");
    expect(policy("other")).toBe("shelve");
  });

  it("includes commit changes by default unless explicitly switched off", () => {
    const inclusion = (includeChangesByDefault: unknown) =>
      validateWorkflow({ vcs: { commit: { includeChangesByDefault } } }).vcs.commit.includeChangesByDefault;
    expect(inclusion(undefined)).toBe(true);
    expect(inclusion(true)).toBe(true);
    expect(inclusion(false)).toBe(false);
    expect(inclusion("false")).toBe(true);
  });

  it("keeps the double-click choice unset until it is made", () => {
    expect(DEFAULT_WORKFLOW.vcs.commit.doubleClickOpensDiff).toBeNull();
    expect(validateWorkflow(undefined).vcs.commit.doubleClickOpensDiff).toBeNull();
    const commit = (doubleClickOpensDiff: unknown) =>
      validateWorkflow({ vcs: { commit: { doubleClickOpensDiff } } }).vcs.commit.doubleClickOpensDiff;
    expect(commit(true)).toBe(true);
    expect(commit(false)).toBe(false);
    expect(commit("yes")).toBeNull();
  });

  it("defaults Build tool window open/focus and rejects unknown values", () => {
    expect(DEFAULT_WORKFLOW.build).toEqual({ openToolWindow: "always", focusToolWindow: "never" });
    expect(validateWorkflow({ build: { openToolWindow: "onError", focusToolWindow: "always" } }).build).toEqual({
      openToolWindow: "onError",
      focusToolWindow: "always",
    });
    expect(validateWorkflow({ build: { openToolWindow: "sometimes", focusToolWindow: 1 } }).build).toEqual(
      DEFAULT_WORKFLOW.build,
    );
  });

  it("falls back to defaults for missing or malformed values", () => {
    expect(validateWorkflow(undefined)).toEqual(DEFAULT_WORKFLOW);
    const v = validateWorkflow({
      vcs: {
        historyLimit: -5,
        git: { updateMethod: "squash", incomingCheck: "never", incomingCheckInterval: 0, largeFileMb: 0 },
        confirmation: { onPatchCreated: "always" },
        issueNavigation: [{ pattern: "" }, { pattern: "#(\\d+)", link: "x/$1" }],
      },
      console: {
        bufferKb: 1e12,
        foldPatterns: ["a", 3, ""],
        logColors: { enabled: false, error: "#ff0000", warn: 123 },
      },
      terminal: { cursorShape: "bar", env: { A: "1", B: 2 }, tabName: "  " },
      externalTools: [{ name: "Lint", id: "x" }, { name: "" }, { name: "Again", id: "x" }],
    });
    expect(v.vcs.historyLimit).toBe(10);
    expect(v.vcs.git.updateMethod).toBe("merge");
    expect(v.vcs.git.incomingCheck).toBe("never");
    expect(v.vcs.git.incomingCheckInterval).toBe(1);
    expect(v.vcs.git.largeFileMb).toBe(1);
    expect(v.vcs.issueNavigation).toEqual([{ pattern: "#(\\d+)", link: "x/$1" }]);
    expect(v.vcs.commit.nonModal).toBe(true);
    expect(v.vcs.confirmation.onPatchCreated).toBe("ask");
    expect(v.vcs.shelf.removeApplied).toBe(false);
    expect(v.console.bufferKb).toBe(1_048_576);
    expect(v.console.foldPatterns).toEqual(["a"]);
    expect(v.console.logColors).toEqual({
      enabled: false,
      error: "#ff0000",
      warn: "var(--ansi-yellow)",
      info: "var(--ansi-green)",
      debug: "var(--ansi-cyan)",
      trace: "var(--ansi-magenta)",
    });
    expect(v.terminal).toMatchObject({ cursorShape: "bar", env: { A: "1" }, tabName: "Local" });
    expect(v.externalTools.map((t) => [t.id, t.name])).toEqual([
      ["x", "Lint"],
      ["x_", "Again"],
    ]);
  });
});

describe("splitCommandLine", () => {
  it("honours quotes and escapes", () => {
    expect(splitCommandLine(`/bin/zsh --login`)).toEqual(["/bin/zsh", "--login"]);
    expect(splitCommandLine(`sh -c "echo 'a b'" x\\ y ''`)).toEqual(["sh", "-c", "echo 'a b'", "x y", ""]);
    expect(splitCommandLine("  ")).toEqual([]);
  });
});
