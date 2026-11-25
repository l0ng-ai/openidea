import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlutterDevice, RunConfig } from "@/platform/ipc";
import { provideNotificationService } from "@/workbench/contributions";
import { matchFlutterDevice, useFlutterDevices } from "@/workbench/flutterDevices";
import { supportsHotReload } from "./flutterHotReload";
import { flutterType } from "./flutterType";

const device = (id: string, name: string, unavailable: string | null = null): FlutterDevice => ({
  id,
  name,
  platformType: null,
  category: "mobile",
  emulator: false,
  unavailable,
});

const config = (args: string[]): RunConfig => ({
  id: "flutter:run",
  name: "flutter run",
  kind: "flutter",
  command: "flutter",
  args: ["run", "-t", "lib/main.dart", ...args],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "dart",
});

describe("Flutter run configurations", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    provideNotificationService({ notify });
    useFlutterDevices.setState({
      preferred: "macos",
      list: { status: { kind: "ready" }, devices: [device("macos", "macOS"), device("X1", "Pixel", "unauthorized")] },
    });
  });
  afterEach(() => useFlutterDevices.setState({ preferred: null, list: null }));

  it("builds the command line from the form and reads it back", () => {
    const params = {
      entry: "lib/dev.dart",
      device: "chrome",
      mode: "profile",
      flavor: "dev",
      arguments: "--dart-define=KEY=value",
    };
    const line = flutterType.commandLine(params)!;
    expect(line).toEqual({
      command: "flutter",
      args: ["run", "-t", "lib/dev.dart", "-d", "chrome", "--profile", "--flavor=dev", "--dart-define=KEY=value"],
    });
    expect(flutterType.paramsFrom!({ ...config([]), ...line })).toEqual(params);
    expect(flutterType.commandLine({ entry: "lib/main.dart", mode: "" })!.args).toEqual(["run", "-t", "lib/main.dart"]);
  });

  it("hot reloads only in debug mode", () => {
    const withMode = (mode: string) => ({ ...config([]), ...flutterType.commandLine({ mode, flavor: "dev" })! });
    expect(supportsHotReload(withMode(""))).toBe(true);
    expect(supportsHotReload(withMode("profile"))).toBe(false);
    expect(supportsHotReload(withMode("release"))).toBe(false);
  });

  it("reproduces the command line of an imported Flutter plugin configuration", () => {
    // What the JetBrains importer stores for a configuration with Additional attach args.
    const params = {
      entry: "lib/main_dev.dart",
      flavor: "dev",
      arguments: '--dart-define=API="https://dev.example" --verbose',
      attachArgs: "--debug-port 9000",
    };
    expect(flutterType.commandLine(params)!.args).toEqual([
      "run",
      "-t",
      "lib/main_dev.dart",
      "--flavor=dev",
      "--dart-define=API=https://dev.example",
      "--verbose",
    ]);
  });

  it("reads the build mode and flavor from any spelling", () => {
    const params = flutterType.paramsFrom!(config(["--debug", "--flavor", "staging", "--release", "-v"]));
    expect(params).toEqual({ entry: "lib/main.dart", mode: "release", flavor: "staging", arguments: "-v" });
  });

  it("reads the = spellings back into the form without repeating them on save", () => {
    const args = ["run", "--target=lib/dev.dart", "--device-id=chrome", "--dart-define=CFG=dev.dart"];
    const params = flutterType.paramsFrom!({ ...config([]), args })!;
    expect(params).toEqual({ entry: "lib/dev.dart", device: "chrome", arguments: "--dart-define=CFG=dev.dart" });
    expect(flutterType.commandLine(params)!.args).toEqual([
      "run",
      "-t",
      "lib/dev.dart",
      "-d",
      "chrome",
      "--dart-define=CFG=dev.dart",
    ]);
  });

  it("runs on the toolbar's device, with --machine", async () => {
    const launch = await flutterType.prepareLaunch!(config([]));
    expect(launch.args.slice(-3)).toEqual(["-d", "macos", "--machine"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps a pinned device and warns when it is not connected", async () => {
    const pinned = config(["-d", "X1"]);
    expect((await flutterType.prepareLaunch!(pinned)).args).toEqual([...pinned.args, "--machine"]);
    const machine = config(["-d", "X1", "--machine"]);
    expect((await flutterType.prepareLaunch!(machine)).args).toEqual(machine.args);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "warning", key: "flutter.pinnedDevice" }));
  });

  it("does not warn before discovery has finished", async () => {
    useFlutterDevices.setState({ list: { status: { kind: "starting" }, devices: [] } });
    await flutterType.prepareLaunch!(config(["-d", "macos"]));
    expect(notify).not.toHaveBeenCalled();
  });

  it("matches a pinned device the way flutter -d does", () => {
    const devices = [device("00008110-AB", "Sam's iPhone"), device("macos", "macOS")];
    expect(matchFlutterDevice("MACOS", devices)?.id).toBe("macos");
    expect(matchFlutterDevice("sam", devices)?.id).toBe("00008110-AB");
    expect(matchFlutterDevice("00008110", devices)?.id).toBe("00008110-AB");
    expect(matchFlutterDevice("chrome", devices)).toBeNull();
  });
});
