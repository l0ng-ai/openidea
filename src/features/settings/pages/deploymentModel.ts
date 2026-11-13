/** Pure edits behind the Deployment settings pages (server list, mappings, exclude names). */
import {
  DEFAULT_DEPLOYMENT_SERVER,
  newRemoteId,
  type DeploymentGroupValid,
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

/** A new, empty group named "Group <n>" (the first free number). */
export function newGroup(groups: readonly DeploymentGroupValid[]): DeploymentGroupValid {
  const names = new Set(groups.map((g) => g.name));
  let n = groups.length + 1;
  while (names.has(`Group ${n}`)) n++;
  return { id: newRemoteId("group"), name: `Group ${n}`, servers: [] };
}

/** Adds or removes `server` in `group`, keeping the members in the server list's order. */
export function toggleGroupServer(
  group: DeploymentGroupValid,
  server: string,
  servers: readonly DeploymentServerValid[],
): DeploymentGroupValid {
  const members = new Set(group.servers);
  if (members.has(server)) members.delete(server);
  else members.add(server);
  return { ...group, servers: servers.map((s) => s.id).filter((id) => members.has(id)) };
}

/** `groups` without members that are no longer in `servers`. */
export function pruneGroups(
  groups: readonly DeploymentGroupValid[],
  servers: readonly DeploymentServerValid[],
): DeploymentGroupValid[] {
  const ids = new Set(servers.map((s) => s.id));
  return groups.map((g) =>
    g.servers.every((id) => ids.has(id)) ? g : { ...g, servers: g.servers.filter((id) => ids.has(id)) },
  );
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

/** `path` relative to the folder `root` ("" for `root` itself), for a chosen mapping folder; null outside it. */
export function folderWithin(root: string, path: string): string | null {
  const r = root.replace(/\/+$/, "");
  const p = path.replace(/\/+$/, "");
  if (!r) return null;
  if (p === r) return "";
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}
