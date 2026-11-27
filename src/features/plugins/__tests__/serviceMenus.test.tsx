import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/bindings";
import { registerAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  runExecutors,
  type NotificationService,
  type ServiceContext,
} from "@/workbench/contributions";
import { executorLaunch, executorTarget, pluginExecutors, syncPluginExecutors } from "../executors";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, syncUiContributions } from "../projection";
import { usePlugins } from "../store";
import { pluginServiceActions, pluginServiceMenuItems } from "../uiPoints";

let undefinePoints: () => void = () => {};

beforeEach(() => {
  undefinePoints = defineBuiltinUiPoints();
});

afterEach(() => {
  clearUiContributions();
  undefinePoints();
  usePlugins.setState({ plugins: [] });
});

const plugin = (extra: Partial<PluginInfo> = {}) =>
  ({ id: "hot", name: "Hot Reload Tools", status: "active", enabled: true, icon: null, ...extra }) as PluginInfo;

const spring: ServiceContext = {
  provider: "runConfigurations",
  id: "app",
  kind: "spring-boot",
  name: "App",
  running: false,
  runConfigurationId: "app",
};
const container: ServiceContext = { provider: "docker", id: "c1", kind: "docker-container", name: "db", running: true };

const config = (extra: Partial<RunConfig> = {}): RunConfig => ({
  id: "app",
  name: "App",
  kind: "spring-boot",
  command: "java",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "java-debug",
  ...extra,
});

describe("plugin Services menus", () => {
  it("offers entries whose when holds for every selected service, with the services as argument", async () => {
    const run = vi.fn();
    const offs = [
      registerAction({ id: "plugin.hot.reload", title: "Reload", icon: "refresh", run: ({ arg }) => run(arg) }),
      registerAction({ id: "plugin.hot.logs", title: "Logs", run: () => {} }),
    ];
    syncUiContributions(
      [
        {
          pluginId: "hot",
          point: "menus",
          key: "services.context/reload",
          decl: {
            menu: "services.context",
            command: "reload",
            submenu: "Hot Reload",
            when: "serviceKind == 'spring-boot' && !serviceRunning",
          },
        },
        {
          pluginId: "hot",
          point: "menus",
          key: "services.context/logs",
          decl: { menu: "services.context", command: "logs", submenu: "Hot Reload", when: "serviceRunning" },
        },
        {
          pluginId: "hot",
          point: "menus",
          key: "services.toolbar/reload",
          decl: { menu: "services.toolbar", command: "reload", when: "serviceSelectionCount == 1" },
        },
      ],
      [plugin()],
    );

    const json = (services: ServiceContext[]) =>
      JSON.stringify({ services: services.map((s) => ({ ...s, runConfigurationId: s.runConfigurationId ?? null })) });
    const arg = json([spring]);
    expect(JSON.parse(arg)).toEqual({
      services: [
        {
          provider: "runConfigurations",
          id: "app",
          kind: "spring-boot",
          name: "App",
          running: false,
          runConfigurationId: "app",
        },
      ],
    });
    // One visible entry of the submenu: no nesting.
    expect(pluginServiceMenuItems([spring])).toEqual([{ kind: "action", action: "plugin.hot.reload", arg }]);
    expect(pluginServiceMenuItems([container])).toEqual([
      { kind: "action", action: "plugin.hot.logs", arg: json([container]) },
    ]);
    // Mixed selection: an entry shows only when it holds for each service.
    expect(pluginServiceMenuItems([spring, container])).toEqual([]);
    const running = { ...spring, running: true };
    expect(pluginServiceMenuItems([running])).toEqual([
      { kind: "action", action: "plugin.hot.logs", arg: json([running]) },
    ]);

    const [button, ...rest] = pluginServiceActions([spring]);
    expect(rest).toEqual([]);
    expect(button).toMatchObject({ id: "plugin.hot.reload", title: "Reload", icon: "refresh" });
    button!.run();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(arg));
    expect(pluginServiceActions([spring, { ...spring, id: "other" }])).toEqual([]);
    offs.forEach((off) => off());
  });

  it("drops entries whose command is not registered", () => {
    syncUiContributions(
      [
        {
          pluginId: "hot",
          point: "menus",
          key: "services.context/gone",
          decl: { menu: "services.context", command: "gone" },
        },
      ],
      [plugin()],
    );
    expect(pluginServiceMenuItems([spring])).toEqual([]);
  });
});

