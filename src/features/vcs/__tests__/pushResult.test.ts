import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";

let branch: Partial<BranchInfo> = {};

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: async () => ({
        status: "ok",
        data: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null, ...branch },
      }),
      vcsRemote: async () => ({ status: "ok", data: null }),
      cancelRequest: async () => ({ status: "ok", data: null }),
    },
  };
});

import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { provideNotificationService } from "@/workbench/contributions";
import { runRemote } from "../ops";

type Note = { title: string; level: string };
let notes: Note[] = [];

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n as Note), expire: () => {} });
});

afterEach(() => {
  branch = {};
  _resetI18nForTests();
});

const pushTitle = async () => {
  expect(await runRemote({ op: "push" } as never, undefined, ["/p"])).toBe(true);
  return notes.at(-1)!.title;
};

describe("push result notification", () => {
  it("says how many commits went to which upstream", async () => {
    branch = { upstream: "origin/main", ahead: 3 };
    expect(await pushTitle()).toBe("Pushed 3 commits to origin/main");
    branch = { upstream: "origin/main", ahead: 1 };
    expect(await pushTitle()).toBe("Pushed 1 commit to origin/main");
  });

  it("stays generic when nothing was ahead", async () => {
    branch = { upstream: "origin/main", ahead: 0 };
    expect(await pushTitle()).toMatch(/successful$/);
  });

  it("is translated as a whole, count included", async () => {
    await setLocale("zh");
    branch = { upstream: "origin/main", ahead: 3 };
    expect(await pushTitle()).toBe("已推送 3 个提交到 origin/main");
  });
});
