/**
 * Remote debug run configurations: the debugger attaches to a process started
 * elsewhere (another machine, a container) over host:port, like IDEA's Remote JVM
 * Debug, GoLand's Go Remote, PyCharm's remote debugpy and IDEA's Attach to Node.js.
 * Only Debug applies to them (`debugOnly`); they launch no process.
 */
import type { LaunchConfig, RunConfig } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import type { RunConfigTypeContribution, RunConfigTypeField } from "@/workbench/contributions";

export const REMOTE_JVM = "remote-jvm";
export const GO_REMOTE = "go-remote";
export const PYTHON_REMOTE = "python-remote";
export const NODE_REMOTE = "node-remote";

type Params = Readonly<Record<string, string>>;

/** A TCP port, or null. */
export function parsePort(value: string | undefined): number | null {
  const v = (value ?? "").trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? n : null;
}

const hostField: RunConfigTypeField = { key: "host", label: "Host", mono: true, required: true };
const portField: RunConfigTypeField = {
  key: "port",
  label: "Port",
  mono: true,
  required: true,
  validate: (v) => (parsePort(v) == null ? "Port must be a number from 1 to 65535" : null),
};

const hostOf = (p: Params) => p.host?.trim() || "localhost";
const portOf = (p: Params, fallback: number) => parsePort(p.port) ?? fallback;

// ---------------------------------------------------------------------------
// Remote JVM Debug

export type JdwpMode = "attach" | "listen";
export type JdkVersion = "9" | "5" | "1.4";

/**
 * The agent the remote JVM is started with, as IDEA shows it ("Command line arguments
 * for remote JVM"). Attach: the JVM listens (`server=y`); JDK 9+ binds only to localhost
 * unless the address names a host, hence `*:`. Listen: the JVM connects to the IDE.
 */
export function jdwpAgentArgs(p: Params): string {
  const mode: JdwpMode = p.mode === "listen" ? "listen" : "attach";
  const jdk = (p.jdk || "9") as JdkVersion;
  const port = portOf(p, 5005);
  const opts =
    mode === "listen"
      ? `transport=dt_socket,server=n,address=${hostOf(p)}:${port},suspend=y`
      : `transport=dt_socket,server=y,suspend=n,address=${jdk === "9" ? "*:" : ""}${port}`;
  return jdk === "1.4" ? `-Xdebug -Xrunjdwp:${opts}` : `-agentlib:jdwp=${opts}`;
}

const JVM_KINDS = new Set(["application", "spring-boot", "maven", "gradle", "java-file"]);

export const remoteJvmType: RunConfigTypeContribution = {
  id: REMOTE_JVM,
  label: "Remote JVM Debug",
  icon: "attach-to-process",
  description: "Attach the debugger to a JVM started with a JDWP agent, here or on another machine",
  defaults: { mode: "attach", host: "localhost", port: "5005", jdk: "9" },
  debugOnly: true,
  debugAdapter: "java-debug",
  fields: [
    {
      key: "mode",
      label: "Debugger mode",
      control: "select",
      options: [
        { value: "attach", label: "Attach to remote JVM" },
        { value: "listen", label: "Listen to remote JVM" },
      ],
    },
    hostField,
    portField,
    {
      key: "jdk",
      label: "JDK version of the remote JVM",
      control: "select",
      options: [
        { value: "9", label: "JDK 9 or later" },
        { value: "5", label: "JDK 5 - 8" },
        { value: "1.4", label: "JDK 1.4.x" },
      ],
    },
    {
      key: "args",
      label: "Command line arguments for remote JVM",
      control: "output",
      mono: true,
      value: jdwpAgentArgs,
      hint: "Add to the remote JVM's command line (or JAVA_TOOL_OPTIONS)",
    },
    {
      key: "module",
      label: "Use module classpath",
      mono: true,
      placeholder: "Project root",
      hint: "Module directory whose sources the debugger shows",
      suggestions: (configs) => [...new Set(configs.filter((c) => JVM_KINDS.has(c.kind) && c.cwd).map((c) => c.cwd!))],
    },
  ],
  commandLine: () => null,
};

// ---------------------------------------------------------------------------
// Go Remote (Delve headless server)

/** How to start the remote side, as GoLand shows it. */
export function delveServerCommand(p: Params): string {
  return `dlv debug --headless --listen=:${portOf(p, 2345)} --api-version=2 --accept-multiclient`;
}

const localRootField: RunConfigTypeField = {
  key: "localRoot",
  label: "Local root",
  mono: true,
  placeholder: "Project root",
};

const remoteRootField = (placeholder: string): RunConfigTypeField => ({
  key: "remoteRoot",
  label: "Remote root",
  mono: true,
  placeholder,
  hint: "Where the project's sources are on the remote machine, when the paths differ",
});

export const goRemoteType: RunConfigTypeContribution = {
  id: GO_REMOTE,
  label: "Go Remote",
  icon: "file-go",
  description: "Attach to a Delve server (dlv --headless) here or on another machine",
  defaults: { host: "localhost", port: "2345" },
  debugOnly: true,
  debugAdapter: "delve",
  fields: [
    hostField,
    portField,
    {
      key: "hint",
      label: "Start the remote side with",
      control: "output",
      mono: true,
      value: delveServerCommand,
      hint: "Delve 1.7.3 or later; dlv exec ./app or dlv attach <pid> take the same flags",
    },
    localRootField,
    remoteRootField("e.g. /go/src/app"),
  ],
  commandLine: () => null,
};

