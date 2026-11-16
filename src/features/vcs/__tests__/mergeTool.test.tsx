import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MergeOptions } from "@/bindings";

const mocks = vi.hoisted(() => ({
  merges: [] as Array<{ repo: string | null; branches: string[]; options: MergeOptions }>,
  remotes: [] as string[],
  opened: [] as string[],
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const head = (repo: string | null) => (repo === "/p/b" ? "dev" : "main");
  const local = (repo: string | null) =>
    repo === "/p/b" ? ["dev", "feature-b", "shared"] : ["main", "feature-a", "shared"];
  const branch = (name: string, remote = false) => ({
    name,
    remote,
    current: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    lastCommitMs: null,
  });
  const commits = (range: string) =>
    range.startsWith("main..feature-a")
      ? [
          { id: "a2", shortId: "a2", summary: "Add merge target picker", message: "", author: "mars1014", time: 0 },
          { id: "a1", shortId: "a1", summary: "Sketch merge window", message: "", author: "mars1014", time: 0 },
        ]
      : [];
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: (repo: string | null) =>
        ok({ head: head(repo), headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null }),
      vcsBranches: (repo: string | null) =>
        ok([...local(repo).map((n) => branch(n)), branch("origin/dev", true), branch("origin/main", true)]),
      vcsMergeWith: (repo: string | null, branches: string[], options: MergeOptions) => {
        mocks.merges.push({ repo, branches, options });
        return ok(null);
      },
      vcsRemote: (_repo: string | null, _request: unknown, op: { op: string }) => {
        mocks.remotes.push(op.op);
        return ok(null);
      },
      vcsMergeBase: () => ok("base1"),
      vcsLog: (_repo: string | null, query: { range?: string | null }) => ok(commits(query.range ?? "")),
      vcsDiffRevisions: (_repo: string | null, from: string) =>
        ok(from === "base1" ? [{ path: "src/vcs/merge.ts", kind: "modified", oldPath: null }] : []),
      vcsConfigGet: () => ok("git@github.com:me/repo.git"),
      vcsCheckout: () => ok(null),
      vcsCreateBranch: () => ok(null),
    },
  };
});

vi.mock("../issueLinks", () => ({ openUrl: (url: string) => mocks.opened.push(url) }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((line: string) => void) | null = null;
  },
}));

import { MergePane } from "../mergeTool";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.merges = [];
  mocks.remotes = [];
  mocks.opened = [];
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null },
    branches: [],
    available: false,
  });
});

const pick = async (combo: string, option: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: combo }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

it("previews the commits and likely conflicts before merging", async () => {
  render(<MergePane />);
  await pick("Branch to merge", "feature-a");
  expect(await screen.findByText(/commits to merge/)).toBeInTheDocument();
  expect(await screen.findByText("Add merge target picker")).toBeInTheDocument();
  expect(await screen.findByText(/src\/vcs\/merge\.ts/)).toBeInTheDocument();
});

it("merges into the branch picked in the window and offers the repository choice", async () => {
  render(<MergePane />);
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");

  await pick("Branch to merge", "shared");
  await pick("Repository", "b");
  // The source is reset with the repository change, as its branches differ.
  expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();

  await pick("Branch to merge", "feature-b");
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges).toHaveLength(1));
  expect(mocks.merges[0]).toMatchObject({ repo: "/p/b", branches: ["feature-b"] });
});

it("fetches a remote target before merging it and opens its merge request page", async () => {
  render(<MergePane />);
  await pick("Branch to merge", "feature-a");
  await pick("Merge into", /origin\/dev/);

  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges).toHaveLength(1));
  expect(mocks.remotes).toContain("fetch");
  expect(mocks.merges[0]?.branches).toEqual(["feature-a"]);

  expect(await screen.findByText("Open merge request page")).toBeInTheDocument();
  expect(mocks.opened[0]).toContain("/compare/dev...feature-a?expand=1");
});
