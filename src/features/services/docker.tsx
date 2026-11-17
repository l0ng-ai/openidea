/**
 * Docker as a Services tree provider: one root per connection (containers
 * grouped by Compose project, images, volumes, networks) and one per registry;
 * log / inspect of the selection in the detail pane.
 */
import { writeClipboardText } from "@/platform/clipboard";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Channel } from "@tauri-apps/api/core";
import type {
  DockerAvailability,
  DockerConnection,
  DockerContainer,
  DockerEndpoint,
  DockerLogLine,
  DockerObject,
  DockerRegistry,
} from "@/platform/ipc";
import { tx, useTx, useTxTemplate } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { Button, EmptyState, IconButton, LogPane, Spinner, Tabs, T } from "@/ui";
import type { MenuItem } from "@/ui";
import {
  notifications,
  type ServiceItemAction,
  type ServiceProviderContribution,
  type ServiceTreeItem,
} from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { openConnectionDialog, openRegistryDialog } from "./dialogs";
import {
  DEFAULT_DOCKER_FILTERS,
  DOCKER_KEY,
  childrenOf,
  connectionKey,
  findNode,
  isRunning,
  nodeDetail,
  nodeIcon,
  nodeLabel,
  parseTreeKey,
  registryKey,
  rootNodes,
  treeKey,
  type DockerFilters,
  type DockerTarget,
  type ServiceNode,
} from "./model";
import {
  ComposeProjectDashboard,
  ContainerDashboard,
  ContainerProcessesView,
  ImageDashboard,
  ImageLayersView,
  NetworkDashboard,
  VolumeDashboard,
} from "./dashboard";
import { openContainerLogInEditor } from "./logEditor";
import {
  canRemove,
  canRestart,
  canStart,
  canStop,
  execShell,
  nodeMenu,
  pullPrompt,
  remove,
  restart,
  start,
  stop,
} from "./ops";
import {
  cancelTask,
  connectionState,
  endpointOf,
  errorMessage,
  refresh,
  removeConnection,
  removeRegistry,
  testRegistryLogin,
  useServices,
  watch,
  type ConnectionState,
  type DetailTab,
} from "./store";
import { useServicesTree } from "./tree";
import styles from "./Services.module.css";

export const DOCKER_PROVIDER = "docker";
const REGISTRY_PREFIX = "docker-registry:";

function endpointText(ep: DockerEndpoint): string {
  switch (ep.kind) {
    case "default":
      return "Docker CLI default";
    case "socket":
      return ep.path;
    case "tcp":
      return ep.tlsCertDir ? `${ep.host} (TLS)` : ep.host;
    case "context":
      return `context ${ep.name}`;
  }
}

function connectionDetail(state: ConnectionState): string | undefined {
  const a = state.snapshot?.availability;
  if (!a) return state.error ?? (state.loading ? "connecting…" : undefined);
  if (a.kind === "notInstalled") return "docker not installed";
  if (a.kind === "daemonDown") return "not running";
  return a.context ?? undefined;
}

/** The Docker part of the Services tree. */
export function dockerItems(
  connections: readonly DockerConnection[],
  registries: readonly DockerRegistry[],
  conns: Record<string, ConnectionState>,
  filters: DockerFilters = DEFAULT_DOCKER_FILTERS,
): ServiceTreeItem[] {
  const items: ServiceTreeItem[] = connections.map((c) => {
    const state = conns[c.id] ?? { snapshot: null, loading: false, error: null };
    const snap = state.snapshot;
    const children = childrenOf(snap, filters);
    const convert = (n: ServiceNode): ServiceTreeItem => {
      const kids = children(n);
      return {
        key: treeKey(c.id, n),
        label: nodeLabel(n),
        icon: nodeIcon(n),
        detail: nodeDetail(n),
        dim: n.kind === "container" && !isRunning(n.container),
        children: kids?.map(convert),
      };
    };
    const root = rootNodes()[0]!;
    return {
      key: connectionKey(c.id),
      label: c.name,
      icon: snap?.availability.kind === "ready" ? "docker-connected" : "file-docker",
      detail: connectionDetail(state),
      dim: snap?.availability.kind !== "ready",
      // A connection the user just added opens once, so its groups are in sight.
      expanded: true,
      children: children(root)?.map(convert) ?? [],
    };
  });
  for (const r of registries)
    items.push({ key: registryKey(r.id), label: r.name, icon: "docker-registry", detail: r.address });
  return items;
}

/** The connection node a tree key stands for. */
export function resolveTarget(key: string | null): DockerTarget | null {
  const parsed = key ? parseTreeKey(key) : null;
  if (!parsed) return null;
  if (parsed.local === DOCKER_KEY) return { conn: parsed.conn, node: rootNodes()[0]! };
  const node = findNode(connectionState(parsed.conn).snapshot, parsed.local);
  return node ? { conn: parsed.conn, node } : null;
}