// ---------------------------------------------------------------------------
// Python remote (debugpy --listen)

export function debugpyServerCommand(p: Params): string {
  return `python -m debugpy --listen 0.0.0.0:${portOf(p, 5678)} --wait-for-client app.py`;
}

export const pythonRemoteType: RunConfigTypeContribution = {
  id: PYTHON_REMOTE,
  label: "Python Remote Debug (debugpy)",
  icon: "file-python",
  description: "Attach to a Python process listening with debugpy here or on another machine",
  defaults: { host: "localhost", port: "5678" },
  debugOnly: true,
  debugAdapter: "debugpy",
  fields: [
    hostField,
    portField,
    {
      key: "hint",
      label: "Start the remote side with",
      control: "output",
      mono: true,
      value: debugpyServerCommand,
      hint: "pip install debugpy on the remote machine",
    },
    localRootField,
    remoteRootField("e.g. /app"),
  ],
  commandLine: () => null,
};

// ---------------------------------------------------------------------------
// Attach to Node.js (inspector)

export function nodeInspectCommand(p: Params): string {
  return `node --inspect=0.0.0.0:${portOf(p, 9229)} app.js`;
}

export const nodeRemoteType: RunConfigTypeContribution = {
  id: NODE_REMOTE,
  label: "Attach to Node.js",
  icon: "file-js",
  description: "Attach to a Node.js process started with --inspect here or on another machine",
  defaults: { host: "localhost", port: "9229" },
  debugOnly: true,
  debugAdapter: "js-debug",
  fields: [
    hostField,
    portField,
    {
      key: "hint",
      label: "Start the remote side with",
      control: "output",
      mono: true,
      value: nodeInspectCommand,
    },
    localRootField,
    remoteRootField("e.g. /usr/src/app"),
  ],
  commandLine: () => null,
};

export const REMOTE_TYPES: readonly RunConfigTypeContribution[] = [
  remoteJvmType,
  goRemoteType,
  pythonRemoteType,
  nodeRemoteType,
];

export const isRemoteConfig = (c: Pick<RunConfig, "kind">) => REMOTE_TYPES.some((t) => t.id === c.kind);

// ---------------------------------------------------------------------------
// Attach requests

function isAbsolute(p: string) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function join(base: string, p: string) {
  if (isAbsolute(p)) return p;
  const rel = p.replace(/^\.\//, "");
  return rel === "." || rel === "" ? base : `${base.replace(/[\\/]$/, "")}/${rel}`;
}

/** Local root (absolute) ↔ remote root, or null when the paths are the same on both sides. */
function rootMapping(p: Params, root: string): { local: string; remote: string } | null {
  const remote = p.remoteRoot?.trim();
  if (!remote) return null;
  const local = p.localRoot?.trim() ? join(root, p.localRoot.trim()) : root;
  return { local, remote };
}

/** `host:port` for `debugServer` (IPv6 literals in brackets). */
export function serverAddress(host: string, port: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

function attachBase(rc: RunConfig, adapter: string, root: string, extra: Record<string, unknown>): LaunchConfig {
  return {
    name: rc.name,
    adapter,
    request: "attach",
    program: null,
    args: [],
    cwd: root,
    env: {},
    extraJson: JSON.stringify(extra),
  };
}

/**
 * The attach request of a Go / Python / Node.js remote configuration. Delve's headless
 * server and `debugpy --listen` speak DAP themselves (`debugServer` connects there);
 * js-debug runs here and connects to the inspector.
 */
export function remoteAttachConfig(rc: RunConfig, root: string): LaunchConfig | null {
  const p = rc.params ?? {};
  const host = hostOf(p);
  const map = rootMapping(p, root);
  const skip = workflowSettings().debugger.skipLibraryCode;
  switch (rc.kind) {
    case GO_REMOTE:
      return attachBase(rc, "delve", root, {
        debugServer: serverAddress(host, portOf(p, 2345)),
        mode: "remote",
        ...(map ? { substitutePath: [{ from: map.local, to: map.remote }] } : {}),
      });
    case PYTHON_REMOTE:
      return attachBase(rc, "debugpy", root, {
        debugServer: serverAddress(host, portOf(p, 5678)),
        justMyCode: skip,
        ...(map ? { pathMappings: [{ localRoot: map.local, remoteRoot: map.remote }] } : {}),
      });
    case NODE_REMOTE:
      return attachBase(rc, "js-debug", root, {
        type: "pwa-node",
        address: host,
        port: portOf(p, 9229),
        ...(map ? { localRoot: map.local, remoteRoot: map.remote } : {}),
        skipFiles: skip ? ["<node_internals>/**", "**/node_modules/**"] : [],
      });
    default:
      return null;
  }
}

/** What a Remote JVM Debug configuration attaches to (before the listen mode relay). */
export function remoteJvmTarget(rc: RunConfig): { mode: JdwpMode; host: string; port: number; module: string } {
  const p = rc.params ?? {};
  return {
    mode: p.mode === "listen" ? "listen" : "attach",
    host: hostOf(p),
    port: portOf(p, 5005),
    module: p.module?.trim() ?? "",
  };
}
