import { beforeEach, expect, it, vi } from "vitest";
import type { Branch, BranchInfo } from "@/bindings";
const mocks = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  promptText: mocks.prompt,
}));
import { newBranch, newBranchInRepos } from "../branchOps";
import { useVcs } from "../store";

const branch = (head: string | null): BranchInfo => ({
  head,
  headCommit: "abc1234567890",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
});

const local = (name: string, current = false): Branch => ({
  name,
  remote: false,
  current,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The current branch is always among the local branches, so the suggestion names an existing one.
  useVcs.setState({
    root: "/p",
    repo: "/p/front",
    branch: branch("feature/ui"),
    branches: [local("feature/ui", true), local("main")],
  });
  // Cancel: only what the dialog was offered matters here, not its outcome.
  mocks.prompt.mockResolvedValue(null);
});

it("prefills a plain New Branch with the current branch name", async () => {
  await newBranch();
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("feature/ui");
  expect(mocks.prompt.mock.calls[0]?.[0].validateInitial).toBe(true);
});

it("prefills nothing when HEAD is detached", async () => {
  useVcs.setState({ branch: branch(null) });
  await newBranch();
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("");
});

it("still suggests a remote branch's name without the prefix", async () => {
  await newBranch("origin/main");
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("main");
});

it("prefills the current branch in the multi-repository dialog too", async () => {
  await newBranchInRepos(["/p/front", "/p/back"]);
  expect(mocks.prompt.mock.calls[0]?.[0].initial).toBe("feature/ui");
});
