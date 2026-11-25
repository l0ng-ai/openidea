import { afterEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  settingsSet: vi.fn(async (_scope: string, key: string, value: string) => ({
    status: "ok" as const,
    data: { editor: { inlay: { [key.split(".").pop()!]: JSON.parse(value) } } },
  })),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
const executeAction = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/platform/actions", () => ({ executeAction }));

const { codeVisionMenuItems, codeVisionShown, toggleCodeVision } = await import("./codeVision");
const { useProject } = await import("@/platform/project");

type Item = { label?: string; kind?: string; run?: () => void };
const labels = (items: Item[]) => items.map((i) => i.label ?? i.kind);

afterEach(() => {
  useProject.setState({ settings: null });
  vi.clearAllMocks();
});

describe("Code Vision switch", () => {
  it("toggles the global setting and keeps the per-kind choices", async () => {
    useProject.setState({ settings: { editor: { inlay: { codeVisionUsages: false } } } as never });
    expect(codeVisionShown()).toBe(true);
    await toggleCodeVision();
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("global", "editor.inlay.codeVision", "false");
    expect(codeVisionShown()).toBe(false);
    await toggleCodeVision();
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("global", "editor.inlay.codeVision", "true");
    expect(ipc.settingsSet).toHaveBeenCalledTimes(2);
  });
});

describe("Code Vision hint menu", () => {
  it("offers to hide the clicked kind, all of Code Vision, or open its settings", () => {
    expect(labels(codeVisionMenuItems("usages") as Item[])).toEqual([
      "Hide Usages",
      "Hide Code Vision",
      "separator",
      "Code Vision Settings…",
    ]);
    expect(labels(codeVisionMenuItems("author") as Item[])[0]).toBe("Hide Code Author");
    expect(labels(codeVisionMenuItems(undefined) as Item[])).toEqual([
      "Hide Code Vision",
      "separator",
      "Code Vision Settings…",
    ]);
  });

  it("writes the matching setting or opens the Inlay Hints page", () => {
    const [hideAuthor, hideAll, , settings] = codeVisionMenuItems("author") as Item[];
    hideAuthor!.run!();
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("global", "editor.inlay.codeVisionAuthor", "false");
    hideAll!.run!();
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("global", "editor.inlay.codeVision", "false");
    settings!.run!();
    expect(executeAction).toHaveBeenCalledWith("file.settings", "editor.inlayHints");
  });
});
