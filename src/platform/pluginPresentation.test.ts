import { afterEach, expect, it, vi } from "vitest";
import { watchPluginPresentation, usePluginPresentations, invalidatePluginPresentations } from "./pluginPresentation";
import { invalidateNavigationProviders } from "@/editor/navigationProviders";
const mock = vi.hoisted(() => vi.fn());
vi.mock("./ipc", async (original) => ({
  ...(await original<typeof import("./ipc")>()),
  isTauri: () => true,
  commands: { pluginNavigationPresentations: mock },
}));
const off: (() => void)[] = [];
afterEach(() => {
  off.splice(0).forEach((f) => f());
  vi.useRealTimers();
  mock.mockReset();
});
it("batches visible paths, shares watchers and does no polling while idle", async () => {
  vi.useFakeTimers();
  mock.mockResolvedValue({ status: "ok", data: [] });
  for (let i = 0; i < 130; i++) off.push(watchPluginPresentation(`/p/${i}.java`));
  off.push(watchPluginPresentation("/p/0.java"));
  await vi.advanceTimersByTimeAsync(250);
  expect(mock.mock.calls.map((a) => a[0].length)).toEqual([64, 64, 2]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(mock).toHaveBeenCalledTimes(3);
});
it("discards in-flight results after the project/provider epoch changes", async () => {
  vi.useFakeTimers();
  let finish!: (r: unknown) => void;
  mock.mockImplementationOnce(() => new Promise((r) => (finish = r))).mockResolvedValue({ status: "ok", data: [] });
  off.push(watchPluginPresentation("/old/A.xml"));
  await vi.advanceTimersByTimeAsync(250);
  invalidateNavigationProviders();
  finish({ status: "ok", data: [{ path: "/old/A.xml", version: 1, icon: "arrow-right", markers: [], regions: [] }] });
  await vi.advanceTimersByTimeAsync(250);
  expect(usePluginPresentations.getState().entries.size).toBe(0);
});
it("invalidates both changed files and markers targeting them", () => {
  const range = { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } };
  usePluginPresentations.setState({
    entries: new Map([
      [
        "/p/A.xml",
        {
          path: "/p/A.xml",
          version: 1,
          icon: "arrow-right",
          regions: [],
          markers: [{ range, targets: [{ path: "/p/A.java", range }] }],
        },
      ],
    ]),
  });
  invalidatePluginPresentations(["/p/A.java"]);
  expect(usePluginPresentations.getState().entries.size).toBe(0);
});
