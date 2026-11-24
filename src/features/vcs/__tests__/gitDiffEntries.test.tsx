import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { vcsDiffEntries } = vi.hoisted(() => ({
  vcsDiffEntries: vi.fn((entries: unknown[]) =>
    Promise.resolve({ status: "ok", data: entries.map(() => ({ mode: "160000", gitlink: "abc123" })) }),
  ),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsDiffEntries } };
});

import type { DiffData } from "../diffInput";
import { useGitDiffEntries, type DiffEntriesCache } from "../gitDiffEntries";
import { useVcs } from "../store";

let n = 0;
const diff = (): DiffData => ({
  path: `/r/sub${++n}`,
  left: { type: "rev", rev: "HEAD" },
  right: { type: "worktree" },
});

beforeEach(() => {
  vcsDiffEntries.mockClear();
});

describe("useGitDiffEntries", () => {
  it("with a host's cache, shows a diff mounted again at once, without asking Git again", async () => {
    const data = diff();
    const cache: DiffEntriesCache = new Map();
    const first = renderHook(() => useGitDiffEntries(data, cache));
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const again = renderHook(() => useGitDiffEntries(data, cache));
    // Loaded on the first render: a submodule shows as one from the start.
    expect(again.result.current.loading).toBe(false);
    expect(again.result.current.data.right).toMatchObject({ type: "text", text: "abc123" });
    await act(async () => {});
    expect(vcsDiffEntries).toHaveBeenCalledTimes(1);
  });

  it("keeps showing a block mounted from the cache while the repository change reloads it", async () => {
    const data = diff();
    const cache: DiffEntriesCache = new Map();
    const first = renderHook(() => useGitDiffEntries(data, cache));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const states: boolean[] = [];
    const again = renderHook(() => {
      const result = useGitDiffEntries(data, cache);
      states.push(result.loading);
      return result;
    });
    vcsDiffEntries.mockImplementationOnce((entries: unknown[]) =>
      Promise.resolve({ status: "ok", data: entries.map(() => ({ mode: "160000", gitlink: "def456" })) }),
    );
    // A save, an autosave or a file change on disk: the diff must not go back to loading (and rebuild).
    act(() => useVcs.setState((s) => ({ version: s.version + 1 })));
    expect(again.result.current.data.right).toMatchObject({ type: "text", text: "abc123" });
    await waitFor(() => expect(again.result.current.data.right).toMatchObject({ type: "text", text: "def456" }));
    expect(states).not.toContain(true);
    expect(vcsDiffEntries).toHaveBeenCalledTimes(2);
  });

  it("asks Git again once the repository changed", async () => {
    const data = diff();
    const cache: DiffEntriesCache = new Map();
    const first = renderHook(() => useGitDiffEntries(data, cache));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => useVcs.setState((s) => ({ version: s.version + 1 })));
    await waitFor(() => expect(vcsDiffEntries).toHaveBeenCalledTimes(2));
    first.unmount();

    useVcs.setState((s) => ({ version: s.version + 1 }));
    // Mounted after a change: the last entries show at once, and Git is asked again.
    const again = renderHook(() => useGitDiffEntries(data, cache));
    expect(again.result.current.loading).toBe(false);
    await waitFor(() => expect(vcsDiffEntries).toHaveBeenCalledTimes(3));
  });

  it("does not replace newer cached entries when an older request finishes late", async () => {
    const data = diff();
    const cache: DiffEntriesCache = new Map();
    let finishOldRequest!: () => void;
    vcsDiffEntries.mockImplementationOnce(
      (entries) =>
        new Promise((resolve) => {
          finishOldRequest = () =>
            resolve({ status: "ok", data: entries.map(() => ({ mode: "160000", gitlink: "stale" })) });
        }),
    );
    const view = renderHook(() => useGitDiffEntries(data, cache));
    act(() => useVcs.setState((s) => ({ version: s.version + 1 })));
    await waitFor(() => expect(view.result.current.data.right).toMatchObject({ type: "text", text: "abc123" }));
    await act(async () => finishOldRequest());
    view.unmount();

    const reopened = renderHook(() => useGitDiffEntries(data, cache));
    expect(reopened.result.current.data.right).toMatchObject({ type: "text", text: "abc123" });
    expect(vcsDiffEntries).toHaveBeenCalledTimes(2);
  });

  it("without a cache (a diff tab), asks Git on every mount", async () => {
    const data = diff();
    for (let i = 1; i <= 2; i++) {
      const view = renderHook(() => useGitDiffEntries(data));
      expect(view.result.current.loading).toBe(true);
      // oxlint-disable-next-line no-await-in-loop -- this mount must finish loading before it is unmounted and the call count asserted
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      view.unmount();
      expect(vcsDiffEntries).toHaveBeenCalledTimes(i);
    }
  });
});
