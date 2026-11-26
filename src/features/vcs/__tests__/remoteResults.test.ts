import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo, FetchReport, PushReport, RemoteOp } from "@/bindings";

let branch: Partial<BranchInfo> = {};
/** What a pull brings in: the head moves to `c2`, with these changed files and commits. */
let pulled = { files: 0, commits: 0 };
let failure: { kind: string; message: string } | null = null;
let failuresByRepo: Record<string, string> = {};
let reports: Record<string, PushReport | FetchReport> = {};
let partialReport: PushReport | null = null;
let remoteGate: Promise<void> | null = null;
let remoteRepos: Array<string | null> = [];

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
      vcsRemote: async (repo: string | null) => {
        remoteRepos.push(repo);
        await remoteGate;
        const message = failuresByRepo[repo ?? ""];
        if (message) return { status: "error", error: { kind: "invalid", message } };
        if (partialReport) {
          return {
            status: "error",
            error: {
              kind: "internal",
              message: "Tag already exists on the remote",
              data: { type: "pushPartiallyApplied", report: partialReport },
            },
          };
        }
        if (failure) return { status: "error", error: failure };
        if (pulled.commits) branch = { ...branch, headCommit: "c2" };
        return { status: "ok", data: reports[repo ?? ""] ?? null };
      },
      vcsOperation: async () => (failure ? { status: "error", error: failure } : { status: "ok", data: null }),
      vcsDiffRevisions: async () => ({ status: "ok", data: Array.from({ length: pulled.files }, (_, i) => ({ i })) }),
      vcsLog: async () => ({ status: "ok", data: Array.from({ length: pulled.commits }, (_, i) => ({ i })) }),
      vcsFinishShelfBatch: async () => ({ status: "ok", data: null }),
      cancelRequest: async () => ({ status: "ok", data: null }),
    },
  };
});

import { _resetI18nForTests, setLocale, txTemplate } from "@/platform/i18n";
import { registerActions } from "@/platform/actions";
import { provideNotificationService } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { expireNotification, notify, useNotifications } from "@/workbench/notificationStore";
import {
  cancelRemote,
  runGitOperation,
  runOp,
  runRemote,
  runRemoteRound,
  useVcsConsole,
  type RemoteTarget,
} from "../ops";
import { pushTargets } from "../remoteUi";
import { useVcs } from "../store";

type Note = { title: string; level: string; body?: string };
let notes: Note[] = [];

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n as Note), expire: () => {} });
});

afterEach(() => {
  branch = {};
  pulled = { files: 0, commits: 0 };
  failure = null;
  failuresByRepo = {};
  reports = {};
  partialReport = null;
  remoteGate = null;
  remoteRepos = [];
  useVcs.setState({ remoteBusy: null, roots: [], root: null, status: [] });
  useNotifications.setState({ items: [] });
  useProject.setState({ settings: null });
  _resetI18nForTests();
});

const pushTitle = async () => {
  expect(await runRemote({ op: "push" } as never, undefined, ["/p"])).toBe(true);
  return notes.at(-1)!.title;
};

