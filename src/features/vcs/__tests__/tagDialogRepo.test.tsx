import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  created: [] as Array<{ repo: string | null; name: string; commit: string; message: string | null; force: boolean }>,
  tags: {} as Record<string, Promise<string[]> | string[]>,
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsTags: async (repo: string | null) => ({ status: "ok" as const, data: await (mocks.tags[repo ?? ""] ?? []) }),
      vcsCreateTag: (repo: string | null, name: string, commit: string, message: string | null, force: boolean) => {
        mocks.created.push({ repo, name, commit, message, force });
        return ok(null);
      },
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { showTagDialog } from "../operations";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.created = [];
  mocks.tags = { "/p/a": ["v1.0"], "/p/b": ["v2.0"], "/p": ["v1.0"] };
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null },
    available: false,
  });
});

const pick = async (combo: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: combo }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

const typeName = (value: string) => fireEvent.change(screen.getByLabelText("Tag name:"), { target: { value } });

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  mocks.tags = { "": ["v1.0"] };
  render(<VcsDialogHost />);
  await act(() => showTagDialog());
  expect(await screen.findByText("Tag")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  typeName("v1.0");
  expect(await screen.findByText("Tag 'v1.0' already exists")).toBeInTheDocument();
  typeName("v1.1");
  fireEvent.click(screen.getByRole("button", { name: "Create Tag" }));
  await waitFor(() => expect(mocks.created).toHaveLength(1));
  expect(mocks.created[0]).toMatchObject({ repo: null, name: "v1.1", commit: "HEAD" });
});

it("creates the tag in the repository picked in the dialog", async () => {
  render(<VcsDialogHost />);
  await act(() => showTagDialog());
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");

  await pick("Repository", "b");
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("b");
  typeName("v3.0");
  fireEvent.change(screen.getByLabelText("Message:"), { target: { value: "Release" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Tag" }));
  await waitFor(() => expect(mocks.created).toHaveLength(1));
  expect(mocks.created[0]).toEqual({ repo: "/p/b", name: "v3.0", commit: "HEAD", message: "Release", force: false });
});

it("checks the name against the tags of the picked repository", async () => {
  render(<VcsDialogHost />);
  await act(() => showTagDialog());

  typeName("v1.0");
  expect(await screen.findByText("Tag 'v1.0' already exists")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Tag" })).toBeDisabled();

  // v1.0 exists only in a: the name is free in b, and b's own v2.0 is taken.
  await pick("Repository", "b");
  await waitFor(() => expect(screen.queryByText("Tag 'v1.0' already exists")).toBeNull());
  expect(screen.getByRole("button", { name: "Create Tag" })).toBeEnabled();
  typeName("v2.0");
  expect(await screen.findByText("Tag 'v2.0' already exists")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.created).toEqual([]);
});

it("ignores the tags of a repository that is no longer picked", async () => {
  let resolveA: (tags: string[]) => void = () => undefined;
  mocks.tags["/p/a"] = new Promise<string[]>((resolve) => (resolveA = resolve));
  render(<VcsDialogHost />);
  await act(() => showTagDialog());

  await pick("Repository", "b");
  typeName("v1.0");
  // a's tags arrive after b was picked: they must not mark v1.0 as taken in b.
  await act(async () => resolveA(["v1.0"]));
  expect(screen.queryByText("Tag 'v1.0' already exists")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create Tag" }));
  await waitFor(() => expect(mocks.created).toHaveLength(1));
  expect(mocks.created[0]).toMatchObject({ repo: "/p/b", name: "v1.0" });
});
