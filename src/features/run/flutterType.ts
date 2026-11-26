/** Flutter run configurations: `flutter run` on the pinned device, else the toolbar's. */
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import {
  flutterDeviceFor,
  parseFlutterRun,
  pinnedFlutterDevice,
  usableFlutterDevices,
  warnPinnedFlutterDevice,
} from "@/workbench/flutterDevices";
import { commandName } from "./commandName";
import { formatArgs, parseArgs } from "./configs";

const DEFAULT_ENTRY = "lib/main.dart";
const MODES = new Set(["--debug", "--profile", "--release"]);

/** The executable of Flutter / Dart commands: the one place that picks it. */
export const dartTool = (flutter: boolean) => (flutter ? "flutter" : "dart");

export const flutterType: RunConfigTypeContribution = {
  id: "flutter",
  label: "Flutter",
  icon: "project-flutter",
  description: "Run a Flutter app on a device",
  debugAdapter: "dart",
  defaults: { entry: DEFAULT_ENTRY },
  fields: [
    { key: "entry", label: "Dart entrypoint", mono: true, browse: "file", placeholder: DEFAULT_ENTRY },
    {
      key: "device",
      label: "Device",
      mono: true,
      placeholder: "The device selected in the toolbar",
      hint: "A device id pins this configuration to that device",
      suggestions: () => usableFlutterDevices().map((d) => d.id),
    },
    {
      key: "mode",
      label: "Build mode",
      control: "select",
      options: [
        { value: "", label: "Debug" },
        { value: "profile", label: "Profile" },
        { value: "release", label: "Release" },
      ],
    },
    { key: "flavor", label: "Build flavor", mono: true, placeholder: "e.g. dev" },
    {
      key: "arguments",
      label: "Additional run args",
      mono: true,
      placeholder: "e.g. --dart-define=KEY=value",
    },
    {
      key: "attachArgs",
      label: "Additional attach args",
      mono: true,
      hint: "Passed to flutter attach by Flutter Attach",
    },
  ],
  commandLine: (p) => ({
    command: p.executable || dartTool(true),
    args: [
      "run",
      "-t",
      p.entry?.trim() || DEFAULT_ENTRY,
      ...(p.device?.trim() ? ["-d", p.device.trim()] : []),
      ...(p.mode === "profile" || p.mode === "release" ? [`--${p.mode}`] : []),
      ...(p.flavor?.trim() ? [`--flavor=${p.flavor.trim()}`] : []),
      ...parseArgs(p.arguments ?? ""),
    ],
  }),
  paramsFrom(c) {
    if (commandName(c.command) !== "flutter" || c.args[0] !== "run") return null;
    const { entry, device, rest } = parseFlutterRun(c.args);
    let mode = "";
    let flavor = "";
    const other: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (MODES.has(arg)) mode = arg === "--debug" ? "" : arg.slice(2);
      else if (arg === "--flavor") flavor = rest[++i] ?? "";
      else if (arg.startsWith("--flavor=")) flavor = arg.slice("--flavor=".length);
      else other.push(arg);
    }
    return {
      entry: entry ?? DEFAULT_ENTRY,
      ...(device ? { device } : {}),
      ...(mode ? { mode } : {}),
      ...(flavor ? { flavor } : {}),
      ...(c.command !== "flutter" ? { executable: c.command } : {}),
      arguments: formatArgs(other),
    };
  },
  async prepareLaunch(config) {
    warnPinnedFlutterDevice(config);
    const device = pinnedFlutterDevice(config) ? null : flutterDeviceFor(config);
    // As the Flutter plugin runs apps: hot reload and DevTools go through the JSON protocol.
    const machine = config.args[0] === "run" && !config.args.includes("--machine") ? ["--machine"] : [];
    return { ...config, args: [...config.args, ...(device ? ["-d", device] : []), ...machine] };
  },
};
