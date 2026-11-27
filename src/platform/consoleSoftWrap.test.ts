import { afterEach, describe, expect, it, vi } from "vitest";

/** Writes the dotted key into the current settings, as the host does. */
const ipc = vi.hoisted(() => ({
  settingsSet: vi.fn(async (_scope: string, key: string, value: string) => {
    const { useProject } = await import("@/platform/project");
    const settings = structuredClone(useProject.getState().settings ?? {}) as Record<string, unknown>;
    const path = key.split(".");
    let node = settings;
    for (const part of path.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[path.at(-1)!] = JSON.parse(value);
    return { status: "ok" as const, data: settings };
  }),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const { setConsoleSoftWrap, workflowSettings } = await import("./workflowSettings");
const { useProject } = await import("./project");

afterEach(() => {
  useProject.setState({ settings: null });
  vi.clearAllMocks();
});

describe("setConsoleSoftWrap", () => {
  it("writes the global console setting so every run tab follows it", async () => {
    await setConsoleSoftWrap(true);
    expect(ipc.settingsSet).toHaveBeenCalledWith("global", "console.softWrap", "true");
    expect(workflowSettings().console.softWrap).toBe(true);

    await setConsoleSoftWrap(false);
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("global", "console.softWrap", "false");
    expect(workflowSettings().console.softWrap).toBe(false);
  });
});
