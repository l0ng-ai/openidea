/**
 * `flutter run --machine`, as the Flutter plugin runs apps: stdout is JSON-RPC, one bracketed
 * array of messages per line, as from `flutter daemon`. The events keep the Run tab's app in
 * `useFlutterRunApps` (its id, device, VM Service and whether it started), and the console
 * shows the app's own output and the tool's messages as plain lines.
 */
import type { RunConfig } from "@/platform/ipc";
import { useFlutterRunApps, type FlutterRunApp } from "@/workbench/flutterRunApps";
import { TestStdout } from "./testing/types";

export const isFlutterMachineRun = (c: RunConfig) =>
  c.kind === "flutter" && c.args[0] === "run" && c.args.includes("--machine");

type Params = Record<string, unknown>;

const text = (v: unknown) => (typeof v === "string" ? v : null);
const line = (v: unknown) => {
  const s = text(v);
  return s ? (s.endsWith("\n") ? s : `${s}\n`) : "";
};

function patch(session: string, p: Partial<FlutterRunApp>) {
  const app = useFlutterRunApps.getState()[session];
  if (app) useFlutterRunApps.setState({ [session]: { ...app, ...p } });
}

/** The console text of one message. */
function message(session: string, m: { event?: unknown; params?: Params; result?: unknown; error?: unknown }) {
  const p = m.params ?? {};
  switch (m.event) {
    case "app.start":
      patch(session, { appId: text(p.appId), device: text(p.deviceId), supportsRestart: p.supportsRestart === true });
      return "";
    case "app.debugPort":
      patch(session, { vmServiceUri: text(p.wsUri) ?? undefined });
      return "";
    case "app.started":
      patch(session, { started: true });
      return "";
    case "app.stop":
      patch(session, { started: false });
      return line(p.error);
    case "app.log":
    case "daemon.logMessage":
      return line(p.log ?? p.message);
    case "app.progress":
      return p.finished ? "" : line(p.message);
    case undefined: {
      // The answer to `app.restart`: only a failure says something.
      if (m.error) return line(typeof m.error === "string" ? m.error : JSON.stringify(m.error));
      const result = m.result as { code?: unknown; message?: unknown } | null | undefined;
      return result && result.code !== 0 ? line(result.message) : "";
    }
    default:
      return "";
  }
}

/** The console text of a stdout line; lines outside the protocol show as they are. */
export function machineLine(session: string, raw: string): string {
  if (!raw.startsWith("[{")) return `${raw}\n`;
  let messages: unknown;
  try {
    messages = JSON.parse(raw);
  } catch {
    return `${raw}\n`;
  }
  if (!Array.isArray(messages)) return `${raw}\n`;
  return messages.map((m) => message(session, m ?? {})).join("");
}

/** Starts following the app of a Run tab about to launch `config`; the result decodes its stdout. */
export function flutterMachineOutput(session: string, config: RunConfig): TestStdout {
  useFlutterRunApps.setState({
    [session]: {
      session,
      name: config.name,
      appId: null,
      device: null,
      started: false,
      supportsRestart: false,
      live: true,
      startedAt: Date.now(),
    },
  });
  return new TestStdout(
    () => undefined,
    (raw) => machineLine(session, raw),
  );
}
