import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RemoteOp } from "@/bindings";

const mocks = vi.hoisted(() => ({
  ops: [] as Array<{ repo: string | null; op: RemoteOp }>,
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
  const head = (repo: string | null) => (repo === "/p/b" ? "dev" : "main");
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: (repo: string | null) =>
        ok({
          head: head(repo),
          headCommit: "c1",
          upstream: `origin/${head(repo)}`,
          ahead: 0,
          behind: 0,
          operation: null,
        }),
      vcsBranches: (repo: string | null) =>
        ok(
          (repo === "/p/b" ? ["dev", "main"] : ["main"]).map((name) => ({
            name: `${repo === "/p/b" ? "upstream" : "origin"}/${name}`,
            remote: true,
            current: false,
          })),
        ),
      vcsRemotes: (repo: string | null) =>
        ok(repo === "/p/c" ? [] : [{ name: repo === "/p/b" ? "upstream" : "origin", fetchUrl: "/r", pushUrl: "/r" }]),
      vcsRemote: (repo: string | null, _request: number, op: RemoteOp) => {
        mocks.ops.push({ repo, op });
        return ok(null);
      },
      cancelRequest: () => ok(null),
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { showPullDialog } from "../gitMenuDialogs";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.ops = [];
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: "origin/main", ahead: 0, behind: 0, operation: null },
    remoteBusy: null,
    available: false,
  });
});

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("origin"));
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]).toMatchObject({ repo: null, op: { op: "pullFrom", remote: "origin", branches: ["main"] } });
});

it("pulls into the repository picked in the dialog, with that repository's remote and branch", async () => {
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  expect(await screen.findByText("Pull to main")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "b" }));

  expect(await screen.findByText("Pull to dev")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("upstream"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote branch" })).toHaveTextContent("dev"));

  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]).toMatchObject({
    repo: "/p/b",
    op: { op: "pullFrom", remote: "upstream", branches: ["dev"], rebase: false },
  });
});

it("keeps the repository choice when the picked repository has no remotes", async () => {
  useVcs.setState({ roots: ["/p/a", "/p/b", "/p/c"] });
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("origin"));

  fireEvent.click(screen.getByRole("button", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "c" }));
  expect(await screen.findByText(/No remotes are configured/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "a" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("origin"));
  expect(await screen.findByText("Pull to main")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.ops).toEqual([]);
});
