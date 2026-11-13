/** The Services tree (Docker → Containers / Images / Volumes / Networks), built from a snapshot. */
import { tx } from "@/platform/i18n";
import type { DockerContainer, DockerImage, DockerNetwork, DockerSnapshot, DockerVolume } from "@/platform/ipc";

export type GroupKind = "devContainers" | "containers" | "images" | "networks" | "volumes";

export interface DockerFilters {
  showStoppedContainers: boolean;
  showUntaggedImages: boolean;
}

export const DEFAULT_DOCKER_FILTERS: DockerFilters = {
  showStoppedContainers: true,
  showUntaggedImages: true,
};

export type ServiceNode =
  | { kind: "docker"; key: string }
  | { kind: "group"; key: string; group: GroupKind; count: number }
  | { kind: "compose"; key: string; project: string; containers: DockerContainer[] }
  | { kind: "container"; key: string; container: DockerContainer }
  | { kind: "image"; key: string; image: DockerImage }
  | { kind: "volume"; key: string; volume: DockerVolume }
  | { kind: "network"; key: string; network: DockerNetwork };

export const DOCKER_KEY = "docker";
const GROUPS: Array<[GroupKind, string]> = [
  ["devContainers", "Dev Containers"],
  ["containers", "Containers"],
  ["images", "Images"],
  ["networks", "Networks"],
  ["volumes", "Volumes"],
];

export const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

export function isRunning(c: DockerContainer): boolean {
  return c.state === "running" || c.state === "restarting" || c.state === "paused";
}

export function isDevContainer(c: DockerContainer): boolean {
  const labels = c.labels;
  if (!labels) return false;
  return (
    "devcontainer.local_folder" in labels || "com.intellij.devcontainer.id" in labels || "vsch.local.folder" in labels
  );
}

export function isUntaggedImage(i: DockerImage): boolean {
  return (!i.repository || i.repository === "<none>") && (!i.tag || i.tag === "<none>");
}

export function imageRef(i: DockerImage): string {
  if (!i.repository || i.repository === "<none>") return shortId(i.id);
  return !i.tag || i.tag === "<none>" ? i.repository : `${i.repository}:${i.tag}`;
}

/**
 * The local key of an image node. `docker images` lists every tag of one image
 * on its own row with the same id, so the reference keeps the keys unique.
 */
export function imageKey(i: DockerImage): string {
  return `image:${i.id}:${imageRef(i)}`;
}

export function rootNodes(): ServiceNode[] {
  return [{ kind: "docker", key: DOCKER_KEY }];
}

function composeProjects(snap: DockerSnapshot, filters: DockerFilters): ServiceNode[] {
  const projects = new Map<string, DockerContainer[]>();
  for (const c of snap.containers) {
    if (c.composeProject) projects.set(c.composeProject, [...(projects.get(c.composeProject) ?? []), c]);
  }
  return [...projects.entries()]
    .filter(([, containers]) => filters.showStoppedContainers || containers.some(isRunning))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, containers]) => ({
      kind: "compose" as const,
      key: `compose:${project}`,
      project,
      containers: [...containers].sort((a, b) =>
        (a.composeService ?? a.name).localeCompare(b.composeService ?? b.name),
      ),
    }));
}

/** Children lookup over one snapshot (stable node objects per snapshot). */
export function childrenOf(
  snap: DockerSnapshot | null,
  filters: DockerFilters = DEFAULT_DOCKER_FILTERS,
): (n: ServiceNode) => ServiceNode[] | undefined {
  const cache = new Map<string, ServiceNode[] | undefined>();
  const compute = (n: ServiceNode): ServiceNode[] | undefined => {
    if (!snap || snap.availability.kind !== "ready") return undefined;
    switch (n.kind) {
      case "docker":
        return [
          ...composeProjects(snap, filters),
          ...GROUPS.map(([group]) => ({
            kind: "group" as const,
            key: `group:${group}`,
            group,
            count: groupCount(snap, group, filters),
          })),
        ];
      case "group":
        return groupChildren(snap, n.group, filters);
      case "compose": {
        const list = filters.showStoppedContainers ? n.containers : n.containers.filter(isRunning);
        return list.map(containerNode);
      }
      default:
        return undefined;
    }
  };
  return (n) => {
    if (!cache.has(n.key)) cache.set(n.key, compute(n));
    return cache.get(n.key);
  };
}

