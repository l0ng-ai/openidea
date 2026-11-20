import { beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { chooseProjectWindow, openPolicy } from "./projectWindow";
import { ask } from "./messages";
import { commands } from "@/platform/ipc";

vi.mock("./messages", () => ({ ask: vi.fn() }));
vi.mock("@/platform/remote", () => ({
  isRemoteWindow: () => false,
  connectRemote: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  commands: {
    settingsSet: vi.fn(async () => ({ general: { openProjectIn: "attach" } })),
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
