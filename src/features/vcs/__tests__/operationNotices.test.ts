import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";
import { installOperationNoticeExpiry } from "../operations";
import { useVcs } from "../store";

const { expire } = vi.hoisted(() => ({ expire: vi.fn() }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: vi.fn(), expire }),
}));

const branch = (operation: string | null) => ({ head: "main", operation }) as unknown as BranchInfo;
let dispose: () => void;

beforeEach(() => {
  expire.mockClear();
  useVcs.setState({ branch: branch("merge") });
  dispose = installOperationNoticeExpiry();
});
afterEach(() => dispose());

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
