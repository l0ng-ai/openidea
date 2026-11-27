import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ fsEntryKind: vi.fn(), runApplySettings: vi.fn() }));
const run = vi.hoisted(() => ({
  startRun: vi.fn(),
  state: { configs: [] as unknown[], selectedId: null as string | null },
}));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  commands: ipc,
}));
vi.mock("./store", () => ({ startRun: run.startRun, useRun: { getState: () => run.state } }));

import { useActions, type ActionContext } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { setContext } from "@/platform/context";
import { provideNotificationService, useMenuSlotItems } from "@/workbench/contributions";
import { registerFlutterBuildActions } from "./flutterBuild";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const missing = () => Promise.resolve({ status: "error" as const, error: { kind: "notFound", message: "" } });
const flutterConfig = (id: string, cwd: string | null) =>
  ({ id, kind: "flutter", command: "flutter", args: ["run"], cwd, debugAdapter: "dart" }) as unknown as RunConfig;
const action = (id: string) => useActions.getState().actions.get(id)!;
const ctx = {} as ActionContext;
/** The command lines started so far: `[cwd, command, ...args]`. */
const started = () => run.startRun.mock.calls.map(([c]) => [c.cwd, c.command, ...c.args] as (string | null)[]);

let files: Set<string>;
let exitCode: number;
const notify = vi.fn();
let dispose: () => void;
beforeEach(() => {
  files = new Set();
  exitCode = 0;
  useProject.setState({ project: { root: "/p", trusted: true } as never });
  usePlatform.setState({ os: "macos" });
  run.state = {
    configs: [flutterConfig("flutter:run", null), flutterConfig("app/flutter:run", "app")],
    selectedId: null,
  };
  ipc.fsEntryKind.mockImplementation((path: string) => (files.has(path) ? ok("dir") : missing()));
  ipc.runApplySettings.mockImplementation((configs: RunConfig[]) => ok(configs));
  run.startRun.mockImplementation(async (_c, _r, _b, options: { onExit: (code: number, stopped: boolean) => void }) => {
    setTimeout(() => options.onExit(exitCode, false));
    return {};
  });
  provideNotificationService({ notify } as never);
  dispose = registerFlutterBuildActions();
});
afterEach(() => {
  dispose();
  vi.clearAllMocks();
  useProject.setState({ project: null });
});

it("runs flutter build in the selected Flutter configuration's package", async () => {
  expect(action("flutter.build.apk").when).toBe("flutterProject");
  action("flutter.build.apk").run(ctx);
  await vi.waitFor(() => expect(started()).toEqual([["/p", "flutter", "build", "apk"]]));

  run.state.selectedId = "app/flutter:run";
  action("flutter.build.aab").run(ctx);
  action("flutter.build.web").run(ctx);
  await vi.waitFor(() => expect(started()).toHaveLength(3));
  expect(started().slice(1)).toEqual([
    ["/p/app", "flutter", "build", "appbundle"],
    ["/p/app", "flutter", "build", "web"],
  ]);
});

it("lists Build › Flutter in the native menu only in Flutter projects", () => {
  const listed = () => (useMenuSlotItems.getState().slots.flutterBuild ?? []).map((i) => i.label);
  expect(listed()).toEqual([]);
  setContext("flutterProject", true);
  expect(listed()).toEqual([
    "Build APK",
    "Build App Bundle",
    "Build iOS",
    "Build Web",
    "Open iOS/macOS Module in Xcode",
    "Open Android Module in Android Studio",
  ]);
  setContext("flutterProject", false);
  expect(listed()).toEqual([]);

  // No Xcode or `open -a` elsewhere.
  dispose();
  usePlatform.setState({ os: "linux" });
  dispose = registerFlutterBuildActions();
  setContext("flutterProject", true);
  expect(listed()).toEqual(["Build APK", "Build App Bundle", "Build iOS", "Build Web"]);
  dispose();
  expect(listed()).toEqual([]);
  dispose = () => {};
  setContext("flutterProject", false);
});

it("offers iOS builds and the Xcode / Android Studio actions only on macOS", () => {
  const ids = ["flutter.build.ios", "flutter.xcode.open", "flutter.androidstudio.open"];
  expect(ids.map((id) => action(id).enabled!(ctx))).toEqual([true, true, true]);
  usePlatform.setState({ os: "linux" });
  expect(ids.map((id) => action(id).enabled!(ctx))).toEqual([false, false, false]);
  expect(action("flutter.build.apk").enabled!(ctx)).toBe(true);
});

it("opens the iOS workspace in Xcode, configuring the module first when Flutter has not", async () => {
  files = new Set(["/p/ios/Runner.xcworkspace", "/p/ios/Runner.xcodeproj"]);
  action("flutter.xcode.open").run(ctx);
  await vi.waitFor(() => expect(started()).toHaveLength(2));
  expect(started()).toEqual([
    ["/p", "flutter", "build", "ios", "--config-only"],
    ["/p", "open", "-a", "Xcode", "ios/Runner.xcworkspace"],
  ]);

  // Configured already, no workspace yet (before `pod install`): the project itself.
  run.startRun.mockClear();
  files = new Set(["/p/ios/Runner.xcodeproj", "/p/ios/Flutter/Generated.xcconfig"]);
  action("flutter.xcode.open").run(ctx);
  await vi.waitFor(() => expect(started()).toEqual([["/p", "open", "-a", "Xcode", "ios/Runner.xcodeproj"]]));
});

it("does not open Xcode when configuring the module fails", async () => {
  files = new Set(["/p/ios/Runner.xcworkspace"]);
  exitCode = 1;
  action("flutter.xcode.open").run(ctx);
  await vi.waitFor(() => expect(started()).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 10));
  expect(started()).toHaveLength(1);
});

it("reports a missing module or application instead of failing silently", async () => {
  action("flutter.xcode.open").run(ctx);
  action("flutter.androidstudio.open").run(ctx);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  expect(notify.mock.calls.map(([n]) => n.title).sort()).toEqual(["No Android module found", "No Xcode project found"]);
  expect(run.startRun).not.toHaveBeenCalled();

  files = new Set(["/p/android"]);
  exitCode = 1;
  action("flutter.androidstudio.open").run(ctx);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
  expect(started()).toEqual([["/p", "open", "-a", "Android Studio", "android"]]);
  expect(notify.mock.calls[2]![0].title).toBe("Could not open Android Studio");
});
