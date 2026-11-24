import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { useContributions } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import type { DataSource } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({ sources: vi.fn(async (): Promise<unknown> => []) }));

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, dbSources: () => "dbSources" },
    call: (request: unknown) => (request === "dbSources" ? mocks.sources() : Promise.reject(new Error("unmocked"))),
  };
});

import { activate } from "./index";
import { DB_TOOL_WINDOW, useDatabase } from "./store";

const stripe = () => useContributions.getState().toolWindows.get(DB_TOOL_WINDOW)?.stripe;

describe("Database tool window", () => {
  let dispose = () => {};
  afterEach(() => {
    dispose();
    dispose = () => {};
    useProject.setState({ project: null });
    useDatabase.setState({ sources: [], loaded: false });
  });

  it("is on the stripe by default only while there are data sources", () => {
    dispose = activate();
    expect(stripe()).toBe("onUse");
    useDatabase.setState({ sources: [{ id: "pg" } as DataSource], loaded: true });
    expect(stripe()).toBeUndefined();
    useDatabase.setState({ sources: [] });
    expect(stripe()).toBe("onUse");
    dispose();
    dispose = () => {};
    expect(useContributions.getState().toolWindows.has(DB_TOOL_WINDOW)).toBe(false);
  });

  it("asks for the sources quietly when a project opens, before the window loads them", async () => {
    dispose = activate();
    mocks.sources.mockResolvedValueOnce([{ id: "pg" }]);
    useProject.setState({ project: { root: "/app" } as never });
    await waitFor(() => expect(stripe()).toBeUndefined());

    mocks.sources.mockRejectedValueOnce(new Error("no backend"));
    useProject.setState({ project: { root: "/other" } as never });
    await waitFor(() => expect(mocks.sources).toHaveBeenCalledTimes(2));
    expect(stripe()).toBe("onUse");
    expect(useDatabase.getState().loaded).toBe(false);
  });
});
