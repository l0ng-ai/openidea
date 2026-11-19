/**
 * The Flutter devices of this window's project and which one launches use. The Run feature
 * shows and changes the selection, Run and Debug read it.
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { call, commands, onIdeEvent, type FlutterDevice, type FlutterDeviceList, type RunConfig } from "@/platform/ipc";
import { notifications } from "./contributions";

const SELECTED_KEY = "openidea.flutter.device:";

interface FlutterDevicesState {
  list: FlutterDeviceList | null;
  /** The device chosen in the toolbar; kept while it is disconnected, so it is used again on return. */
  preferred: string | null;
  root: string | null;
  chooserOpen: boolean;
}

export const useFlutterDevices = create<FlutterDevicesState>(() => ({
  list: null,
  preferred: null,
  root: null,
  chooserOpen: false,
}));

function storedDevice(root: string): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY + root);
  } catch {
    return null;
  }
}

export const isFlutterConfig = (c: RunConfig) =>
  c.kind === "flutter" || (c.debugAdapter === "dart" && c.params?.request === "attach");

export function usableFlutterDevices(list = useFlutterDevices.getState().list): FlutterDevice[] {
  return list?.devices.filter((d) => !d.unavailable) ?? [];
}

/** The toolbar's device: the chosen one while connected, else the best one connected. */
export function currentFlutterDevice(state = useFlutterDevices.getState()): FlutterDevice | null {
  const usable = usableFlutterDevices(state.list);
  return usable.find((d) => d.id === state.preferred) ?? usable[0] ?? null;
}

/** A `flutter run` command line: its entry point, its device and every other argument. */
export function parseFlutterRun(args: readonly string[]) {
  let entry: string | null = null;
  let device: string | null = null;
  const rest: string[] = [];
  for (let i = args[0] === "run" ? 1 : 0; i < args.length; i++) {
    const arg = args[i]!;
    const option = /^(?:-[td]|--(?:target|device-id)(?:=.*)?)$/.exec(arg)?.[0];
    if (!option) {
      rest.push(arg);
      continue;
    }
    const at = option.indexOf("=");
    const value = (at < 0 ? args[++i] : option.slice(at + 1)) || null;
    if (option === "-t" || option.startsWith("--target")) entry = value;
    else device = value;
  }
  return { entry, device, rest };
}

/** The device `rc` itself names, which wins over the toolbar. */
export function pinnedFlutterDevice(rc: RunConfig): string | null {
  const param = rc.params?.device?.trim();
  if (param) return param;
  return rc.kind === "flutter" ? parseFlutterRun(rc.args).device : null;
}

/** The `-d` value for launching `rc`; null leaves the choice to `flutter`. */
export function flutterDeviceFor(rc: RunConfig): string | null {
  return pinnedFlutterDevice(rc) ?? currentFlutterDevice()?.id ?? null;
}

/** What `flutter -d <query>` matches: an id or name, in full or by its start. */
export function matchFlutterDevice(query: string, devices: readonly FlutterDevice[]): FlutterDevice | null {
  const q = query.toLowerCase();
  return (
    devices.find((d) => d.id.toLowerCase() === q || d.name.toLowerCase() === q) ??
    devices.find((d) => d.id.toLowerCase().startsWith(q) || d.name.toLowerCase().startsWith(q)) ??
    null
  );
}

/**
 * Says so when `rc` is pinned to a device that isn't connected. The launch goes ahead: `flutter`
 * looks for the device itself, and may find one connected a moment ago.
 */
export function warnPinnedFlutterDevice(rc: RunConfig) {
  const { list } = useFlutterDevices.getState();
  const pinned = pinnedFlutterDevice(rc);
  if (!pinned || pinned === "all" || list?.status.kind !== "ready") return;
  if (matchFlutterDevice(pinned, usableFlutterDevices(list))) return;
  notifications().notify({
    group: "run",
    level: "warning",
    key: "flutter.pinnedDevice",
    title: tx`Flutter device “${pinned}” is not connected`,
    body: tx`“${rc.name}” is pinned to this device, so the launch may fail. Connect it, or change the device in the run configuration.`,
  });
}

/** Follows the project's devices (starting its `flutter daemon`) until the returned function is called. */
export function watchFlutterDevices(root: string): () => void {
  let fromEvent = false;
  const load = () => {
    fromEvent = false;
    call(commands.flutterDevices())
      .then((list) => {
        // An event that overtook the answer is newer.
        if (!fromEvent) useFlutterDevices.setState({ list });
      })
      // Restricted Mode: no daemon until the project is trusted.
      .catch(() => useFlutterDevices.setState({ list: null }));
  };
  useFlutterDevices.setState({ root, preferred: storedDevice(root), list: null });
  setContext("flutterProject", true);
  const offDevices = onIdeEvent("flutterDevices", (e) => {
    fromEvent = true;
    useFlutterDevices.setState({ list: e.list });
  });
  const offTrust = onIdeEvent("projectTrustChanged", load);
  load();
  return () => {
    offDevices();
    offTrust();
    setContext("flutterProject", false);
    useFlutterDevices.setState({ list: null, root: null, chooserOpen: false });
  };
}

export function selectFlutterDevice(id: string) {
  const { root } = useFlutterDevices.getState();
  useFlutterDevices.setState({ preferred: id });
  try {
    if (root) localStorage.setItem(SELECTED_KEY + root, id);
  } catch {
    /* the choice lasts for this session */
  }
}

export async function restartFlutterDaemon() {
  useFlutterDevices.setState({ list: await call(commands.flutterDaemonRestart()) });
}
