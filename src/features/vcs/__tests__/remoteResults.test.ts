import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";

let branch: Partial<BranchInfo> = {};
/** What a pull brings in: the head moves to `c2`, with these changed files and commits. */
let pulled = { files: 0, commits: 0 };

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
      vcsRemote: async () => {
        if (pulled.commits) branch = { ...branch, headCommit: "c2" };
        return { status: "ok", data: null };
      },
      vcsDiffRevisions: async () => ({ status: "ok", data: Array.from({ length: pulled.files }, (_, i) => ({ i })) }),
      vcsLog: async () => ({ status: "ok", data: Array.from({ length: pulled.commits }, (_, i) => ({ i })) }),
      cancelRequest: async () => ({ status: "ok", data: null }),
    },
  };
});

import { _resetI18nForTests, setLocale, txTemplate } from "@/platform/i18n";
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
  pulled = { files: 0, commits: 0 };
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

const updateTitle = async () => {
  expect(await runRemote({ op: "pull" } as never, undefined, ["/p"])).toBe(true);
  return notes.at(-1)!.title;
};

describe("Update Project result notification", () => {
  it("counts the files and commits that came in", async () => {
    pulled = { files: 3, commits: 2 };
    expect(await updateTitle()).toBe("3 files updated in 2 commits");
    branch = {};
    pulled = { files: 1, commits: 1 };
    expect(await updateTitle()).toBe("1 file updated in 1 commit");
  });

  it("translates the counts inside the sentence", async () => {
    await setLocale("zh");
    pulled = { files: 3, commits: 2 };
    // Notification titles are translated as they are shown.
    expect(txTemplate(await updateTitle())).toBe("已在 2 个提交中更新 3 个文件");
  });
});
