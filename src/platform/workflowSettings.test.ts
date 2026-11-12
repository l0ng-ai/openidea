import { describe, expect, it } from "vitest";
import { splitCommandLine } from "./commandLine";
import { DEFAULT_WORKFLOW, validateWorkflow } from "./workflowSettings";

describe("validateWorkflow", () => {
  it("defaults inline blame off and accepts only boolean values", () => {
    expect(DEFAULT_WORKFLOW.vcs.git.inlineBlame).toBe(false);
    expect(validateWorkflow({ vcs: { git: { inlineBlame: true } } }).vcs.git.inlineBlame).toBe(true);
    expect(validateWorkflow({ vcs: { git: { inlineBlame: "true" } } }).vcs.git.inlineBlame).toBe(false);
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

  it("falls back to defaults for missing or malformed values", () => {
    expect(validateWorkflow(undefined)).toEqual(DEFAULT_WORKFLOW);
    const v = validateWorkflow({
      vcs: {
        historyLimit: -5,
        git: { updateMethod: "squash", incomingCheck: "never", largeFileMb: 0 },
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
