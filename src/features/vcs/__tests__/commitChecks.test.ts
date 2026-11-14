import { afterEach, describe, expect, it, vi } from "vitest";
import { badFileName, runCommitChecks } from "../commitChecks";
import { getCommitChecks, registerCommitCheck, type CommitCheck } from "../commitCheckRegistry";

const disposers: Array<() => void> = [];

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
    await runCommitChecks([], false);
    expect(seen).toEqual(["vcs.early", "vcs.a", "vcs.b", "vcs.z"]);
  });

  it("blocks the commit on an error", async () => {
    register("vcs.error", 1, () => ({ severity: "error", text: "Fix this first" }));
    const run = await runCommitChecks([{ path: "/p/a.ts", exists: true }], false);
    expect(run.blocked).toBe(true);
    expect(run.problems).toMatchObject([{ title: "vcs.error", text: "Fix this first" }]);
  });

  it("does not block the commit on a warning", async () => {
    register("vcs.warning", 1, () => ({ severity: "warning", text: "Worth a look" }));
    const run = await runCommitChecks([{ path: "/p/a.ts", exists: true }], false);
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
    const run = await runCommitChecks([], false);
    expect(run.problems[0]!.details).toMatchObject({ label: "Review" });
    run.problems[0]!.details!.run();
    expect(fix).toHaveBeenCalledOnce();
  });

  it("reports a check that throws as an error instead of breaking the commit", async () => {
    register("vcs.broken", 1, () => {
      throw new Error("boom");
    });
    const run = await runCommitChecks([], false);
    expect(run.blocked).toBe(true);
    expect(run.problems).toMatchObject([{ title: "vcs.broken", text: "The check could not run: boom" }]);
  });
});
