import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify } from "./notificationStore";

const { showSystemNotification } = vi.hoisted(() => ({
  showSystemNotification: vi.fn(async () => ({ status: "ok", data: null })),
}));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, showSystemNotification } };
});

beforeEach(() => {
  vi.useFakeTimers();
  showSystemNotification.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("system toast coalescing", () => {
  it("raises one toast for a burst, naming the last balloon and how many more arrived", () => {
    notify({ level: "info", title: "File a.ts changed" });
    notify({ level: "info", title: "File b.ts changed", body: "written by an agent" });
    notify({ level: "info", title: "File c.ts changed", body: "written by an agent" });
    expect(showSystemNotification).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    expect(showSystemNotification.mock.calls[0]).toEqual([
      "File c.ts changed",
      "written by an agent\n2 more notifications",
    ]);
  });

  it("shows a lone balloon's toast as written", () => {
    notify({ level: "info", title: "Git refresh failed", body: "no remote" });
    vi.advanceTimersByTime(3000);
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    expect(showSystemNotification.mock.calls[0]).toEqual(["Git refresh failed", "no remote"]);
  });

  it("keeps waiting while balloons keep arriving", () => {
    notify({ level: "info", title: "First" });
    vi.advanceTimersByTime(2000);
    notify({ level: "info", title: "Second" });
    vi.advanceTimersByTime(2000);
    expect(showSystemNotification).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    expect(showSystemNotification.mock.calls[0]).toEqual(["Second", "1 more notification"]);
  });

  it("falls back to the count alone when a balloon has no body", () => {
    notify({ level: "warning", title: "Cannot reload Maven projects" });
    notify({ level: "warning", title: "Cannot reload Gradle projects" });
    vi.advanceTimersByTime(3000);
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    expect(showSystemNotification.mock.calls[0]).toEqual(["Cannot reload Gradle projects", "1 more notification"]);
  });
});