const registryOf = (key: string | null) =>
  key?.startsWith(REGISTRY_PREFIX)
    ? (useServices.getState().settings?.registries.find((r) => registryKey(r.id) === key) ?? null)
    : null;

const connectionOf = (id: string) => useServices.getState().settings?.connections.find((c) => c.id === id) ?? null;

/** The selected Docker node (for the `docker.*` actions). */
export const selectedTarget = () => resolveTarget(useServicesTree.getState().selectedKey);

async function testLogin(r: DockerRegistry) {
  try {
    const answer = await testRegistryLogin(r, null);
    notifications().notify({ group: "run", level: "info", title: `${r.name}: ${answer}`, key: "docker-login" });
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: `Cannot log in to ${r.name}`,
      body: errorMessage(e),
      key: "docker-login",
    });
  }
}

async function removeConnectionPrompt(c: DockerConnection) {
  if (
    await confirm({
      title: "Remove Docker Connection",
      message: tx`Remove the connection '${c.name}' from Services?`,
      ok: "Remove",
    })
  )
    await removeConnection(c.id);
}

async function removeRegistryPrompt(r: DockerRegistry) {
  if (
    await confirm({
      title: "Remove Docker Registry",
      message: tx`Remove the registry '${r.name}' and its saved password?`,
      ok: "Remove",
    })
  )
    await removeRegistry(r.id);
}

function actions(item: ServiceTreeItem): ServiceItemAction[] {
  if (item.key.startsWith(REGISTRY_PREFIX)) return [];
  const t = resolveTarget(item.key);
  if (!t) return [];
  const container = t.node.kind === "container" ? t.node.container : null;
  return [
    { id: "refresh", title: "Refresh", icon: "refresh", run: () => void refresh(t.conn) },
    { id: "start", title: "Start", icon: "run", disabled: !canStart(t), run: () => void start(t) },
    { id: "stop", title: "Stop", icon: "stop", disabled: !canStop(t), run: () => void stop(t) },
    { id: "restart", title: "Restart", icon: "rerun", disabled: !canRestart(t), run: () => void restart(t) },
    { id: "delete", title: "Delete", icon: "trash", disabled: !canRemove(t), run: () => void remove(t) },
    {
      id: "terminal",
      title: "Create Terminal",
      icon: "terminal",
      disabled: !container || !isRunning(container),
      run: () => execShell(t),
    },
    { id: "pull", title: "Pull Image…", icon: "docker-pull", run: () => void pullPrompt(t.conn) },
  ];
}

function menu(item: ServiceTreeItem): MenuItem[] {
  const r = registryOf(item.key);
  if (r)
    return [
      { label: "Edit Registry…", icon: "edit", run: () => openRegistryDialog(r) },
      { label: "Test Login", run: () => void testLogin(r) },
      { kind: "separator" },
      { label: "Remove Registry", icon: "trash", danger: true, run: () => void removeRegistryPrompt(r) },
    ];
  const t = resolveTarget(item.key);
  if (!t) return [];
  const items = nodeMenu(t);
  const c = t.node.kind === "docker" ? connectionOf(t.conn) : null;
  if (c)
    items.push(
      { kind: "separator" },
      { label: "Edit Connection…", icon: "edit", run: () => openConnectionDialog(c) },
      { label: "Remove Connection", icon: "trash", danger: true, run: () => void removeConnectionPrompt(c) },
    );
  return items;
}

// ---------------------------------------------------------------------------
// Detail pane

/** Status instead of the tree when docker cannot be used. */
function Unavailable({ availability, conn }: { availability: DockerAvailability; conn: string }) {
  if (availability.kind === "notInstalled")
    return (
      <EmptyState title="Docker is not installed">
        <T>Install Docker Desktop, OrbStack, Colima or the Docker Engine and make sure</T> <code>docker</code>{" "}
        <T>is on PATH.</T>
      </EmptyState>
    );
  if (availability.kind === "daemonDown")
    return (
      <EmptyState
        title="Docker is not running"
        actions={<IconButton icon="refresh" title="Retry" onClick={() => void refresh(conn)} />}
      >
        <div>{availability.message}</div>
        <div className={styles.hint}>
          {availability.context
            ? tx`Start Docker (context '${availability.context}'); this view connects automatically.`
            : tx`Start Docker; this view connects automatically.`}
        </div>
      </EmptyState>
    );
  return null;
}

export function DockerTaskBanner() {
  const task = useServices((s) => s.task);
  const txTemplate = useTxTemplate();
  if (!task) return null;
  return (
    <div className={styles.banner} role="status">
      <Spinner size={12} />
      <span className={styles.bannerTitle}>{txTemplate(task.title)}</span>
      <span className={styles.bannerText}>{task.line}</span>
      <IconButton icon="close" size="small" title="Cancel" onClick={cancelTask} />
    </div>
  );
}

