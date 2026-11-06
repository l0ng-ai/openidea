import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteOp } from "@/bindings";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  ops: [] as Array<{ repo: string | null; op: RemoteOp }>,
  /** Results of the coming pushes, in order: an error message, or null for success. */
  pushes: [] as Array<string | null>,
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
        ok({ head: "main", headCommit: "c1", upstream: "origin/main", ahead: 1, behind: 0, operation: null }),
      vcsRemote: (repo: string | null, _request: number, op: RemoteOp) => {
        mocks.ops.push({ repo, op });
        const error = op.op === "push" ? (mocks.pushes.shift() ?? null) : null;
        return error ? Promise.resolve({ status: "error", error: { kind: "failed", message: error } }) : ok(null);
      },
      vcsLog: () => ok([]),
      vcsStatus: () => ok([]),
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
import { pushWithAutoUpdate } from "../remoteUi";
import { useVcs } from "../store";

const REJECTED = " ! [rejected]        main -> main (fetch first)";
const STALE = " ! [rejected]        main -> main (stale info)";
const push = { op: "push", force_with_lease: false, set_upstream: false, tags: null } as const;
const kinds = () => mocks.ops.map((o) => (o.op.op === "pull" ? `pull:${o.op.rebase ? "rebase" : "merge"}` : o.op.op));
type Note = { title: string; actions?: Array<{ label: string }> };
let notes: Note[] = [];

beforeEach(() => {
  mocks.ask.mockReset();
  mocks.ops = [];
  mocks.pushes = [];
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
