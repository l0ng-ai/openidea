import { beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { usePluginRunTargets } from "@/platform/pluginRunTargets";
import { withRunTarget } from "@/platform/runTargetSelection";
import type { RegisteredRunTarget, RunConfig, Settings } from "@/bindings";
const mocks = vi.hoisted(() => ({ list: vi.fn(), answer: vi.fn(), notify: vi.fn(), expire: vi.fn() }));
vi.mock("../backend", () => ({ pluginsBackend: () => ({ runTargets: mocks.list, answerRunTarget: mocks.answer }) }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify, expire: mocks.expire }) }));
import { refreshRunTargets, startRunTargets } from "../runTargets";
const target: RegisteredRunTarget = {
  id: "plugin-target:4:testddev",
  pluginId: "test",
  pluginName: "Test",
  prompt: true,
  target: {
    id: "ddev",
    name: "DDEV",
    program: "ddev",
    args: ["exec"],
    workdirArgs: [],
    containerRoot: null,
    commands: [],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ project: { root: `/project-${Math.random()}` } as never, settings: {} });
  usePluginRunTargets.setState({ targets: [] });
  mocks.list.mockResolvedValue([target]);
});
it("loads settings-window targets after its project arrives without prompting there", async () => {
  useProject.setState({ project: null });
  const stop = startRunTargets(false);
  try {
    useProject.setState({ project: { root: "/settings-owner" } as never });
    await vi.waitFor(() => expect(usePluginRunTargets.getState().targets).toEqual([target]));
    expect(mocks.notify).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue([]);
    await refreshRunTargets(false);
    expect(usePluginRunTargets.getState().targets).toEqual([]);
    expect(mocks.answer).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});
it("offers Use / Not now once without changing the selection on registration", async () => {
  const original = useProject.getState().settings;
  await refreshRunTargets();
  expect(useProject.getState().settings).toBe(original);
  expect(mocks.answer).not.toHaveBeenCalled();
  const notification = mocks.notify.mock.calls[0]![0];
  expect(notification.body).toBe("Use DDEV for running PHP / Node / Composer in this project?");
  expect(notification.actions.map((a: { label: string }) => a.label)).toEqual(["Use", "Not now"]);
  await refreshRunTargets();
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  mocks.answer.mockResolvedValue(original);
  mocks.list.mockResolvedValue([{ ...target, prompt: false }]);
  notification.actions[1].run();
  await vi.waitFor(() => expect(mocks.answer).toHaveBeenCalledWith(target.id, false));
  expect(useProject.getState().settings).toBe(original);
});
it("Use applies only the host-returned settings and a removed target disappears", async () => {
  const settings: Settings = {
    run: { defaultTarget: target.id },
    languages: { php: { runTarget: target.id }, node: { runTarget: target.id } },
  };
  await refreshRunTargets();
  mocks.answer.mockResolvedValue(settings);
  mocks.list.mockResolvedValue([{ ...target, prompt: false }]);
  mocks.notify.mock.calls[0]![0].actions[0].run();
  await vi.waitFor(() => expect(useProject.getState().settings).toBe(settings));
  mocks.list.mockResolvedValue([]);
  await refreshRunTargets();
  expect(usePluginRunTargets.getState().targets).toEqual([]);
  expect(mocks.expire).toHaveBeenCalledWith(`plugin-run-target:${target.id}`);
});
it("explicit local and per-config selections win over interpreter and project defaults", () => {
  useProject.setState({
    settings: {
      run: { defaultTarget: "default" },
      languages: { php: { runTarget: "php-target" }, node: { runTarget: "node-target" } },
    },
  });
  const config = { command: "php", kind: "php" } as RunConfig;
  expect(withRunTarget(config).target).toBe("php-target");
  expect(withRunTarget({ ...config, command: "npm", kind: "npm" }).target).toBe("node-target");
  expect(withRunTarget({ ...config, command: "cargo", kind: "cargo" }).target).toBe("default");
  expect(withRunTarget({ ...config, target: "" }).target).toBe("");
  expect(withRunTarget({ ...config, target: "explicit" }).target).toBe("explicit");
});
