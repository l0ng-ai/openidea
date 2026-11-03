import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
const backend = vi.hoisted(() => ({
  resolve: vi.fn(),
  event: undefined as undefined | ((e: { created: string[]; modified: string[]; removed: string[] }) => void),
}));
vi.mock("./ipc", async (original) => ({
  ...(await original<typeof import("./ipc")>()),
  isTauri: () => true,
  commands: { jvmFilePresentations: backend.resolve },
  onIdeEvent: (name: string, handler: typeof backend.event) => {
    if (name === "fsChanged") backend.event = handler;
    return () => {};
  },
}));
vi.mock("./projectPresentation", () => ({ useProjectPresentation: () => ({ spring: false, modules: new Map() }) }));
import { useFilePresentation, useFilePresentationIcons } from "./filePresentation";
const answer = (path: string, kind = "interface") => ({
  path,
  presentation: { kind, springBoot: false, runnable: false },
});
const tick = async () => {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
};

describe("visible file resolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    backend.resolve
      .mockReset()
      .mockImplementation(async (paths: string[]) => ({ status: "ok", data: paths.map((p) => answer(p)) }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("shows a plain icon immediately and batches mounted paths only", async () => {
    const { result } = renderHook(() => useFilePresentationIcons(["/p/Foo.java", "/p/Bar.kt", "/p/config.yml"]));
    expect(result.current.get("/p/Foo.java")).toBe("file-java");
    expect(backend.resolve).not.toHaveBeenCalled();
    await tick();
    expect(backend.resolve).toHaveBeenCalledOnce();
    expect(backend.resolve.mock.calls[0]?.[0]).toEqual(["/p/Foo.java", "/p/Bar.kt"]);
    expect(result.current.get("/p/Foo.java")).toBe("interface");
  });
  it("drops unmounted requests and splits large sets into bounded batches", async () => {
    const dropped = renderHook(() => useFilePresentation("/p/Invisible.java"));
    dropped.unmount();
    const { result } = renderHook(() =>
      useFilePresentationIcons(Array.from({ length: 130 }, (_, i) => `/p/F${i}.java`)),
    );
    await tick();
    await tick();
    await tick();
    expect(backend.resolve.mock.calls.map(([paths]) => paths.length)).toEqual([64, 64, 2]);
    expect(result.current.get("/p/F129.java")).toBe("interface");
    expect(backend.resolve.mock.calls.flatMap(([paths]) => paths)).not.toContain("/p/Invisible.java");
  });
  it("invalidates on watcher changes and rejects an in-flight stale result", async () => {
    let finish!: (value: unknown) => void;
    backend.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useFilePresentation("/p/Foo.java"));
    await tick();
    act(() => backend.event?.({ created: [], modified: ["/p/Foo.java"], removed: [] }));
    await act(async () => {
      finish({ status: "ok", data: [answer("/p/Foo.java", "class")] });
    });
    expect(result.current.icon).toBe("file-java");
    await tick();
    expect(result.current.icon).toBe("interface");
    expect(backend.resolve).toHaveBeenCalledTimes(2);
  });
  it("rechecks changed mtimes while preserving cached results for unchanged rows", async () => {
    const { result, rerender } = renderHook(({ mtime }) => useFilePresentation("/p/Foo.java", mtime), {
      initialProps: { mtime: 1 },
    });
    await tick();
    rerender({ mtime: 1 });
    await tick();
    expect(backend.resolve).toHaveBeenCalledOnce();
    rerender({ mtime: 2 });
    await tick();
    expect(backend.resolve).toHaveBeenCalledTimes(2);
    expect(result.current.icon).toBe("interface");
  });
  it("caches failures instead of continuously retrying visible batches", async () => {
    backend.resolve.mockRejectedValue(new Error("offline"));
    renderHook(() => useFilePresentationIcons(Array.from({ length: 65 }, (_, i) => `/p/F${i}.java`)));
    await tick();
    await tick();
    await tick();
    expect(backend.resolve).toHaveBeenCalledTimes(2);
  });
});
