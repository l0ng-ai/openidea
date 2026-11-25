import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdeError, PushDivergence, RemoteOp } from "@/bindings";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  ops: [] as Array<{ repo: string | null; op: RemoteOp }>,
  /** Results of the coming pushes, in order: an error message, or null for success. */
  pushes: [] as Array<string | IdeError | null>,
  pullError: null as string | null,
  upstream: "origin/release",
  settings: [] as Array<[string, string]>,
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: () =>
        ok({ head: "main", headCommit: "c1", upstream: mocks.upstream, ahead: 1, behind: 0, operation: null }),
      vcsRemote: (repo: string | null, _request: number, op: RemoteOp) => {
        mocks.ops.push({ repo, op });
        const error = op.op === "pull" ? mocks.pullError : (mocks.pushes.shift() ?? null);
        return error
          ? Promise.resolve({
              status: "error",
              error: typeof error === "string" ? { kind: "internal", message: error } : error,
            })
          : ok(null);
      },
      vcsLog: () => ok([]),
      vcsStatus: () => ok([]),
      vcsFinishShelfBatch: () => ok(null),
      settingsSet: (_scope: string, key: string, value: string) => {
        mocks.settings.push([key, value]);
        return ok({});
      },
      cancelRequest: () => ok(null),
    },
  };
});
vi.mock("@/workbench/messages", () => ({ ask: mocks.ask, showError: vi.fn() }));

import { provideNotificationService } from "@/workbench/contributions";
import { pushTargets } from "../remoteUi";
import { useVcs } from "../store";

const REJECTED = " ! [rejected]        main -> main (fetch first)";
const STALE = " ! [rejected]        main -> main (stale info)";
const push = { op: "push", force_with_lease: false, set_upstream: false, tags: null } as const;
const pushWithAutoUpdate = (op: Extract<RemoteOp, { op: "push" }>, detail: string, repo: string) =>
  pushTargets([{ op, detail, repo }]);
const divergence: PushDivergence = {
  source: "main",
  remote: "origin",
  target: "release",
  localTip: "c1",
  remoteTip: "c2",
  remoteCommits: 2,
};
const knownRejection = (value = divergence): IdeError => ({
  kind: "internal",
  message: "!\trefs/heads/main:refs/heads/release\t[rejected] (non-fast-forward)",
  data: { type: "pushRejected", source: value.source, upstream: `${value.remote}/${value.target}`, divergence: value },
});
const selected = {
  op: "pushSelected",
  selection: { branch: "main", revision: "c1", remote: "mirror", target: "review" },
  force_with_lease: false,
  set_upstream: false,
  tags: null,
  no_verify: false,
} as const;
const kinds = () => mocks.ops.map((o) => (o.op.op === "pull" ? `pull:${o.op.rebase ? "rebase" : "merge"}` : o.op.op));
type Note = { title: string; body?: string; actions?: Array<{ label: string }> };
let notes: Note[] = [];

beforeEach(() => {
  mocks.ask.mockReset();
  mocks.ops = [];
  mocks.pushes = [];
  mocks.pullError = null;
  mocks.upstream = "origin/release";
  mocks.settings = [];
  notes = [];
  useVcs.setState({ roots: ["/a", "/b"], remoteBusy: null });
  provideNotificationService({ notify: (n) => void notes.push(n as Note), expire: () => {} });
});

describe("a push rejected because the remote has new commits", () => {
  it("asks how to update, updates every repository and pushes again", async () => {
    mocks.pushes = [REJECTED];
    mocks.ask.mockResolvedValue({ button: "rebase", checked: false });
    expect(await pushWithAutoUpdate(push, "main → origin/main", "/a")).toBe(true);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.ask.mock.calls[0]![0].title).toBe("Push Rejected");
    expect(kinds()).toEqual(["push", "pull:rebase", "pull:rebase", "push"]);
    expect(mocks.ops.filter((o) => o.op.op === "pull").map((o) => o.repo)).toEqual(["/a", "/b"]);
    // The chosen method becomes the update method; silent updates stay off.
    expect(mocks.settings).toEqual([["vcs.git.updateMethod", '"rebase"']]);
  });

  it("keeps the chosen method while the push keeps being rejected, without asking again", async () => {
    mocks.pushes = [REJECTED, REJECTED];
    mocks.ask.mockResolvedValue({ button: "merge", checked: true });
    expect(await pushWithAutoUpdate(push, "", "/a")).toBe(true);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(kinds()).toEqual(["push", "pull:merge", "pull:merge", "push", "pull:merge", "pull:merge", "push"]);
    expect(mocks.settings).toContainEqual(["vcs.git.autoUpdateOnPushRejected", "true"]);
  });

  it("gives up after ten attempts", async () => {
    mocks.pushes = Array.from({ length: 20 }, () => REJECTED);
    mocks.ask.mockResolvedValue({ button: "merge", checked: false });
    expect(await pushWithAutoUpdate(push, "", "/a")).toBe(false);
    expect(kinds().filter((k) => k === "push")).toHaveLength(10);
  });

  it("doesn't update on Cancel", async () => {
    mocks.pushes = [REJECTED];
    mocks.ask.mockResolvedValue({ button: "cancel", checked: false });
    expect(await pushWithAutoUpdate(push, "", "/a")).toBe(false);
    expect(kinds()).toEqual(["push"]);
    // The dialog, not an error balloon, reported the rejection; cancelling it leaves "Push rejected".
    expect(notes.map((n) => n.title).filter((t) => /fail|reject/i.test(t))).toEqual(["Push rejected"]);
  });
});

