import { beforeEach, expect, it, vi } from "vitest";
import type { ChangedFile } from "@/bindings";

const { entryKind, openDiff, openVcsDiff, openFrontDiff } = vi.hoisted(() => ({
  entryKind: vi.fn(),
  openDiff: vi.fn(),
  openVcsDiff: vi.fn(),
  openFrontDiff: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, fsEntryKind: entryKind } };
});

vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff,
  openVcsDiff,
}));
vi.mock("../diffDialog", () => ({ openDiffDialog: openFrontDiff }));

import { toLogChanges } from "../logChanges";
import { showStashDiff } from "../stashDiff";

function changes(files: ChangedFile[]) {
  return toLogChanges(files, { id: "saved", shortId: "saved", parents: ["parent"] }, "/p/app");
}

const file = (path: string, kind: ChangedFile["kind"] = "modified", oldPath: string | null = null): ChangedFile => ({
  path,
  kind,
  oldPath,
});

const missing = { status: "error", error: { kind: "notFound", message: "File not found" } };
const present = { status: "ok", data: "file" };

beforeEach(() => {
  vi.resetAllMocks();
  entryKind.mockResolvedValue(present);
});

it("compares the buffer-backed working file with the selected stash revision and preserves the chain", async () => {
  const chain = changes([file("first.txt"), file("selected.txt")]);
  await showStashDiff({ index: 2, changes: chain.slice(1), chain }, "local");
  expect(openVcsDiff).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/p/app/selected.txt",
      left: { type: "worktree", label: "Local Version" },
      right: { type: "rev", rev: "saved", label: "stash@{2}" },
      chain: [
        expect.objectContaining({ path: "/p/app/first.txt" }),
        expect.objectContaining({ path: "/p/app/selected.txt" }),
      ],
    }),
    { preview: true },
  );
});

it("uses the former path for a saved rename, shows a one-sided absent file, and skips a missing deletion", async () => {
  entryKind.mockImplementation(async (path: string) => (path === "/p/app/old.txt" ? present : missing));
  const chain = changes([
    file("gone.txt", "deleted"),
    file("new.txt", "renamed", "old.txt"),
    file("added.txt", "added"),
  ]);
  await showStashDiff({ index: 3, changes: chain, chain }, "local", new AbortController().signal);
  expect(openDiff).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/p/app/new.txt",
      left: { type: "file", path: "/p/app/old.txt", label: "Local Version" },
      chain: [
        expect.objectContaining({ path: "/p/app/new.txt" }),
        expect.objectContaining({ path: "/p/app/added.txt", left: expect.objectContaining({ absent: true }) }),
      ],
    }),
    { preview: true, focus: false },
  );
});

it("compares with the recorded parent, including an absent side for a stashed deletion", async () => {
  const chain = changes([file("gone.txt", "deleted")]);
  await showStashDiff({ index: 0, changes: chain, chain }, "parent");
  expect(entryKind).not.toHaveBeenCalled();
  expect(openVcsDiff).toHaveBeenCalledWith(
    expect.objectContaining({
      left: expect.objectContaining({ type: "rev", rev: "parent" }),
      right: expect.objectContaining({ type: "text", absent: true }),
    }),
    { preview: true },
  );
});

it("does not bring a diff to the front after its review dialog closes", async () => {
  const lifetime = new AbortController();
  let finish!: (value: typeof present) => void;
  entryKind.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const chain = changes([file("pending.txt")]);
  const pending = showStashDiff({ index: 0, changes: chain, chain, dialogLifetime: lifetime.signal }, "parent");
  lifetime.abort();
  finish(present);
  await pending;
  expect(openFrontDiff).not.toHaveBeenCalled();
});
