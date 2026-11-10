/** What the Services toolbar, context menu and `docker.*` actions do with a node of a connection. */
import { writeClipboardText } from "@/platform/clipboard";
import { tx, txTemplate } from "@/platform/i18n";
import type { PruneTarget } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import { confirm, confirmChecked } from "@/workbench/messages";
import { promptText } from "./dialogs";
import { openContainerLogInEditor } from "./logEditor";
import { isRunning, nodeContainers, nodeLabel, shortId, type DockerTarget, type ServiceNode } from "./model";
import {
  composeOp,
  connectionState,
  containerOp,
  prune,
  pullImage,
  refresh,
  removeObjects,
  setDockerFilters,
  useServices,
  type DetailTab,
} from "./store";

export function canStart(t: DockerTarget | null): boolean {
  return !!t && nodeContainers(t.node).some((c) => !isRunning(c));
}
export function canStop(t: DockerTarget | null): boolean {
  return !!t && nodeContainers(t.node).some(isRunning);
}
export function canRestart(t: DockerTarget | null): boolean {
  return !!t && (t.node.kind === "container" || t.node.kind === "compose");
}
export function canRemove(t: DockerTarget | null): boolean {
  return !!t && ["container", "compose", "image", "volume", "network"].includes(t.node.kind);
}

export async function start(t: DockerTarget | null) {
  if (!t) return;
  if (t.node.kind === "compose") return composeAction(t.conn, t.node, "start");
  const ids = nodeContainers(t.node)
    .filter((c) => !isRunning(c))
    .map((c) => c.id);
  if (ids.length) await containerOp(t.conn, ids, "start");
}

export async function stop(t: DockerTarget | null) {
  if (!t) return;
  if (t.node.kind === "compose") return composeAction(t.conn, t.node, "stop");
  const ids = nodeContainers(t.node)
    .filter(isRunning)
    .map((c) => c.id);
  if (ids.length) await containerOp(t.conn, ids, "stop");
}

export async function restart(t: DockerTarget | null) {
  if (!t) return;
  if (t.node.kind === "compose") return composeAction(t.conn, t.node, "restart");
  const ids = nodeContainers(t.node).map((c) => c.id);
  if (ids.length) await containerOp(t.conn, ids, "restart");
}

function composeAction(
  conn: string,
  n: Extract<ServiceNode, { kind: "compose" }>,
  op: "start" | "stop" | "restart" | "down",
) {
  const first = n.containers[0];
  return composeOp(conn, n.project, first?.composeFiles ?? [], first?.composeWorkingDir ?? null, op).then(
    () => undefined,
  );
}

function deleteQuestion(kind: "container" | "image" | "volume" | "network", label: string, running: boolean) {
  switch (kind) {
    case "container":
      return {
        title: "Delete Container",
        message: running
          ? tx`Delete container '${label}'? It is running and will be stopped.`
          : tx`Delete container '${label}'?`,
      };
    case "image":
      return { title: "Delete Image", message: tx`Delete image '${label}'?` };
    case "volume":
      return { title: "Delete Volume", message: tx`Delete volume '${label}'?` };
    case "network":
      return { title: "Delete Network", message: tx`Delete network '${label}'?` };
  }
}

export async function remove(t: DockerTarget | null) {
  if (!t || !canRemove(t)) return;
  const n = t.node;
  const label = nodeLabel(n);
  if (n.kind === "compose") {
    const ok = await confirm({
      title: "Compose Down",
      message: tx`Stop and remove the containers and networks of '${label}'?`,
      ok: "Down",
    });
    if (ok) await composeAction(t.conn, n, "down");
    return;
  }
  if (n.kind !== "container" && n.kind !== "image" && n.kind !== "volume" && n.kind !== "network") return;
  const what = n.kind;
  const running = n.kind === "container" && isRunning(n.container);
  const answer = await confirmChecked({
    ...deleteQuestion(what, label, running),
    ok: "Delete",
    checkbox: n.kind === "image" ? "Force (also untag / remove when used by stopped containers)" : undefined,
  });
  if (!answer) return;
  const id =
    n.kind === "container"
      ? n.container.id
      : n.kind === "image"
        ? n.image.id
        : n.kind === "volume"
          ? n.volume.name
          : n.network.id;
  await removeObjects(t.conn, what, [id], running || answer.checked);
}

/** Opens a terminal tab with a shell in the container (bash when present, else sh). */
export function execShell(t: DockerTarget | null) {
  const c = t?.node.kind === "container" ? t.node.container : null;
  if (!t || !c || !isRunning(c)) return;
  const snap = connectionState(t.conn).snapshot;
  void executeAction("terminal.runCommand", {
    program: snap?.executable ?? "docker",
    args: [
      ...(snap?.globalArgs ?? []),
      "exec",
      "-it",
      c.id,
      "sh",
      "-c",
      "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
    ],
    name: c.name,
  });
}

export async function pullPrompt(conn: string) {
  const ref = await promptText("Pull Image", "Image to pull:", "e.g. postgres:16 or ghcr.io/org/app:latest");
  if (ref) await pullImage(conn, ref);
}

const PRUNE: Array<[PruneTarget, string, string]> = [
  ["containers", "Stopped Containers", "Remove all stopped containers?"],
  ["images", "Dangling Images", "Remove all dangling (untagged) images?"],
  ["allImages", "Unused Images", "Remove all images not used by a container?"],
  ["volumes", "Unused Volumes", "Remove all anonymous volumes not used by a container? Their data is lost."],
  ["networks", "Unused Networks", "Remove all networks not used by a container?"],
  [
    "system",
    "Everything Unused (System Prune)",
    "Remove stopped containers, unused networks, dangling images and the build cache?",
  ],
];

