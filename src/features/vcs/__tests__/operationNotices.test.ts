import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";
import { installOperationNoticeExpiry, rebaseFeedback } from "../operations";
import { useVcs } from "../store";

const { notify, expire } = vi.hoisted(() => ({ notify: vi.fn(), expire: vi.fn() }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify, expire }),
}));

const branch = (operation: string | null) => ({ head: "main", operation }) as unknown as BranchInfo;
let dispose: () => void;

let resolvedRepo: string | null;
beforeEach(() => {
  expire.mockClear();
  notify.mockClear();
  resolvedRepo = null;
  useVcs.setState({ branch: branch("merge"), operations: {} });
  dispose = installOperationNoticeExpiry(() => resolvedRepo);
});
afterEach(() => {
  useVcs.setState(useVcs.getInitialState(), true);
  dispose();
});

it("expires the conflict notice once the merge it offers to commit or abort is over", () => {
  useVcs.setState({ branch: branch("merge") });
  expect(expire).not.toHaveBeenCalled();
  useVcs.setState({ branch: branch(null) });
  expect(expire).toHaveBeenCalledWith("vcs.conflicts");
});

it("keeps it while an operation is still in progress", () => {
  useVcs.setState({ branch: branch("rebase") });
  expect(expire).not.toHaveBeenCalled();
});

it("expires a resolved notice when its own repository finishes", () => {
  resolvedRepo = "/project/worker";
  useVcs.setState({ operations: { "/project": "merge", "/project/worker": "rebase" } });
  useVcs.setState({ branch: branch(null) });
  expect(expire).not.toHaveBeenCalled();
  useVcs.setState({ operations: { "/project": "merge" } });
  expect(expire).toHaveBeenCalledWith("vcs.conflicts");
});

it("publishes actionable pause feedback for the affected repository and expires it when that rebase ends", () => {
  const root = "/project";
  const worker = "/project/worker";
  useVcs.setState({ root, roots: [root, worker], repo: root, operations: { [worker]: "rebase" } });
  const options = { progress: "Rebasing", success: "Rebase finished", failure: "Rebase failed" };
  expect(rebaseFeedback(root, options).reportPause?.(true)).toBe(false);
  expect(notify).not.toHaveBeenCalled();

  expect(rebaseFeedback(worker, options).reportPause?.(false)).toBe(true);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "vcs.rebasePaused:/project/worker",
      title: "Rebase stopped for editing",
      body: "worker",
      sticky: true,
      actions: [expect.objectContaining({ label: "Continue" }), expect.objectContaining({ label: "Abort" })],
    }),
  );
  useVcs.setState({ operations: {} });
  expect(expire).toHaveBeenCalledWith("vcs.rebasePaused:/project/worker");
});