function groupCount(snap: DockerSnapshot, g: GroupKind, filters: DockerFilters = DEFAULT_DOCKER_FILTERS): number {
  if (g === "devContainers") {
    return snap.containers.filter(
      (c) => !c.composeProject && isDevContainer(c) && (filters.showStoppedContainers || isRunning(c)),
    ).length;
  }
  if (g === "containers") {
    return snap.containers.filter(
      (c) => !c.composeProject && !isDevContainer(c) && (filters.showStoppedContainers || isRunning(c)),
    ).length;
  }
  if (g === "images") {
    return filters.showUntaggedImages ? snap.images.length : snap.images.filter((i) => !isUntaggedImage(i)).length;
  }
  return g === "volumes" ? snap.volumes.length : snap.networks.length;
}

const containerNode = (c: DockerContainer): ServiceNode => ({
  kind: "container",
  key: `container:${c.id}`,
  container: c,
});

/** Children of one group node (`Dev Containers`, `Containers`, `Images`, `Networks`, `Volumes`). */
export function groupChildren(
  snap: DockerSnapshot,
  g: GroupKind,
  filters: DockerFilters = DEFAULT_DOCKER_FILTERS,
): ServiceNode[] {
  switch (g) {
    case "devContainers":
      return snap.containers
        .filter((c) => !c.composeProject && isDevContainer(c) && (filters.showStoppedContainers || isRunning(c)))
        .map(containerNode);
    case "containers":
      return snap.containers
        .filter((c) => !c.composeProject && !isDevContainer(c) && (filters.showStoppedContainers || isRunning(c)))
        .map(containerNode);
    case "images": {
      const imgs = filters.showUntaggedImages ? snap.images : snap.images.filter((i) => !isUntaggedImage(i));
      const seen = new Set<string>();
      return imgs.flatMap((image): ServiceNode[] => {
        const key = imageKey(image);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ kind: "image", key, image }];
      });
    }
    case "volumes":
      return snap.volumes.map((volume) => ({ kind: "volume", key: `volume:${volume.name}`, volume }));
    case "networks":
      return snap.networks.map((network) => ({ kind: "network", key: `network:${network.id}`, network }));
  }
}

/** Whether `container.image` refers to `image`. */
export function containerMatchesImage(c: DockerContainer, image: DockerImage): boolean {
  const ref = imageRef(image);
  if (c.image === ref || c.image === image.id || c.image === shortId(image.id)) return true;
  if (image.tag === "latest" && c.image === image.repository) return true;
  const cleanId = image.id.replace(/^sha256:/, "");
  const cleanTarget = c.image.replace(/^sha256:/, "");
  return cleanTarget.length >= 12 && cleanId.startsWith(cleanTarget);
}

/** Containers in `snap` created from `image`. */
export function containersUsingImage(snap: DockerSnapshot, image: DockerImage): DockerContainer[] {
  return snap.containers.filter((c) => containerMatchesImage(c, image));
}

/** All `repo:tag` references in `snap` that share `image.id`. */
export function imageTagsForId(snap: DockerSnapshot, image: DockerImage): string[] {
  const tags = snap.images.filter((i) => i.id === image.id && !isUntaggedImage(i)).map(imageRef);
  return [...new Set(tags)];
}

/** The `DockerImage` in `snap` that `container` runs, if present locally. */
export function findImageForContainer(snap: DockerSnapshot, container: DockerContainer): DockerImage | null {
  return snap.images.find((i) => containerMatchesImage(container, i)) ?? null;
}

/** Containers in `snap` mounting `volume`. */
export function containersUsingVolume(snap: DockerSnapshot, volume: DockerVolume): DockerContainer[] {
  return snap.containers.filter((c) => c.mounts?.includes(volume.name));
}

