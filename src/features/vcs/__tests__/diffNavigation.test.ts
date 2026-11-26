import { beforeEach, expect, it, vi } from "vitest";
import { changedChainNeighbour } from "../diffNavigation";
import { withChain, type DiffData } from "../diffInput";

const probe = vi.hoisted(() => vi.fn());
const diffEntries = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: { fsProbe: probe, vcsDiffEntries: diffEntries },
}));

const diff = (name: string, text = "after\n"): DiffData => ({
  path: `/repo/${name}`,
  left: { type: "text", text: "before\n", label: "Before" },
  right: { type: "text", text, label: "After" },
});

beforeEach(() => {
  probe.mockReset();
  diffEntries.mockReset();
  probe.mockResolvedValue({ status: "ok", data: { binary: false, tooLarge: false } });
});

it("visits a changed submodule using its commit ids without probing the directory as a file", async () => {
  const entry: DiffData = { path: "/repo/vendor", left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } };
  diffEntries.mockResolvedValue({
    status: "ok",
    data: ["a", "b"].map((value) => ({ mode: "160000", gitlink: value.repeat(40) })),
  });
  const data = withChain([diff("a"), entry, diff("z")], 0);
  expect(await changedChainNeighbour(data, 1, "none")).toMatchObject({ path: entry.path });
  expect(probe).not.toHaveBeenCalled();
});

it.each([1, -1] as const)("skips unchanged and binary revisions in direction %s", async (dir) => {
  const items = [diff("a"), diff("binary", "\0binary"), diff("unchanged", "before\n"), diff("z")];
  const data = withChain(items, dir === 1 ? 0 : 3);
  const next = await changedChainNeighbour(data, dir, "none");
  expect(next).toMatchObject({ path: dir === 1 ? "/repo/z" : "/repo/a", reveal: dir === 1 ? "first" : "last" });
  expect(await changedChainNeighbour(next!, dir, "none")).toBeNull();
});

it("skips binary, oversized and unreadable working files before loading their text", async () => {
  probe.mockImplementation((path: string) => {
    if (path.endsWith("unreadable")) return Promise.reject(new Error("gone"));
    return Promise.resolve({
      status: "ok",
      data: { binary: path.endsWith("binary"), tooLarge: path.endsWith("large") },
    });
  });
  const skipped = ["binary", "large", "unreadable"].map((name) => ({
    ...diff(name),
    right: { type: "worktree" as const },
  }));
  const data = withChain([diff("a"), ...skipped, diff("z")], 0);
  expect(await changedChainNeighbour(data, 1, "none")).toMatchObject({ path: "/repo/z" });
  expect(probe).toHaveBeenCalledTimes(3);
});

it("uses the viewer whitespace policy and stops when no textual changes remain", async () => {
  const data = withChain([diff("a"), diff("space", " before \n")], 0);
  expect(await changedChainNeighbour(data, 1, "none")).toMatchObject({ path: "/repo/space" });
  expect(await changedChainNeighbour(data, 1, "whitespace")).toBeNull();
  expect(await changedChainNeighbour(diff("single"), 1, "none")).toBeNull();
});

it("normalizes line endings like the viewer when skipping unchanged files", async () => {
  const crlf = diff("crlf", "before\r\n");
  const data = withChain([diff("a"), crlf, diff("z")], 0);
  expect(await changedChainNeighbour(data, 1, "none")).toMatchObject({ path: "/repo/z" });
});