export async function prunePrompt(conn: string, target: PruneTarget) {
  const entry = PRUNE.find(([t]) => t === target);
  if (!entry) return;
  const ok = await confirm({ title: txTemplate(`Prune ${entry[1]}`), message: entry[2], ok: "Prune" });
  if (ok) await prune(conn, target);
}

function pruneLabel(target: PruneTarget): string {
  switch (target) {
    case "containers":
      return tx("Prune Unused Containers…");
    case "images":
      return tx("Prune Dangling Images…");
    case "allImages":
      return tx("Prune Unused Images…");
    case "volumes":
      return tx("Prune Unused Volumes…");
    case "networks":
      return tx("Prune Unused Networks…");
    case "system":
      return tx("Prune Everything Unused…");
  }
}

export function pruneMenu(conn: string): MenuItem[] {
  return PRUNE.map(([target, label]) => ({ label, run: () => void prunePrompt(conn, target) }));
}

const copy = (text: string) => void writeClipboardText(text);

export function showDetail(tab: DetailTab) {
  useServices.setState({ detailTab: tab });
}

export function viewFilterMenu(): MenuItem[] {
  const { filters } = useServices.getState();
  return [
    {
      label: "Stopped Containers",
      checked: filters.showStoppedContainers,
      run: () => setDockerFilters({ showStoppedContainers: !useServices.getState().filters.showStoppedContainers }),
    },
    {
      label: "Untagged Images",
      checked: filters.showUntaggedImages,
      run: () => setDockerFilters({ showUntaggedImages: !useServices.getState().filters.showUntaggedImages }),
    },
  ];
}

/** Context menu of a node of a connection's subtree. */
export function nodeMenu(t: DockerTarget): MenuItem[] {
  const { conn, node: n } = t;
  const items: MenuItem[] = [];
  if (n.kind === "container" || n.kind === "compose") {
    items.push(
      { label: "Start", icon: "run", disabled: !canStart(t), run: () => void start(t) },
      { label: "Stop", icon: "stop", disabled: !canStop(t), run: () => void stop(t) },
      { label: "Restart", icon: "rerun", run: () => void restart(t) },
    );
  }
  if (n.kind === "container") {
    const running = isRunning(n.container);
    items.push(
      n.container.state === "paused"
        ? { label: "Unpause", icon: "resume", run: () => void containerOp(conn, [n.container.id], "unpause") }
        : {
            label: "Pause",
            icon: "pause",
            disabled: !running,
            run: () => void containerOp(conn, [n.container.id], "pause"),
          },
      { kind: "separator" },
      { label: "Dashboard", icon: "layout", run: () => showDetail("dashboard") },
      { label: "Show Log", icon: "file-log", run: () => showDetail("log") },
      {
        label: "Open Log in Editor",
        icon: "external-link",
        run: () => openContainerLogInEditor(conn, n.container),
      },
      { label: "Show Processes", icon: "list", disabled: !running, run: () => showDetail("processes") },
      { label: "Inspect", icon: "info", run: () => showDetail("inspect") },
      { label: "Create Terminal", icon: "terminal", disabled: !running, run: () => execShell(t) },
      { kind: "separator" },
      { label: "Copy Container ID", icon: "copy", run: () => copy(n.container.id) },
      { label: "Copy Image Name", run: () => copy(n.container.image) },
    );
  }
  if (n.kind === "image" || n.kind === "volume" || n.kind === "network") {
    items.push({ label: "Dashboard", icon: "layout", run: () => showDetail("dashboard") });
    if (n.kind === "image") {
      items.push({ label: "Show Layers", icon: "list", run: () => showDetail("layers") });
    }
    items.push({ label: "Inspect", icon: "info", run: () => showDetail("inspect") });
    if (n.kind === "image")
      items.push(
        {
          label: "Pull Again",
          icon: "docker-pull",
          disabled: n.image.repository === "<none>",
          run: () => void pullImage(conn, nodeLabel(n)),
        },
        { label: "Copy Image ID", icon: "copy", run: () => copy(shortId(n.image.id)) },
      );
  }
  if (n.kind === "group" && n.group === "images")
    items.push({ label: "Pull Image…", icon: "docker-pull", run: () => void pullPrompt(conn) });
  if (n.kind === "group") {
    if (n.group === "containers" || n.group === "devContainers") {
      const { filters } = useServices.getState();
      items.push({
        label: "Stopped Containers",
        checked: filters.showStoppedContainers,
        run: () => setDockerFilters({ showStoppedContainers: !useServices.getState().filters.showStoppedContainers }),
      });
    } else if (n.group === "images") {
      const { filters } = useServices.getState();
      items.push({
        label: "Untagged Images",
        checked: filters.showUntaggedImages,
        run: () => setDockerFilters({ showUntaggedImages: !useServices.getState().filters.showUntaggedImages }),
      });
    }
    const target: PruneTarget =
      n.group === "containers" || n.group === "devContainers"
        ? "containers"
        : n.group === "images"
          ? "images"
          : n.group === "volumes"
            ? "volumes"
            : "networks";
    items.push({
      label: pruneLabel(target),
      run: () => void prunePrompt(conn, target),
    });
  }
  if (n.kind === "docker")
    items.push(
      { label: "Refresh", icon: "refresh", run: () => void refresh(conn) },
      { label: "Pull Image…", icon: "docker-pull", run: () => void pullPrompt(conn) },
      { label: "View Options", icon: "filter", submenu: viewFilterMenu() },
      { label: "Prune", submenu: pruneMenu(conn) },
    );
  if (canRemove(t)) {
    items.push(
      { kind: "separator" },
      {
        label: n.kind === "compose" ? "Compose Down" : "Delete…",
        icon: "trash",
        danger: true,
        run: () => void remove(t),
      },
    );
  }
  return items;
}