describe("a rejected push with a known divergence", () => {
  it("retries the tracked branch and retains the tags Git already published", async () => {
    const op = {
      ...selected,
      selection: { branch: "main", revision: null, remote: "origin", target: "release" },
      tags: "all",
    } as const;
    mocks.pushes = [
      {
        ...knownRejection(),
        data: {
          type: "pushRejected",
          source: "main",
          upstream: "origin/release",
          divergence,
          report: {
            remote: "origin",
            refs: [{ reference: "refs/tags/v1", status: "created", commits: null }],
          },
        },
      },
    ];
    mocks.ask.mockResolvedValue({ button: "merge", checked: false });
    expect(await pushTargets([{ repo: "/a", op }])).toBe(true);
    expect(kinds()).toEqual(["pushSelected", "pull:merge", "pull:merge", "pushSelected"]);
    expect(mocks.ops.at(-1)?.op).toEqual(op);
    expect(notes.at(-1)).toMatchObject({
      title: "Pushed tag v1 to origin",
      body: "Pushed 1 commit to origin/release",
    });
  });

  it("describes the remote commits and passes the reviewed lease to the same repository", async () => {
    mocks.pushes = [knownRejection()];
    mocks.ask.mockResolvedValue({ button: "force", checked: true });
    expect(await pushWithAutoUpdate({ ...push, tags: "all", no_verify: true }, "", "/a")).toBe(true);
    const dialog = mocks.ask.mock.calls[0]![0];
    expect(dialog.body).toContain('"origin/release" has 2 commits');
    expect(dialog.buttons).toContainEqual({ id: "force", label: "Force Push" });
    expect(mocks.ops.at(-1)).toEqual({
      repo: "/a",
      op: { op: "forcePushRejected", divergence, tags: "all", no_verify: true },
    });
    expect(kinds()).toEqual(["push", "forcePushRejected"]);
    expect(mocks.settings).toEqual([]);
  });

  it("explains why a protected target cannot be force-pushed", async () => {
    mocks.upstream = "origin/main";
    mocks.pushes = [knownRejection({ ...divergence, target: "main", remoteCommits: 1 })];
    mocks.ask.mockResolvedValue({ button: "cancel", checked: false });
    expect(await pushWithAutoUpdate(push, "", "/a")).toBe(false);
    const dialog = mocks.ask.mock.calls[0]![0];
    expect(dialog.body).toContain('Force pushing to "origin/main" is prohibited.');
    expect(dialog.buttons.map((button: { id: string }) => button.id)).toEqual(["merge", "rebase", "cancel"]);
  });

  it("asks the user to fetch after the reviewed lease expires", async () => {
    mocks.pushes = [knownRejection(), STALE];
    mocks.ask.mockResolvedValue({ button: "force", checked: false });
    expect(await pushWithAutoUpdate(push, "", "/a")).toBe(false);
    expect(kinds()).toEqual(["push", "forcePushRejected"]);
    expect(notes.at(-1)).toMatchObject({
      title: "Push rejected",
      body: '"origin/release" changed. Fetch and review its latest commits before pushing again.',
    });
    expect(notes.at(-1)?.actions).toMatchObject([{ label: "Fetch and Review…" }]);
  });

  it("updates both rejected repositories as a group and retries them together", async () => {
    mocks.pushes = [knownRejection(), knownRejection()];
    mocks.ask.mockImplementation(() => {
      expect(kinds()).toEqual(["push", "push"]);
      return Promise.resolve({ button: "merge", checked: false });
    });
    expect(
      await pushTargets([
        { repo: "/a", op: push },
        { repo: "/b", op: push },
      ]),
    ).toBe(true);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    const dialog = mocks.ask.mock.calls[0]![0];
    expect(dialog.body).toContain('Push of the current branch "main" was rejected in these repositories.\na\nb');
    expect(dialog.buttons.map((button: { id: string }) => button.id)).toEqual(["merge", "rebase", "cancel"]);
    expect(kinds()).toEqual(["push", "push", "pull:merge", "pull:merge", "push", "push"]);
  });

  it("offers the reviewed lease for the sole rejection in a multi-repository push", async () => {
    mocks.pushes = [null, knownRejection()];
    mocks.ask.mockResolvedValue({ button: "force", checked: false });
    expect(
      await pushTargets([
        { repo: "/a", op: push },
        { repo: "/b", op: push },
      ]),
    ).toBe(true);
    expect(mocks.ask.mock.calls[0]![0].body).toContain('in repository "b"');
    expect(kinds()).toEqual(["push", "push", "forcePushRejected"]);
    expect(mocks.ops.at(-1)?.repo).toBe("/b");
  });
});

