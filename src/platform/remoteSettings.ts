/**
 * SSH configurations, deployment servers and run targets as features consume
 * them (mirrors `ide-core::remote_settings` defaults). Normalisation never throws.
 */
export type SshAuthValid = "password" | "keyPair" | "openSsh";
export type AutoUploadValid = "never" | "onExplicitSave" | "always";

export interface SshConfigValid {
  id: string;
  name: string;
  host: string;
  port: number | null;
  user: string;
  auth: SshAuthValid;
  keyFile: string;
  saveSecret: boolean;
}

export interface DeploymentMappingValid {
  local: string;
  deployment: string;
  web: string;
}

export interface DeploymentServerValid {
  id: string;
  name: string;
  sshConfig: string;
  rootPath: string;
  webUrl: string;
  mappings: DeploymentMappingValid[];
  excludedPaths: string[];
}

export interface DeploymentSettingsValid {
  servers: DeploymentServerValid[];
  defaultServer: string;
  autoUpload: AutoUploadValid;
  deleteRemote: boolean;
  preserveTimestamps: boolean;
  exclude: string[];
}

export interface RunTargetValid {
  id: string;
  name: string;
  sshConfig: string;
  projectRoot: string;
  syncBeforeRun: boolean;
  python: string;
  node: string;
  java: string;
}

export interface RemoteSettings {
  ssh: { configs: SshConfigValid[] };
  deployment: DeploymentSettingsValid;
  runTargets: RunTargetValid[];
}

export const DEFAULT_SSH_CONFIG: SshConfigValid = {
  id: "",
  name: "",
  host: "",
  port: null,
  user: "",
  auth: "openSsh",
  keyFile: "",
  saveSecret: false,
};

export const DEFAULT_DEPLOYMENT_SERVER: DeploymentServerValid = {
  id: "",
  name: "",
  sshConfig: "",
  rootPath: "",
  webUrl: "",
  mappings: [{ local: "", deployment: "", web: "" }],
  excludedPaths: [],
};

export const DEFAULT_DEPLOYMENT: DeploymentSettingsValid = {
  servers: [],
  defaultServer: "",
  autoUpload: "never",
  deleteRemote: false,
  preserveTimestamps: true,
  exclude: [".git", ".svn", ".hg", ".idea", ".openidea", ".DS_Store", "*.pyc", "__pycache__"],
};

export const DEFAULT_RUN_TARGET: RunTargetValid = {
  id: "",
  name: "",
  sshConfig: "",
  projectRoot: "",
  syncBeforeRun: true,
  python: "",
  node: "",
  java: "",
};

export const DEFAULT_REMOTE: RemoteSettings = {
  ssh: { configs: [] },
  deployment: DEFAULT_DEPLOYMENT,
  runTargets: [],
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const strings = (v: unknown, d: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : d);
const oneOf = <T extends string>(v: unknown, values: readonly T[], d: T): T =>
  values.includes(v as T) ? (v as T) : d;
const port = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535 ? v : null;

/** Items with a unique, non-empty id (duplicates get `_` appended, missing ones `<prefix><n>`). */
function withIds<T extends { id: string }>(raw: unknown, prefix: string, item: (o: Obj) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  raw.forEach((x, i) => {
    const v = item(obj(x));
    if (!v) return;
    let id = v.id.trim() || `${prefix}${i + 1}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    out.push({ ...v, id });
  });
  return out;
}

export function validateSshConfigs(raw: unknown): SshConfigValid[] {
  const d = DEFAULT_SSH_CONFIG;
  return withIds(raw, "ssh", (o) => ({
    id: text(o.id, ""),
    name: text(o.name, ""),
    host: text(o.host, ""),
    port: port(o.port),
    user: text(o.user, ""),
    auth: oneOf(o.auth, ["password", "keyPair", "openSsh"] as const, d.auth),
    keyFile: text(o.keyFile, ""),
    saveSecret: bool(o.saveSecret, d.saveSecret),
  }));
}

function validateMappings(raw: unknown): DeploymentMappingValid[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const o = obj(m);
    return { local: text(o.local, ""), deployment: text(o.deployment, ""), web: text(o.web, "") };
  });
}

export function validateDeployment(raw: unknown): DeploymentSettingsValid {
  const o = obj(raw);
  const d = DEFAULT_DEPLOYMENT;
  const servers = withIds(o.servers, "server", (s) => ({
    id: text(s.id, ""),
    name: text(s.name, ""),
    sshConfig: text(s.sshConfig, ""),
    rootPath: text(s.rootPath, ""),
    webUrl: text(s.webUrl, ""),
    mappings: validateMappings(s.mappings),
    excludedPaths: strings(s.excludedPaths, []),
  }));
  return {
    servers,
    defaultServer: text(o.defaultServer, d.defaultServer),
    autoUpload: oneOf(o.autoUpload, ["never", "onExplicitSave", "always"] as const, d.autoUpload),
    deleteRemote: bool(o.deleteRemote, d.deleteRemote),
    preserveTimestamps: bool(o.preserveTimestamps, d.preserveTimestamps),
    exclude: strings(o.exclude, d.exclude),
  };
}

export function validateRunTargets(raw: unknown): RunTargetValid[] {
  const d = DEFAULT_RUN_TARGET;
  return withIds(raw, "target", (o) => ({
    id: text(o.id, ""),
    name: text(o.name, ""),
    sshConfig: text(o.sshConfig, ""),
    projectRoot: text(o.projectRoot, ""),
    syncBeforeRun: bool(o.syncBeforeRun, d.syncBeforeRun),
    python: text(o.python, ""),
    node: text(o.node, ""),
    java: text(o.java, ""),
  }));
}

export function validateRemote(root: unknown): RemoteSettings {
  const o = obj(root);
  return {
    ssh: { configs: validateSshConfigs(obj(o.ssh).configs) },
    deployment: validateDeployment(o.deployment),
    runTargets: validateRunTargets(o.runTargets),
  };
}

/** `user@host:port` with what is known (the name when the host is empty). */
export function sshLabel(c: Pick<SshConfigValid, "name" | "host" | "port" | "user">): string {
  const host = c.host.trim();
  if (!host) return c.name;
  return `${c.user.trim() ? `${c.user.trim()}@` : ""}${host}${c.port ? `:${c.port}` : ""}`;
}

let seq = 0;
/** A fresh id for a new SSH configuration, server or target. */
export const newRemoteId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;
