import { beforeEach, expect, it, vi } from "vitest";
import { changedChainNeighbour } from "../diffNavigation";
import { withChain, type DiffData } from "../diffInput";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: { fsProbe: probe },
}));

const diff = (name: string, text = "after\n"): DiffData => ({
  path: `/repo/${name}`,
  left: { type: "text", text: "before\n", label: "Before" },
  right: { type: "text", text, label: "After" },
});

beforeEach(() => {
  probe.mockReset();
  probe.mockResolvedValue({ status: "ok", data: { binary: false, tooLarge: false } });
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
