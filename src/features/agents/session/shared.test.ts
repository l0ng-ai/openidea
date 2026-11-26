import { describe, expect, it } from "vitest";
import type { AgentTask } from "@/bindings";
import { commandTitle } from "./shared";

const task = { cwd: "/repo/app" } as AgentTask;

describe("commandTitle", () => {
  it("drops a cd into the task's own folder", () => {
    expect(commandTitle(task, "cd /repo/app && git grep -n foo")).toEqual({ title: "git grep -n foo", dir: null });
    expect(commandTitle(task, "cd . ; ls")).toEqual({ title: "ls", dir: null });
  });

  it("keeps another folder as the place the command ran", () => {
    expect(commandTitle(task, "cd /repo/app-icons && pnpm test")).toEqual({
      title: "pnpm test",
      dir: "/repo/app-icons",
    });
    expect(commandTitle(task, `cd "/repo/my app/" && ls`)).toEqual({ title: "ls", dir: "/repo/my app" });
  });

  it("leaves commands without a leading cd, or that are only a cd, as they are", () => {
    expect(commandTitle(task, "git status && cd x && ls")).toEqual({ title: "git status && cd x && ls", dir: null });
    expect(commandTitle(task, "cd /tmp")).toEqual({ title: "cd /tmp", dir: null });
    expect(commandTitle(task, "cat /repo/app/src/a.ts")).toEqual({ title: "cat src/a.ts", dir: null });
  });
});
