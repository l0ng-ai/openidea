import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const calls = vi.hoisted(() => [] as string[]);

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsReadImage: async (path: string) =>
        files.has(path) ? { status: "ok", data: files.get(path)! } : { status: "error", error: { message: "missing" } },
      fsDelete: async (path: string) => {
        calls.push(`delete ${path}`);
        files.delete(path);
        return { status: "ok", data: null };
      },
      fsCopy: async (from: string, to: string) => {
        calls.push(`copy ${from} ${to}`);
        files.set(to, `data:image/svg+xml;base64,${from}`);
        return { status: "ok", data: null };
      },
    },
  };
});

const { hasCustomProjectIcon, projectIconCandidates, setProjectIcon, useProjectIcon } = await import("./projectIcon");

afterEach(() => {
  files.clear();
  calls.length = 0;
  delete document.documentElement.dataset.theme;
});

describe("project icon", () => {
  it("looks in .openidea, then IntelliJ's .idea; the dark variant first in a dark theme", () => {
    expect(projectIconCandidates("/work/app", false)).toEqual([
      "/work/app/.openidea/icon.svg",
      "/work/app/.openidea/icon.png",
      "/work/app/.idea/icon.svg",
      "/work/app/.idea/icon.png",
    ]);
    expect(projectIconCandidates("C:\\work\\app\\", true).slice(0, 2)).toEqual([
      "C:\\work\\app\\.openidea\\icon_dark.svg",
      "C:\\work\\app\\.openidea\\icon.svg",
    ]);
  });

  it("shows an IntelliJ project's icon, and one set by Change Project Icon… over it until reset", async () => {
    files.set("/work/idea/.idea/icon.svg", "data:idea");
    const { result } = renderHook(() => useProjectIcon("/work/idea"));
    await waitFor(() => expect(result.current).toBe("data:idea"));
    // IntelliJ's own icon is not ours to reset.
    expect(hasCustomProjectIcon("/work/idea")).toBe(false);

    await act(() => setProjectIcon("/work/idea", "/pics/logo.SVG"));
    await waitFor(() => expect(result.current).toBe("data:image/svg+xml;base64,/pics/logo.SVG"));
    expect(calls.at(-1)).toBe("copy /pics/logo.SVG /work/idea/.openidea/icon.svg");
    expect(hasCustomProjectIcon("/work/idea")).toBe(true);

    await act(() => setProjectIcon("/work/idea", null));
    await waitFor(() => expect(result.current).toBe("data:idea"));
    await expect(setProjectIcon("/work/idea", "/pics/logo.gif")).rejects.toThrow("SVG or PNG");
  });

  it("has none for a remote project or one without an icon", async () => {
    const { result } = renderHook(() => useProjectIcon("ssh://host/work/app"));
    const plain = renderHook(() => useProjectIcon("/work/plain"));
    await waitFor(() => expect(plain.result.current).toBeNull());
    expect(result.current).toBeNull();
  });
});