it("offers to review the same explicit destination after its lease expires", async () => {
  mocks.pushes = ["!\tc1:refs/heads/review\t[rejected] (stale info)"];
  expect(await pushTargets([{ repo: "/a", op: { ...selected, force_with_lease: true } }])).toBe(false);
  expect(kinds()).toEqual(["pushSelected"]);
  expect(mocks.ask).not.toHaveBeenCalled();
  expect(notes.at(-1)).toMatchObject({
    title: "Push rejected",
    body: '"mirror/review" changed. Fetch and review its latest commits before pushing again.',
    actions: [{ label: "Fetch and Review…" }],
  });
});

it.each([
  "!\tc1:refs/heads/another\t[rejected] (fetch first)",
  "!\tc1:refs/heads/review\t[remote rejected] (pre-receive hook declined)",
])("offers no recovery for a different ref or a server-side rejection", async (report) => {
  mocks.pushes = [report];
  expect(await pushTargets([{ repo: "/a", op: selected }])).toBe(false);
  expect(kinds()).toEqual(["pushSelected"]);
  expect(mocks.ask).not.toHaveBeenCalled();
  expect(notes.at(-1)?.actions).toBeUndefined();
});

describe("push rounds", () => {
  const targets = [
    { repo: "/a", op: push },
    { repo: "/b", op: push },
    { repo: "/c", op: push },
  ];

  it("tries all selected roots and retries only rejections after updating the project once", async () => {
    mocks.pushes = [REJECTED, null, REJECTED];
    mocks.ask.mockImplementation(() => {
      expect(mocks.ops.map(({ repo }) => repo)).toEqual(["/a", "/b", "/c"]);
      return Promise.resolve({ button: "merge", checked: false });
    });
    expect(await pushTargets(targets)).toBe(true);
    expect(mocks.ops.map(({ repo }) => repo)).toEqual(["/a", "/b", "/c", "/a", "/b", "/a", "/c"]);
    expect(kinds()).toEqual(["push", "push", "push", "pull:merge", "pull:merge", "push", "push"]);
  });

  it("reports partial failure and skips recovery if any repository has a different error", async () => {
    mocks.pushes = [REJECTED, "Permission denied", null];
    expect(await pushTargets(targets)).toBe(false);
    expect(kinds()).toEqual(["push", "push", "push"]);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({ title: "Push partially failed", body: expect.stringContaining("a, b") });
  });

  it("does not update after a non-fast-forward rejection on a different destination", async () => {
    mocks.pushes = ["!\trefs/heads/main:refs/heads/other\t[rejected] (non-fast-forward)", null];
    expect(await pushTargets(targets.slice(0, 2))).toBe(false);
    expect(kinds()).toEqual(["push", "push"]);
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("stops the push after an incomplete project update", async () => {
    mocks.pushes = [REJECTED, REJECTED, null];
    mocks.pullError = "Automatic merge failed";
    mocks.ask.mockResolvedValue({ button: "merge", checked: false });
    expect(await pushTargets(targets)).toBe(false);
    expect(kinds()).toEqual(["push", "push", "push", "pull:merge", "pull:merge"]);
  });
});

describe("a rejected forced push", () => {
  it("is not followed by an update; a stale lease offers to force push anyway", async () => {
    mocks.pushes = [STALE];
    expect(await pushWithAutoUpdate({ ...push, force_with_lease: true }, "", "/a")).toBe(false);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(kinds()).toEqual(["push"]);
    const offer = notes.at(-1)!;
    expect(offer.actions?.map((a) => a.label)).toEqual(["Force push anyway"]);
  });

  it("with a lease rejected for another reason only reports it", async () => {
    mocks.pushes = [REJECTED];
    expect(await pushWithAutoUpdate({ ...push, force_with_lease: true }, "", "/a")).toBe(false);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(kinds()).toEqual(["push"]);
  });
});
