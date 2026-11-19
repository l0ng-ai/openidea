import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Remote, RemoteEdit } from "@/bindings";

const mocks = vi.hoisted(() => ({
  edits: [] as Array<{ repo: string | null; edit: RemoteEdit }>,
  remotes: {} as Record<string, Promise<Remote[]> | Remote[]>,
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsRemotes: async (repo: string | null) => ok(await (mocks.remotes[repo ?? ""] ?? [])),
      vcsEditRemote: (repo: string | null, edit: RemoteEdit) => {
        mocks.edits.push({ repo, edit });
        return ok(null);
      },
      vcsBranches: () => ok([]),
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { showManageRemotes } from "../gitMenuDialogs";
import { useVcs } from "../store";

const remote = (name: string, url: string): Remote => ({ name, url });

beforeEach(() => {
  mocks.edits = [];
  mocks.remotes = {
    "/p/a": [remote("origin", "git@example.com:a.git")],
    "/p/b": [remote("upstream", "git@example.com:b.git"), remote("fork", "git@example.com:me/b.git")],
  };
  useVcs.setState({ root: "/p", roots: ["/p/a", "/p/b"], repo: "/p/a", available: false });
});

// The dialog host outlives a test's render: close Git Remotes so the next test starts with none.
afterEach(() => {
  for (const ok of screen.queryAllByRole("button", { name: "OK" })) fireEvent.click(ok);
});

const pick = async (combo: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: combo }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

const addRemote = async (name: string, url: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add Remote…" }));
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: url } });
  // The Define Remote dialog opens over Git Remotes: its OK is the last one.
  fireEvent.click(screen.getAllByRole("button", { name: "OK" }).at(-1)!);
};

const options = () => screen.queryAllByRole("option").map((o) => o.textContent);

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  mocks.remotes = { "": [remote("origin", "git@example.com:p.git")] };
  render(<VcsDialogHost />);
  await act(() => showManageRemotes());
  expect(await screen.findByText("git@example.com:p.git")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  await addRemote("mirror", "git@example.com:mirror.git");
  await waitFor(() =>
    expect(mocks.edits).toEqual([
      { repo: null, edit: { op: "add", name: "mirror", url: "git@example.com:mirror.git" } },
    ]),
  );
});

it("lists and edits the remotes of the repository picked in the dialog", async () => {
  render(<VcsDialogHost />);
  await act(() => showManageRemotes());
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");
  await waitFor(() => expect(options()).toEqual(["origingit@example.com:a.git"]));

  await pick("Repository", "b");
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("b");
  await waitFor(() => expect(options()).toEqual(["upstreamgit@example.com:b.git", "forkgit@example.com:me/b.git"]));
  // The first remote of the picked repository is selected.
  expect(screen.getByRole("option", { name: /upstream/ })).toHaveAttribute("aria-selected", "true");

  // "origin" exists only in a, so the name is free in b.
  await addRemote("origin", "git@example.com:b.git");
  await waitFor(() =>
    expect(mocks.edits).toEqual([{ repo: "/p/b", edit: { op: "add", name: "origin", url: "git@example.com:b.git" } }]),
  );
  // Picking in the dialog doesn't change the selected repository elsewhere.
  expect(useVcs.getState().repo).toBe("/p/a");
});

it("ignores the remotes of a repository that is no longer picked", async () => {
  let resolveA: (remotes: Remote[]) => void = () => undefined;
  mocks.remotes["/p/a"] = new Promise<Remote[]>((resolve) => (resolveA = resolve));
  render(<VcsDialogHost />);
  await act(() => showManageRemotes());

  await pick("Repository", "b");
  await waitFor(() => expect(options()).toHaveLength(2));
  // a's remotes arrive after b was picked: they must not replace b's.
  await act(async () => resolveA([remote("origin", "git@example.com:a.git")]));
  expect(options()).toEqual(["upstreamgit@example.com:b.git", "forkgit@example.com:me/b.git"]);
});
