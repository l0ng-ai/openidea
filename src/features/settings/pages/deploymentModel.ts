/** Pure edits behind the Deployment settings pages (server list, mappings, exclude names). */
import {
  DEFAULT_DEPLOYMENT_SERVER,
  newRemoteId,
  type DeploymentMappingValid,
  type DeploymentServerValid,
} from "@/platform/remoteSettings";

/** `.git;.idea; *.pyc` → `[".git", ".idea", "*.pyc"]` (trimmed, no blanks or duplicates). */
export function parseExcludes(text: string): string[] {
  return [
    ...new Set(
      text
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function formatExcludes(names: readonly string[]): string {
  return names.join(";");
}

export function updateMapping(
  mappings: readonly DeploymentMappingValid[],
  index: number,
  patch: Partial<DeploymentMappingValid>,
): DeploymentMappingValid[] {
  return mappings.map((m, i) => (i === index ? { ...m, ...patch } : m));
}

export function addMapping(mappings: readonly DeploymentMappingValid[]): DeploymentMappingValid[] {
  return [...mappings, { local: "", deployment: "", web: "" }];
}

export function removeMapping(mappings: readonly DeploymentMappingValid[], index: number): DeploymentMappingValid[] {
  return mappings.filter((_, i) => i !== index);
}

/** "Server 3" — the first free "Server <n>" name. */
export function nextServerName(servers: readonly DeploymentServerValid[]): string {
  const names = new Set(servers.map((s) => s.name));
  let n = servers.length + 1;
  while (names.has(`Server ${n}`)) n++;
  return `Server ${n}`;
}

/** A new server, or a copy of `base` with a fresh id. */
export function newServer(
  servers: readonly DeploymentServerValid[],
  base?: DeploymentServerValid,
): DeploymentServerValid {
  if (base)
    return {
      ...base,
      id: newRemoteId("server"),
      name: `${base.name} (copy)`,
      mappings: base.mappings.map((m) => ({ ...m })),
      excludedPaths: [...base.excludedPaths],
    };
  return {
    ...DEFAULT_DEPLOYMENT_SERVER,
    id: newRemoteId("server"),
    name: nextServerName(servers),
    mappings: DEFAULT_DEPLOYMENT_SERVER.mappings.map((m) => ({ ...m })),
  };
}

/** The default server after `servers` changed: kept when still present, else the first one (or none). */
export function fixDefaultServer(servers: readonly DeploymentServerValid[], defaultServer: string): string {
  if (servers.some((s) => s.id === defaultServer)) return defaultServer;
  return servers[0]?.id ?? "";
}

/** Parent of an absolute remote folder (`/` stays `/`). */
export function remoteParent(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}