describe("plugin executors", () => {
  const agent = (executor: string | null, approved = true) => ({
    fileName: "hot.jar",
    args: null,
    vmOptions: [],
    jdk: null,
    approved,
    executor,
  });

  it("lists enabled plugins whose agent names an executor", () => {
    expect(
      pluginExecutors([
        plugin({ javaAgent: agent("Hot Reload") }),
        plugin({ id: "plain", javaAgent: agent(null) }),
        plugin({ id: "off", enabled: false, javaAgent: agent("Off") }),
      ]),
    ).toEqual([{ pluginId: "hot", pluginName: "Hot Reload Tools", title: "Hot Reload", approved: true }]);
  });

  it("registers Run and Debug with <title> for JVM configurations", async () => {
    usePlugins.setState({ plugins: [plugin({ javaAgent: agent("Hot Reload") })] });
    const stop = syncPluginExecutors();
    const mine = runExecutors().filter((e) => e.id.startsWith("plugin:hot"));
    expect(mine.map((e) => [e.id, e.label("App"), e.debug ?? false])).toEqual([
      ["plugin:hot", "Run 'App' with Hot Reload", false],
      ["plugin:hot:debug", "Debug 'App' with Hot Reload", true],
    ]);
    const [run, debug] = mine;
    expect(run!.supports(config())).toBe(true);
    expect(run!.supports(config({ kind: "maven" }))).toBe(false);
    expect(debug!.supports(config({ kind: "jar-application", debugAdapter: null }))).toBe(true);
    expect(debug!.supports(config({ kind: "junit" }))).toBe(false);
    const plan = await run!.prepare(config());
    expect(plan?.launch).toMatchObject({ id: "app", executor: "hot" });

    // Disabled: gone.
    usePlugins.setState({ plugins: [plugin({ enabled: false, javaAgent: agent("Hot Reload") })] });
    expect(runExecutors().some((e) => e.id.startsWith("plugin:hot"))).toBe(false);
    stop();
  });

  it("takes the configuration from a plugin command's text argument", () => {
    expect(executorTarget("app")).toEqual({ config: "app" });
    const services = JSON.stringify({
      services: [
        { provider: "run", id: "x", kind: "folder", name: "Apps", running: false, runConfigurationId: null },
        { runConfigurationId: "app" },
      ],
    });
    expect(executorTarget(services)).toEqual({ config: "app" });
    // No configuration among the selected services, or text that is not one: the chooser.
    expect(executorTarget(JSON.stringify({ services: [{ runConfigurationId: null }] }))).toEqual({ config: "" });
    expect(executorTarget("{oops")).toEqual({ config: "" });
    expect(executorTarget({ context: true })).toEqual({ context: true });
    expect(executorTarget(undefined)).toEqual({});
  });

  it("asks for the permission, and refuses run targets, instead of launching without the agent", () => {
    const notify = vi.fn();
    provideNotificationService({ notify } as unknown as NotificationService);
    const e = { pluginId: "hot", pluginName: "Hot Reload Tools", title: "Hot Reload", approved: false };
    expect(executorLaunch(e, config())).toBeNull();
    expect(notify.mock.calls[0]![0]).toMatchObject({ title: "Hot Reload needs the Java agent of Hot Reload Tools" });
    expect(executorLaunch({ ...e, approved: true }, config({ target: "ssh-1" }))).toBeNull();
    expect(notify.mock.calls[1]![0]).toMatchObject({ title: "Cannot run 'App' with Hot Reload" });
    expect(executorLaunch({ ...e, approved: true }, config())).toMatchObject({ executor: "hot" });
  });
});
