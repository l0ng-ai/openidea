import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { deferred } from "@/test/deferred";

const ipc = vi.hoisted(() => ({ branchInfo: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsBranchInfo: ipc.branchInfo } };
});

const editor = vi.hoisted(() => ({
  path: null as string | null,
  listeners: new Set<() => void>(),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({
    activeInput: () => (editor.path ? { kind: "image", key: editor.path, path: editor.path } : null),
    onActiveInputChange: (fn: () => void) => {
      editor.listeners.add(fn);
      return () => editor.listeners.delete(fn);
    },
  }),
}));

import { BranchWidget } from "../BranchWidget";
import { showSyncCommitsForCurrent, useSyncCommits } from "../SyncCommitsPopup";
import { useVcs } from "../store";

const primary = "/app";
const service = "/app/service";
const initial = useVcs.getState();
const main: BranchInfo = {
  head: "main",
  headCommit: "same-head",
  upstream: "origin/main",
  ahead: 3,
  behind: 1,
  operation: null,
};
const secondary: BranchInfo = {
  ...main,
  upstream: "upstream/main",
  ahead: 5,
  behind: 2,
  outgoing: { count: 2, remote: "fork", branch: "review", reference: "refs/remotes/fork/review" },
};
const result = (data: BranchInfo) => ({ status: "ok", data });
const activateFile = (path: string | null) => {
  act(() => {
    editor.path = path;
    for (const notify of editor.listeners) notify();
  });
};

beforeEach(() => {
  ipc.branchInfo.mockReset().mockImplementation(async (repo: string) => result(repo === primary ? main : secondary));
  useVcs.setState({
    available: true,
    root: primary,
    roots: [primary, service],
    repo: primary,
    heads: { [primary]: main, [service]: secondary },
    branch: main,
    branchRoot: primary,
  });
});

afterEach(() => {
  useVcs.setState(initial);
  useSyncCommits.setState({ source: null });
  editor.path = null;
});

describe("Git toolbar repository", () => {
  it("uses the active file's counts and ranges even if both repositories share HEAD", async () => {
    editor.path = `${service}/diagram.png`;
    render(<BranchWidget />);
    expect(await screen.findByLabelText("2 incoming commits")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("2 outgoing commits"));
    expect(useSyncCommits.getState().source).toMatchObject({
      repo: service,
      direction: "outgoing",
      branch: { upstream: "upstream/main", outgoing: { reference: "refs/remotes/fork/review", count: 2 } },
    });
    expect(useVcs.getState().repo).toBe(primary);

    activateFile(`${primary}/diagram.png`);
    expect(await screen.findByLabelText("3 outgoing commits")).toBeInTheDocument();
    expect(screen.queryByLabelText("2 incoming commits")).not.toBeInTheDocument();
    expect(ipc.branchInfo.mock.calls).toEqual([[service]]);
  });

  it("discards a previous repository's response and refreshes on ref changes with the same HEAD", async () => {
    useVcs.setState({ branchRoot: null });
    const reply = deferred<ReturnType<typeof result>>();
    ipc.branchInfo.mockReturnValueOnce(reply.promise);
    render(<BranchWidget />);
    activateFile(`${service}/diagram.png`);
    expect(await screen.findByLabelText("2 outgoing commits")).toBeInTheDocument();
    await act(async () => reply.resolve(result(main)));
    expect(screen.queryByLabelText("3 outgoing commits")).not.toBeInTheDocument();

    ipc.branchInfo.mockResolvedValueOnce(result({ ...secondary, behind: 4 }));
    act(() => emitLocalIdeEvent({ type: "vcsChanged", root: primary }));
    expect(await screen.findByLabelText("4 incoming commits")).toBeInTheDocument();
    expect(ipc.branchInfo.mock.calls).toEqual([[primary], [service], [service]]);
  });

  it("opens the same repository from the Show Incoming and Outgoing Commits action", async () => {
    editor.path = `${service}/diagram.png`;
    await showSyncCommitsForCurrent();
    expect(useSyncCommits.getState().source).toMatchObject({
      repo: service,
      branch: { upstream: "upstream/main", ahead: 5, behind: 2 },
    });
    expect(useVcs.getState().repo).toBe(primary);
  });
});
