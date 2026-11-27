import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { RemoteTarget } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { chooseProjectWindow, openPolicy, openRemoteProject, projectWindowOverride } from "./projectWindow";
import { ask } from "./messages";
import { commands } from "@/platform/ipc";

const windowOpenRemote = vi.fn();
vi.mock("./messages", () => ({ ask: vi.fn() }));
vi.mock("@/platform/remote", () => ({
  isRemoteWindow: () => false,
  connectRemote: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  isTauri: () => true,
  commands: {
    settingsSet: vi.fn(async () => ({ general: { openProjectIn: "attach" } })),
    windowOpenRemote: (...a: unknown[]) => windowOpenRemote(...a),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({
    project: { root: "/a", name: "A", settings: {}, trusted: true, isGit: false },
    settings: {},
    lightEdit: false,
  });
});
it("offers attach for this open without remembering it", async () => {
  const button = "attach";
  vi.mocked(ask).mockResolvedValue({ button, checked: true });
  expect(await chooseProjectWindow("B")).toBe(button);
  const prompt = vi.mocked(ask).mock.calls[0]![0];
  expect(prompt.buttons.map((b) => b.id)).toEqual(["cancel", "attach", "tab", "new", "same"]);
  expect(prompt.buttons.filter((b) => b.primary).map((b) => b.id)).toEqual(["same"]);
  expect(commands.settingsSet).not.toHaveBeenCalled();
  expect(openPolicy()).toBe("ask");
  expect(await chooseProjectWindow("C")).toBe(button);
  expect(ask).toHaveBeenCalledTimes(2);
});
it("does not attach without a project or when opening a remote project", async () => {
  useProject.setState({
    settings: { general: { openProjectIn: "attach" } } as never,
  });
  vi.mocked(ask).mockResolvedValue({ button: "cancel", checked: false });
  expect(await chooseProjectWindow("remote", false)).toBeNull();
  expect(vi.mocked(ask).mock.calls[0]![0].buttons.map((b) => b.id)).toEqual(["cancel", "new", "same"]);
  useProject.setState({ project: null });
  expect(await chooseProjectWindow("B")).toBe("same");
});

it("treats a stored attach policy as ask", () => {
  useProject.setState({ settings: { general: { openProjectIn: "attach" } } } as never);
  expect(openPolicy()).toBe("ask");
});
it.each(["new", "same", "tab"] as const)("remembers %s", async (mode) => {
  vi.mocked(ask).mockResolvedValue({ button: mode, checked: true });
  await chooseProjectWindow("B");
  expect(commands.settingsSet).toHaveBeenCalledWith("global", "general.openProjectIn", JSON.stringify(mode));
});

it("opens a project tab by policy, or a new window when this one can't take one", async () => {
  useProject.setState({ settings: { general: { openProjectIn: "tab" } } } as never);
  expect(openPolicy()).toBe("tab");
  expect(await chooseProjectWindow("B")).toBe("tab");
  expect(await chooseProjectWindow("remote", false)).toBe("new");
  useProject.setState({ project: null, lightEdit: true });
  expect(await chooseProjectWindow("B")).toBe("new");
  expect(ask).not.toHaveBeenCalled();
});

describe("a recent project opened with a modifier key", () => {
  const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  const target: RemoteTarget = { kind: "wsl", distro: "Ubuntu" };

  it("sends Shift or Ctrl to a new window and Alt to this one", () => {
    expect(projectWindowOverride(mods)).toBeNull();
    expect(projectWindowOverride({ ...mods, shiftKey: true })).toBe("new");
    expect(projectWindowOverride({ ...mods, ctrlKey: true })).toBe("new");
    expect(projectWindowOverride({ ...mods, altKey: true })).toBe("same");
  });

  it("takes ⌘ on macOS, where Ctrl+click is a right-click, and nowhere else", () => {
    const os = usePlatform.getState().os;
    usePlatform.setState({ os: "macos" });
    expect(projectWindowOverride({ ...mods, metaKey: true })).toBe("new");
    usePlatform.setState({ os: "windows" });
    expect(projectWindowOverride({ ...mods, metaKey: true })).toBeNull();
    usePlatform.setState({ os });
  });

  it("opens a remote project in that window without asking", async () => {
    windowOpenRemote.mockResolvedValue({ kind: "opened" });
    const here = vi.fn(async () => {});
    useProject.setState({ settings: { general: { openProjectIn: "same" } } as never });
    expect(await openRemoteProject(target, "/home/me/app", here, "new")).toBe(true);
    expect(windowOpenRemote).toHaveBeenLastCalledWith(target, "/home/me/app", true);
    expect(here).not.toHaveBeenCalled();
    useProject.setState({ settings: { general: { openProjectIn: "new" } } as never });
    expect(await openRemoteProject(target, "/home/me/app", here, "same")).toBe(true);
    expect(windowOpenRemote).toHaveBeenLastCalledWith(target, "/home/me/app", false);
    expect(here).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
  });
});
