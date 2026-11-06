import { afterEach, expect, it, vi } from "vitest";
import { watchPluginMarkers, usePluginMarkers, invalidatePluginMarkers } from "./markerStore";
import { invalidateNavigationProviders } from "@/editor/navigationProviders";
const mock = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: { pluginNavigationMarkers: mock },
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
  for (let i = 0; i < 130; i++) off.push(watchPluginMarkers(`/p/${i}.java`));
  off.push(watchPluginMarkers("/p/0.java"));
  await vi.advanceTimersByTimeAsync(250);
  expect(mock.mock.calls.map((a) => a[0].length)).toEqual([64, 64, 2]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(mock).toHaveBeenCalledTimes(3);
});
it("discards in-flight results after the project/provider epoch changes", async () => {
  vi.useFakeTimers();
  let finish!: (r: unknown) => void;
  mock.mockImplementationOnce(() => new Promise((r) => (finish = r))).mockResolvedValue({ status: "ok", data: [] });
  off.push(watchPluginMarkers("/old/A.xml"));
  await vi.advanceTimersByTimeAsync(250);
  invalidateNavigationProviders();
  finish({ status: "ok", data: [{ path: "/old/A.xml", version: 1, markers: [] }] });
  await vi.advanceTimersByTimeAsync(250);
  expect(usePluginMarkers.getState().entries.size).toBe(0);
});
it("invalidates both changed files and markers targeting them", () => {
  const range = { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } };
  usePluginMarkers.setState({
    entries: new Map([
      [
        "/p/A.xml",
        {
          path: "/p/A.xml",
          version: 1,
          markers: [{ range, targets: [{ path: "/p/A.java", range }] }],
        },
      ],
    ]),
  });
  invalidatePluginMarkers(["/p/A.java"]);
  expect(usePluginMarkers.getState().entries.size).toBe(0);
});