/** Containers in `snap` attached to `network`. */
export function containersInNetwork(snap: DockerSnapshot, network: DockerNetwork): DockerContainer[] {
  return snap.containers.filter((c) => c.networks?.includes(network.name));
}

export function nodeLabel(n: ServiceNode): string {
  switch (n.kind) {
    case "docker":
      return "Docker";
    case "group":
      return tx(GROUPS.find(([g]) => g === n.group)![1]);
    case "compose":
      return `Docker-compose: ${n.project}`;
    case "container":
      return n.container.composeService && n.container.composeProject ? n.container.composeService : n.container.name;
    case "image":
      return imageRef(n.image);
    case "volume":
      return n.volume.name;
    case "network":
      return n.network.name;
  }
}

export function nodeDetail(n: ServiceNode): string | undefined {
  switch (n.kind) {
    case "group":
      return n.count ? String(n.count) : undefined;
    case "compose": {
      const up = n.containers.filter(isRunning).length;
      return `${up}/${n.containers.length} running`;
    }
    case "container":
      return `${n.container.status}${n.container.composeService ? ` · ${n.container.name}` : ` · ${n.container.image}`}`;
    case "image":
      return `${n.image.size} · ${n.image.createdSince}`;
    case "volume":
      return n.volume.driver;
    case "network":
      return n.network.driver;
    default:
      return undefined;
  }
}

function groupIcon(g: GroupKind): string {
  switch (g) {
    case "devContainers":
      return "docker-devcontainer";
    case "containers":
      return "docker-containers";
    case "images":
      return "docker-images";
    case "networks":
      return "docker-networks";
    case "volumes":
      return "docker-volumes";
  }
}

export function nodeIcon(n: ServiceNode): string {
  switch (n.kind) {
    case "docker":
      return "docker-connected";
    case "group":
      return groupIcon(n.group);
    case "compose":
      return n.containers.some(isRunning) ? "docker-compose-running" : "docker-compose-stopped";
    case "container":
      if (isDevContainer(n.container)) return "docker-devcontainer";
      if (n.container.composeProject) {
        return isRunning(n.container) ? "docker-compose-service-running" : "docker-compose-service-stopped";
      }
      return n.container.state === "paused"
        ? "pause"
        : isRunning(n.container)
          ? "docker-container-running"
          : "docker-container-stopped";
    case "image":
      return "docker-image";
    case "volume":
      return "docker-volumes";
    case "network":
      return "docker-networks";
  }
}

/** The containers a node stands for (a compose project's, or one). */
export function nodeContainers(n: ServiceNode): DockerContainer[] {
  return n.kind === "container" ? [n.container] : n.kind === "compose" ? n.containers : [];
}

/** Finds the node with `key` in a fresh snapshot (selection survives refreshes). */
export function findNode(snap: DockerSnapshot | null, key: string | null): ServiceNode | null {
  if (!snap || !key) return null;
  const children = childrenOf(snap);
  const walk = (nodes: readonly ServiceNode[]): ServiceNode | null => {
    for (const n of nodes) {
      if (n.key === key) return n;
      const found = walk(children(n) ?? []);
      if (found) return found;
    }
    return null;
  };
  return walk(rootNodes());
}

// ---------------------------------------------------------------------------
// Keys in the Services tree: every connection has its own subtree.

/** A node of one connection's subtree. */
export interface DockerTarget {
  conn: string;
  node: ServiceNode;
}

export const connectionKey = (conn: string) => `docker:${conn}`;
export const registryKey = (id: string) => `docker-registry:${id}`;

/** The tree key of `node` (whose key is local to its snapshot) under connection `conn`. */
export function treeKey(conn: string, node: ServiceNode): string {
  return node.kind === "docker" ? connectionKey(conn) : `${connectionKey(conn)}:${node.key}`;
}

/** Splits a tree key into connection id and local node key. */
export function parseTreeKey(key: string): { conn: string; local: string } | null {
  if (!key.startsWith("docker:")) return null;
  const rest = key.slice("docker:".length);
  const i = rest.indexOf(":");
  return i < 0 ? { conn: rest, local: DOCKER_KEY } : { conn: rest.slice(0, i), local: rest.slice(i + 1) };
}