/** Follows a container's log while shown. */
function LogView({ conn, container, running }: { conn: string; container: DockerContainer; running: boolean }) {
  const tx = useTx();
  const id = container.id;
  return (
    <div className={styles.detailBody}>
      <LogPane
        sourceKey={`${conn}:${id}:${running}`}
        live={running}
        toggles={[{ id: "timestamps", label: "Timestamps" }]}
        actions={
          <IconButton
            icon="external-link"
            size="small"
            title="Open Log in Editor"
            onClick={() => openContainerLogInEditor(conn, container)}
          />
        }
        ariaLabel={tx("Container log")}
        start={(onLine, onError, on) => {
          const request = nextRequestId();
          const channel = new Channel<DockerLogLine>();
          channel.onmessage = onLine;
          call(commands.dockerLogs(request, endpointOf(conn), id, 1000, running, on.has("timestamps"), channel)).catch(
            (e) => {
              if (!isCancelled(e)) onError(errorMessage(e));
            },
          );
          return () => void commands.cancelRequest(request);
        }}
      />
    </div>
  );
}

function useObjectInspect(conn: string, object: DockerObject | null, id: string | null) {
  const [state, setState] = useState<{ key: string; text: string | null; error: string | null }>({
    key: "",
    text: null,
    error: null,
  });
  const currentKey = object && id ? `${conn}:${object}:${id}` : "";
  useEffect(() => {
    if (!object || !id) return;
    const reqKey = `${conn}:${object}:${id}`;
    let alive = true;
    call(commands.dockerInspect(endpointOf(conn), object, id))
      .then((t) => alive && setState({ key: reqKey, text: t, error: null }))
      .catch((e) => alive && setState({ key: reqKey, text: null, error: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [conn, object, id]);
  return state.key === currentKey ? { text: state.text, error: state.error } : { text: null, error: null };
}

function InspectView({ text, error }: { text: string | null; error: string | null }) {
  const tx = useTx();
  return (
    <div className={styles.detailBody}>
      <div className={styles.subToolbar}>
        <span className={styles.subToolbarTitle}>
          <T>Inspect JSON</T>
        </span>
        <IconButton
          icon="copy"
          size="small"
          title="Copy"
          disabled={!text}
          onClick={() => text && void writeClipboardText(text)}
        />
      </div>
      <pre
        tabIndex={0}
        onKeyDown={copySelectionOnKeyDown}
        className={clsx(styles.log, styles.json)}
        aria-label={tx("Inspect")}
      >
        {error ?? text ?? tx("Loading…")}
      </pre>
    </div>
  );
}

function RegistryDetail({ registry }: { registry: DockerRegistry }) {
  return (
    <div className={styles.detailPane}>
      <dl className={styles.facts}>
        <dt>
          <T>Name</T>
        </dt>
        <dd>{registry.name}</dd>
        <dt>
          <T>Address</T>
        </dt>
        <dd>{registry.address}</dd>
        <dt>
          <T>Username</T>
        </dt>
        <dd>{registry.username || "—"}</dd>
      </dl>
      <div className={styles.detailActions}>
        <Button onClick={() => openRegistryDialog(registry)}>Edit…</Button>
        <Button disabled={!registry.username} onClick={() => void testLogin(registry)}>
          Test Login
        </Button>
      </div>
    </div>
  );
}

function DockerDetail({ item }: { item: ServiceTreeItem }) {
  const txTemplate = useTxTemplate();
  const tab = useServices((s) => s.detailTab);
  const settings = useServices((s) => s.settings);
  const parsed = parseTreeKey(item.key);
  const state = useServices((s) => (parsed ? connectionState(parsed.conn, s) : null));
  const target = resolveTarget(item.key);
  const registry = settings?.registries.find((r) => registryKey(r.id) === item.key);
  const node = target?.node ?? null;
  const object: DockerObject | null =
    node && (node.kind === "container" || node.kind === "image" || node.kind === "volume" || node.kind === "network")
      ? node.kind
      : null;
  const objectId =
    node?.kind === "container"
      ? node.container.id
      : node?.kind === "image"
        ? node.image.id
        : node?.kind === "volume"
          ? node.volume.name
          : node?.kind === "network"
            ? node.network.id
            : null;
  const inspect = useObjectInspect(parsed?.conn ?? "default", object, objectId);

  if (registry) return <RegistryDetail registry={registry} />;
  if (!target || !parsed || !state || !node) return <EmptyState title="Select service to view details" />;
  const conn = connectionOf(parsed.conn);
  const snapshot = state.snapshot;
  if (!snapshot)
    return (
      <div className={styles.loading}>
        {state.error ?? (
          <>
            <Spinner size={14} /> <T>Connecting to Docker…</T>
          </>
        )}
      </div>
    );
  if (snapshot.availability.kind !== "ready")
    return <Unavailable availability={snapshot.availability} conn={parsed.conn} />;
  if (node.kind === "compose") {
    return (
      <div className={styles.detailPane}>
        <ComposeProjectDashboard conn={parsed.conn} project={node.project} containers={node.containers} />
      </div>
    );
  }
  if (node.kind === "docker" || node.kind === "group") {
    const a = snapshot.availability;
    return (
      <div className={styles.detailPane}>
        {snapshot.errors.length > 0 && (
          <div className={clsx(styles.banner, styles.warning)}>
            <span className={styles.bannerText}>{snapshot.errors.join("; ")}</span>
          </div>
        )}
        <EmptyState title={conn?.name ?? "Docker"}>
          <div>
            {txTemplate(`Engine ${a.serverVersion} · CLI ${a.clientVersion}`)}
            {a.context ? txTemplate(` · context ${a.context}`) : ""}
          </div>
          {conn && <div className={styles.hint}>{endpointText(conn.endpoint)}</div>}
          <div className={styles.hint}>
            <T>Select a container, image, volume or network.</T>
          </div>
        </EmptyState>
      </div>
    );
  }

  const tabItems: Array<{ id: DetailTab; label: string }> =
    node.kind === "container"
      ? [
          { id: "dashboard", label: "Dashboard" },
          { id: "log", label: "Log" },
          { id: "processes", label: "Processes" },
          { id: "inspect", label: "Inspect" },
        ]
      : node.kind === "image"
        ? [
            { id: "dashboard", label: "Dashboard" },
            { id: "layers", label: "Layers" },
            { id: "inspect", label: "Inspect" },
          ]
        : [
            { id: "dashboard", label: "Dashboard" },
            { id: "inspect", label: "Inspect" },
          ];

  const activeId: DetailTab = tabItems.some((t) => t.id === tab) ? tab : "dashboard";
  const id = objectId!;

  return (
    <div className={styles.detailPane}>
      <Tabs
        variant="compact"
        activeId={activeId}
        onSelect={(t) => useServices.setState({ detailTab: t as DetailTab })}
        aria-label="Details"
        items={tabItems}
      />
      {activeId === "log" && node.kind === "container" ? (
        <LogView key={id} conn={parsed.conn} container={node.container} running={isRunning(node.container)} />
      ) : activeId === "processes" && node.kind === "container" ? (
        <ContainerProcessesView key={id} conn={parsed.conn} id={id} running={isRunning(node.container)} />
      ) : activeId === "layers" && node.kind === "image" ? (
        <ImageLayersView key={id} conn={parsed.conn} id={id} />
      ) : activeId === "inspect" ? (
        <InspectView key={id} text={inspect.text} error={inspect.error} />
      ) : node.kind === "container" ? (
        <ContainerDashboard
          key={id}
          conn={parsed.conn}
          container={node.container}
          snapshot={snapshot}
          inspectText={inspect.text}
        />
      ) : node.kind === "image" ? (
        <ImageDashboard key={id} conn={parsed.conn} image={node.image} snapshot={snapshot} inspectText={inspect.text} />
      ) : node.kind === "volume" ? (
        <VolumeDashboard key={id} conn={parsed.conn} volume={node.volume} snapshot={snapshot} />
      ) : (
        <NetworkDashboard
          key={id}
          conn={parsed.conn}
          network={node.network}
          snapshot={snapshot}
          inspectText={inspect.text}
        />
      )}
    </div>
  );
}

function useRoots(): ServiceTreeItem[] {
  const settings = useServices((s) => s.settings);
  const conns = useServices((s) => s.conns);
  const filters = useServices((s) => s.filters);
  return useMemo(
    () => dockerItems(settings?.connections ?? [], settings?.registries ?? [], conns, filters),
    [settings, conns, filters],
  );
}

export const dockerProvider: ServiceProviderContribution = {
  id: DOCKER_PROVIDER,
  order: 10,
  useRoots,
  watch,
  actions,
  menu,
  activate: (item) => {
    const t = resolveTarget(item.key);
    if (t?.node.kind === "container") useServices.setState({ detailTab: "log" });
    const r = registryOf(item.key);
    if (r) openRegistryDialog(r);
  },
  detail: DockerDetail,
  banner: DockerTaskBanner,
  addMenu: () => [
    { label: "Docker Registry…", icon: "docker-registry", run: () => openRegistryDialog() },
    { label: "Docker Connection…", icon: "file-docker", run: () => openConnectionDialog() },
  ],
};
