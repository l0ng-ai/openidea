import { describe, expect, it } from "vitest";
import { isCurrentWorktree } from "./worktrees";

describe("isCurrentWorktree", () => {
  it("matches the repository root this window works in", () => {
    expect(isCurrentWorktree("/work/app", "/work/app")).toBe(true);
    expect(isCurrentWorktree("/work/app-wt", "/work/app")).toBe(false);
    expect(isCurrentWorktree("/work/app/", "/work/app")).toBe(true);
    expect(isCurrentWorktree("/work/app", null)).toBe(false);
  });

  it("ignores the drive letter's case and separators on Windows", () => {
    expect(isCurrentWorktree("c:/Work/app", "C:/Work/app")).toBe(true);
    expect(isCurrentWorktree("C:\\Work\\app", "C:/Work/app")).toBe(true);
    // Only drive paths: elsewhere the case is part of the name.
    expect(isCurrentWorktree("/Work/App", "/work/app")).toBe(false);
  });
});
