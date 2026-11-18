import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

type Handler = (e: unknown) => void;
const handlers = new Map<string, Handler[]>();
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  onIdeEvent: (kind: string, h: Handler) => {
    handlers.set(kind, [...(handlers.get(kind) ?? []), h]);
    return () =>
      handlers.set(
        kind,
        (handlers.get(kind) ?? []).filter((x) => x !== h),
      );
  },
}));
vi.mock("./browsers", async (original) => ({
  ...(await original<typeof import("./browsers")>()),
  webUrl: async () => "http://127.0.0.1/p/page.html",
}));

const { WebEditor } = await import("./WebEditor");
const { useWebPreview } = await import("./browsers");
const { useProject } = await import("@/platform/project");

const emit = (kind: string, e: unknown) => act(() => handlers.get(kind)?.forEach((h) => h(e)));
const fsChanged = (modified: string[]) => emit("fsChanged", { created: [], modified, removed: [] });

describe("the built-in HTML preview", () => {
  afterEach(cleanup);

  it("reloads for the page and its web resources, not for unrelated files", async () => {
    vi.useFakeTimers();
    try {
      useProject.setState({ project: { root: "/p" } as never });
      useWebPreview.setState({ "/p/page.html": true });
      const { container } = render(
        <WebEditor path="/p/page.html" tabId="t">
          <div />
        </WebEditor>,
      );
      await act(async () => {});
      const frame = () => container.querySelector("iframe");
      const first = frame();
      expect(first).toBeTruthy();
      fsChanged(["/p/notes.txt", "/p/README.md"]);
      act(() => vi.advanceTimersByTime(1000));
      expect(frame()).toBe(first);
      fsChanged(["/p/style.css"]);
      act(() => vi.advanceTimersByTime(1000));
      expect(frame()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
