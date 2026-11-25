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

export const flutterType: RunConfigTypeContribution = {
  id: "flutter",
  label: "Flutter",
  icon: "project-flutter",
  description: "Run a Flutter app on a device",
  debugAdapter: "dart",
  defaults: { entry: DEFAULT_ENTRY },
  fields: [
    { key: "entry", label: "Entry point", mono: true, browse: "file", placeholder: DEFAULT_ENTRY },
    {
      key: "device",
      label: "Device",
      mono: true,
      placeholder: "The device selected in the toolbar",
      hint: "A device id pins this configuration to that device",
      suggestions: () => usableFlutterDevices().map((d) => d.id),
    },
    {
      key: "arguments",
      label: "Additional arguments",
      mono: true,
      placeholder: "e.g. --flavor dev --dart-define=KEY=value",
    },
  ],
  commandLine: (p) => ({
    command: p.executable || "flutter",
    args: [
      "run",
      "-t",
      p.entry?.trim() || DEFAULT_ENTRY,
      ...(p.device?.trim() ? ["-d", p.device.trim()] : []),
      ...parseArgs(p.arguments ?? ""),
    ],
  }),
  paramsFrom(c) {
    if (commandName(c.command) !== "flutter" || c.args[0] !== "run") return null;
    const { entry, device, rest } = parseFlutterRun(c.args);
    return {
      entry: entry ?? DEFAULT_ENTRY,
      ...(device ? { device } : {}),
      ...(c.command !== "flutter" ? { executable: c.command } : {}),
      arguments: formatArgs(rest),
    };
  },
  async prepareLaunch(config) {
    warnPinnedFlutterDevice(config);
    const device = pinnedFlutterDevice(config) ? null : flutterDeviceFor(config);
    return device ? { ...config, args: [...config.args, "-d", device] } : config;
  },
};