describe("fetch result notification", () => {
  it("keeps successful remotes and pruned refs visible when other remotes fail", async () => {
    const showConsole = vi.fn();
    const unregister = registerActions([{ id: "vcs.showConsole", title: "Show Git Console", run: showConsole }]);
    const received: Array<{ label: string; run: () => void }> = [];
    provideNotificationService({
      notify: (n) => {
        notes.push(n as Note);
        received.push(...(n.actions ?? []));
      },
      expire: () => {},
    });
    reports = {
      "/p/client": {
        remotes: [
          { remote: "origin", pruned: ["origin/gone"], error: null },
          { remote: "upstream/mirror", pruned: [], error: { kind: "notFound", message: "Remote unavailable" } },
        ],
      },
      "/p/server": { remotes: [{ remote: "release", pruned: ["old-tag"], error: null }] },
    };
    try {
      expect(await runRemote({ op: "fetch" }, undefined, ["/p/client", "/p/server"])).toBe(false);
      expect(notes.at(-1)).toMatchObject({
        title: "Fetch partially failed",
        body: [
          "Fetched from client / origin",
          "Fetched from server / release",
          "client: upstream/mirror: Remote unavailable",
          "Pruned from client / origin: origin/gone",
          "Pruned from server / release: old-tag",
        ].join("\n"),
      });
      received.find(({ label }) => label === "Show Git Console")?.run();
      expect(showConsole).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("reports pruned refs on a successful single-remote refresh", async () => {
    reports["/p"] = { remotes: [{ remote: "origin", pruned: ["origin/removed", "release/v1"], error: null }] };
    expect(await runRemote({ op: "fetchRemote", remote: "origin" }, "origin", ["/p"])).toBe(true);
    expect(notes.at(-1)).toMatchObject({
      title: "Fetch successful",
      body: "Pruned from origin: origin/removed, release/v1",
    });
  });
});

describe("push result notification", () => {
  const selected = {
    op: "pushSelected" as const,
    selection: { branch: "main", revision: null, remote: "fork", target: "review" },
    force_with_lease: false,
    set_upstream: false,
    tags: null,
    no_verify: false,
  };

  it("describes what Git published to a custom ref, including tags", async () => {
    branch = { upstream: "origin/main", ahead: 99 };
    reports["/p"] = {
      remote: "fork",
      refs: [
        { reference: "refs/heads/review", status: "fastForward", commits: 2 },
        { reference: "refs/tags/v1", status: "created", commits: null },
        { reference: "refs/tags/old", status: "upToDate", commits: null },
      ],
    };
    expect(await pushTargets([{ repo: "/p", op: selected }])).toBe(true);
    expect(notes.at(-1)).toMatchObject({
      title: "Pushed 2 commits to fork/review",
      body: "Pushed tag v1 to fork",
    });
  });

  it("keeps successful repositories visible when another push fails", async () => {
    reports["/p/a"] = {
      remote: "fork",
      refs: [{ reference: "refs/heads/review", status: "created", commits: null }],
    };
    failuresByRepo["/p/b"] = "remote refused the push";
    expect(
      await pushTargets([
        { repo: "/p/a", op: selected },
        { repo: "/p/b", op: selected },
      ]),
    ).toBe(false);
    expect(notes.at(-1)).toMatchObject({
      title: "Push partially failed",
      body: "a: Pushed to new branch fork/review\nNot pushed: b. See the Git console for details.",
    });
  });

  it("reports the branch update if a later tag push in the same repository fails", async () => {
    partialReport = {
      remote: "fork",
      refs: [{ reference: "refs/heads/review", status: "fastForward", commits: 1 }],
    };
    expect(await pushTargets([{ repo: "/p", op: selected }])).toBe(false);
    expect(notes.at(-1)).toMatchObject({
      title: "Push partially failed",
      body: "Pushed 1 commit to fork/review\nGit reported an error after publishing these changes.",
      actions: [expect.objectContaining({ label: "Show Git Console" })],
    });
    expect(useVcsConsole.getState().lines.at(-1)?.text).toContain("Tag already exists on the remote");
  });

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

  it("skips the descendants of a failed repository and updates other roots", async () => {
    branch = { upstream: "origin/main" };
    const root = "/p";
    const child = "/p/modules/lib";
    const nested = "/p/modules/lib/vendor/dep";
    const other = "/p/independent";
    const op = { op: "updateProjectBranch", rebase: false } as const;
    const targets: RemoteTarget<RemoteOp>[] = [
      { repo: root, op },
      { repo: child, parent: root, op: { op: "updateSubmodule", parent: root } },
      { repo: nested, parent: child, op: { op: "updateSubmodule", parent: child } },
      { repo: other, op },
    ];
    failuresByRepo = { [root]: "Remote unavailable" };
    const failures = await runRemoteRound(targets);
    expect(failures?.map(({ target }) => target.repo)).toEqual([root]);
    expect(remoteRepos).toEqual([root, other]);
    expect(notes.at(-1)).toMatchObject({ title: "Update failed", body: "p: Remote unavailable" });
  });

  it("opens conflicts for the failed repository and reports other pull errors separately", async () => {
    const roots = ["/p/client", "/p/server", "/p/tools"];
    useVcs.setState({
      roots,
      root: "/p",
      status: [roots[0]!, roots[2]!].map((repo) => ({
        path: `${repo}/file.txt`,
        relPath: "file.txt",
        staged: null,
        unstaged: "conflicted",
        renamedFrom: null,
      })),
    });
    failuresByRepo = { "/p/client": "Merge conflict", "/p/server": "Remote unavailable" };
    const resolve = vi.fn();
    const unregister = registerActions([{ id: "vcs.resolveConflicts", title: "Resolve Conflicts…", run: resolve }]);
    try {
      const op = { op: "pullFrom", remote: "origin", branches: ["review"], rebase: false, options: {} } as const;
      expect(await runRemote({ ...op, branches: [...op.branches] }, undefined, roots.slice(0, 2))).toBe(false);
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ arg: { repositories: [roots[0]] } }));
      expect(notes.at(-1)).toMatchObject({ title: "Pull failed", body: "server: Remote unavailable" });
    } finally {
      unregister();
    }
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

  it("cancels the remaining roots even if the in-flight command completes", async () => {
    let finish!: () => void;
    remoteGate = new Promise((resolve) => (finish = resolve));
    const running = runRemote({ op: "fetch" }, undefined, ["/a", "/b"]);
    expect(remoteRepos).toEqual(["/a"]);
    cancelRemote();
    finish();
    expect(await running).toBe(false);
    expect(remoteRepos).toEqual(["/a"]);
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
