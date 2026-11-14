import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installUnregisteredRoots,
  projectRelative,
  unregisteredRootsBody,
  unregisteredRootsNotice,
} from "../unregisteredRoots";

const mocks = vi.hoisted(() => ({
  unregistered: vi.fn(async () => [] as string[]),
  refreshRoots: vi.fn(async () => {}),
  notify: vi.fn(),
  expire: vi.fn(),
  handlers: new Map<string, (event: unknown) => void>(),
}));

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: { ...actual.commands, vcsUnregisteredRoots: mocks.unregistered, vcsRefreshRoots: mocks.refreshRoots },
    onIdeEvent: (name: string, handler: (event: never) => void) => {
      mocks.handlers.set(name, handler as (event: unknown) => void);
      return () => {};
    },
  };
});
vi.mock("@/platform/project", () => ({
  useProject: { getState: () => ({ project: { root: "/work/app" } }), subscribe: () => () => {} },
}));
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: mocks.notify, expire: mocks.expire }),
}));

const ROOT = "/work/app";

beforeEach(() => {
  vi.useFakeTimers();
  mocks.unregistered.mockClear();
  mocks.handlers.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("unregistered Git roots", () => {
  it("lists up to three paths relative to the project and counts the rest", () => {
    expect(unregisteredRootsBody([`${ROOT}/services/api`, `${ROOT}/tools/cli`], ROOT)).toBe("services/api, tools/cli");
    const five = ["a", "b", "c", "d", "e"].map((name) => `${ROOT}/${name}`);
    expect(unregisteredRootsBody(five, ROOT)).toBe("a, b, c +2 more");
  });

  it("keeps paths outside the project as they are", () => {
    expect(projectRelative(ROOT, "/elsewhere/repo")).toBe("/elsewhere/repo");
    expect(projectRelative(null, `${ROOT}/nested`)).toBe(`${ROOT}/nested`);
  });

  it("offers one sticky action that reruns the project's scan", () => {
    const notice = unregisteredRootsNotice([`${ROOT}/nested`], ROOT);
    expect(notice).toMatchObject({
      group: "vcs",
      level: "info",
      key: "vcs.unregisteredRoots",
      title: "Unregistered Git repositories",
      body: "nested",
      sticky: true,
    });
    expect(notice.actions).toHaveLength(1);
    expect(notice.actions?.[0]?.label).toBe("Add to Project");
  });

  it("checks at open, and again only for a created path, rate limited", async () => {
    const dispose = installUnregisteredRoots();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(mocks.unregistered).toHaveBeenCalledTimes(1);

    // A modification or deletion cannot bring a repository in.
    mocks.handlers.get("fsChanged")?.({ created: [], modified: ["/work/app/a.txt"], removed: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.unregistered).toHaveBeenCalledTimes(1);

    // A created path is the signal a moved-in folder gives (past the rate limit since the open).
    await vi.advanceTimersByTimeAsync(31_000);
    mocks.handlers.get("fsChanged")?.({ created: ["/work/app/moved"], modified: [], removed: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.unregistered).toHaveBeenCalledTimes(2);

    // Another burst right after does not walk the project again.
    mocks.handlers.get("fsChanged")?.({ created: ["/work/app/other"], modified: [], removed: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.unregistered).toHaveBeenCalledTimes(2);
    dispose();
  });
});
