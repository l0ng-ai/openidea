import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo, RemoteOp } from "@/bindings";

let branch: Partial<BranchInfo> = {};
/** What a pull brings in: the head moves to `c2`, with these changed files and commits. */
let pulled = { files: 0, commits: 0 };
let failure: { kind: string; message: string } | null = null;
let remoteGate: Promise<void> | null = null;

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
        await remoteGate;
        if (failure) return { status: "error", error: failure };
        if (pulled.commits) branch = { ...branch, headCommit: "c2" };
        return { status: "ok", data: null };
      },
      vcsOperation: async () => (failure ? { status: "error", error: failure } : { status: "ok", data: null }),
      vcsDiffRevisions: async () => ({ status: "ok", data: Array.from({ length: pulled.files }, (_, i) => ({ i })) }),
      vcsLog: async () => ({ status: "ok", data: Array.from({ length: pulled.commits }, (_, i) => ({ i })) }),
      cancelRequest: async () => ({ status: "ok", data: null }),
    },
  };
});

import { _resetI18nForTests, setLocale, txTemplate } from "@/platform/i18n";
import { provideNotificationService } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { expireNotification, notify, useNotifications } from "@/workbench/notificationStore";
import { runGitOperation, runOp, runRemote } from "../ops";
import { useVcs } from "../store";

type Note = { title: string; level: string };
let notes: Note[] = [];

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n as Note), expire: () => {} });
});

afterEach(() => {
  branch = {};
  pulled = { files: 0, commits: 0 };
  failure = null;
  remoteGate = null;
  useVcs.setState({ remoteBusy: null });
  useNotifications.setState({ items: [] });
  useProject.setState({ settings: null });
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

  it("does not name the upstream when the push went to another remote", async () => {
    // `ahead` counts against the upstream, so it says nothing about what another remote received.
    branch = { upstream: "origin/main", ahead: 1 };
    const op = { op: "pushBranch", branch: "main", remote: "fork", target: null } as never;
    expect(await runRemote(op, undefined, ["/p"])).toBe(true);
    expect(notes.at(-1)!.title).toMatch(/successful$/);
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

describe.each([
  ["VCS popups disabled", { groups: { vcs: { display: "none", log: true } } }],
  ["all balloons disabled", { balloons: false }],
  ["VCS popups and logging disabled", { groups: { vcs: { display: "none", log: false } } }],
])("Git command feedback with %s", (_name, prefs) => {
  beforeEach(() => {
    useProject.setState({ settings: { notifications: prefs } as never });
    provideNotificationService({ notify, expire: expireNotification });
  });

  it("shows the untracked-file error that prevented Update", async () => {
    failure = {
      kind: "invalid",
      message:
        "The following untracked working tree files would be overwritten by merge: e2e/settingsFormLayout.spec.ts",
    };
    expect(await runRemote({ op: "pull", rebase: false }, undefined, ["/p"])).toBe(false);
    expect(useNotifications.getState().items.find((n) => n.title === "Update failed")).toMatchObject({
      balloon: true,
      body: failure.message,
    });
  });

  it.each<[RemoteOp, string]>([
    [{ op: "fetch" }, "Fetch successful"],
    [{ op: "push", force_with_lease: false, set_upstream: false, tags: null, no_verify: false }, "Push successful"],
    [{ op: "pull", rebase: false }, "All files are up-to-date"],
  ])("shows progress and the result of $op", async (op, title) => {
    let finish!: () => void;
    remoteGate = new Promise((resolve) => (finish = resolve));
    const running = runRemote(op, undefined, ["/p"]);
    try {
      expect(useNotifications.getState().items.find((n) => n.key === "vcs.remote")).toMatchObject({
        balloon: true,
        sticky: true,
      });
    } finally {
      finish();
    }
    expect(await running).toBe(true);
    expect(useNotifications.getState().items.find((n) => n.title === title)?.balloon).toBe(true);
  });

  it("shows the files and commits that Update brought in", async () => {
    pulled = { files: 3, commits: 2 };
    expect(await runRemote({ op: "pull", rebase: false }, undefined, ["/p"])).toBe(true);
    expect(useNotifications.getState().items.find((n) => n.title === "3 files updated in 2 commits")?.balloon).toBe(
      true,
    );
  });

  it("explains why another remote operation cannot start", async () => {
    useVcs.setState({ remoteBusy: "Fetching" });
    expect(await runRemote({ op: "fetch" })).toBe(false);
    expect(useNotifications.getState().items[0]).toMatchObject({
      title: "Another remote operation is in progress",
      balloon: true,
    });
  });

  it("keeps cancelled and caller-handled failures quiet", async () => {
    failure = { kind: "cancelled", message: "cancelled" };
    expect(await runRemote({ op: "fetch" })).toBe(false);
    expect(useNotifications.getState().items.some((n) => n.balloon)).toBe(false);
    failure = { kind: "invalid", message: "rejected" };
    expect(await runRemote({ op: "fetch" }, undefined, ["/p"], () => true)).toBe(false);
    expect(useNotifications.getState().items.some((n) => n.balloon)).toBe(false);
  });

  it("shows local command failures but respects quiet callers", async () => {
    const fail = () => Promise.reject(new Error("index locked"));
    await runOp("Commit", fail);
    expect(useNotifications.getState().items[0]).toMatchObject({ title: "Commit failed", balloon: true });
    useNotifications.setState({ items: [] });
    await runOp("Commit", fail, { quiet: true });
    expect(useNotifications.getState().items).toEqual([]);
  });

  it("shows long local operation results", async () => {
    const op = { op: "cherryPick", commits: ["c1"] } as const;
    const options = { progress: "Cherry-picking", success: "Cherry-picked c1", failure: "Cherry-pick failed" };
    expect(await runGitOperation({ ...op, commits: [...op.commits] }, options)).toBe(true);
    expect(useNotifications.getState().items[0]).toMatchObject({ title: options.success, balloon: true });
    failure = { kind: "invalid", message: "invalid revision" };
    expect(await runGitOperation({ ...op, commits: [...op.commits] }, options)).toBe(false);
    expect(useNotifications.getState().items[0]).toMatchObject({ title: options.failure, balloon: true });
  });

  it("still suppresses unsolicited VCS notifications", () => {
    notify({ group: "vcs", level: "info", title: "Background refresh" });
    expect(useNotifications.getState().items.some((n) => n.balloon)).toBe(false);
  });
});
