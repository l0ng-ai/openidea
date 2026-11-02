/**
 * Docker as a Services tree provider: one root per connection (containers
 * grouped by Compose project, images, volumes, networks) and one per registry;
 * log / inspect of the selection in the detail pane.
 */
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Channel } from "@tauri-apps/api/core";
import type {
  DockerAvailability,
  DockerConnection,
  DockerEndpoint,
  DockerLogLine,
  DockerObject,
  DockerRegistry,
} from "@/platform/ipc";
import { tx, useTx, useTxTemplate } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { Button, EmptyState, IconButton, Spinner, Tabs, Toggle, T } from "@/ui";
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
  type DockerTarget,
  type ServiceNode,
} from "./model";
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
): ServiceTreeItem[] {
  const items: ServiceTreeItem[] = connections.map((c) => {
    const state = conns[c.id] ?? { snapshot: null, loading: false, error: null };
    const snap = state.snapshot;
    const children = childrenOf(snap);
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
      icon: "file-docker",
      detail: connectionDetail(state),
      dim: snap?.availability.kind !== "ready",
      children: children(root)?.map(convert) ?? [],
    };
  });
  for (const r of registries) items.push({ key: registryKey(r.id), label: r.name, icon: "package", detail: r.address });
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
    { id: "pull", title: "Pull Image…", icon: "git-pull", run: () => void pullPrompt(t.conn) },
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

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
const MAX_LINES = 5000;

/** Follows a container's log while shown. */
function LogView({ conn, id, running }: { conn: string; id: string; running: boolean }) {
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(true);
  // A new stream (and buffer) per option set.
  return (
    <LogStream
      key={`${running}:${timestamps}`}
      endpoint={endpointOf(conn)}
      id={id}
      running={running}
      timestamps={timestamps}
      setTimestamps={setTimestamps}
      wrap={wrap}
      setWrap={setWrap}
    />
  );
}

function LogStream(props: {
  endpoint: DockerEndpoint;
  id: string;
  running: boolean;
  timestamps: boolean;
  setTimestamps: (v: boolean) => void;
  wrap: boolean;
  setWrap: (v: boolean) => void;
}) {
  const tx = useTx();
  const { endpoint, id, running, timestamps, setTimestamps, wrap, setWrap } = props;
  const [lines, setLines] = useState<DockerLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const ep = useRef(endpoint);

  useEffect(() => {
    const request = nextRequestId();
    const channel = new Channel<DockerLogLine>();
    let buffer: DockerLogLine[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const add = buffer;
      buffer = [];
      setLines((prev) => {
        const next = prev.concat(add);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    channel.onmessage = (line) => {
      buffer.push({ stderr: line.stderr, text: line.text.replace(ANSI, "") });
      frame ||= requestAnimationFrame(flush);
    };
    call(commands.dockerLogs(request, ep.current, id, 1000, running, timestamps, channel)).catch((e) => {
      if (!isCancelled(e)) setError(errorMessage(e));
    });
    return () => {
      cancelAnimationFrame(frame);
      void commands.cancelRequest(request);
    };
  }, [id, running, timestamps]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className={styles.detailBody}>
      <div className={styles.subToolbar}>
        <Toggle checked={timestamps} onChange={setTimestamps} label="Timestamps" />
        <Toggle checked={wrap} onChange={setWrap} label="Soft-wrap" />
        <span className={styles.flex} />
        <IconButton icon="trash" size="small" title="Clear" onClick={() => setLines([])} />
      </div>
      <div
        ref={scroller}
        className={clsx(styles.log, wrap && styles.wrap)}
        tabIndex={0}
        role="log"
        onKeyDown={copySelectionOnKeyDown}
        aria-label={tx("Container log")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className={clsx(l.stderr && styles.stderr)}>
            {l.text || " "}
          </div>
        ))}
        {error && <div className={styles.stderr}>{error}</div>}
        {!lines.length && !error && (
          <div className={styles.dim}>{tx(running ? "Waiting for output…" : "No output")}</div>
        )}
      </div>
    </div>
  );
}

function InspectView({ conn, object, id }: { conn: string; object: DockerObject; id: string }) {
  const tx = useTx();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    call(commands.dockerInspect(endpointOf(conn), object, id))
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [conn, object, id]);
  return (
    <div className={styles.detailBody}>
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
  if (registry) return <RegistryDetail registry={registry} />;
  if (!target || !parsed || !state) return <EmptyState title="Select service to view details" />;
  const conn = connectionOf(parsed.conn);
  const node = target.node;
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
  if (node.kind === "docker" || node.kind === "group" || node.kind === "compose") {
    const a = snapshot.availability;
    return (
      <div className={styles.detailPane}>
        {snapshot.errors.length > 0 && (
          <div className={clsx(styles.banner, styles.warning)}>
            <span className={styles.bannerText}>{snapshot.errors.join("; ")}</span>
          </div>
        )}
        <EmptyState
          title={node.kind === "compose" ? txTemplate(`Compose project '${node.project}'`) : (conn?.name ?? "Docker")}
        >
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
  const object: DockerObject = node.kind;
  const id =
    node.kind === "container"
      ? node.container.id
      : node.kind === "image"
        ? node.image.id
        : node.kind === "volume"
          ? node.volume.name
          : node.network.id;
  const showLog = node.kind === "container" && tab === "log";
  return (
    <div className={styles.detailPane}>
      <Tabs
        variant="compact"
        activeId={showLog ? "log" : "inspect"}
        onSelect={(t) => useServices.setState({ detailTab: t as "log" | "inspect" })}
        aria-label="Details"
        items={[
          ...(node.kind === "container" ? [{ id: "log", label: "Log" }] : []),
          { id: "inspect", label: "Inspect" },
        ]}
      />
      {showLog ? (
        <LogView key={id} conn={parsed.conn} id={id} running={isRunning(node.container)} />
      ) : (
        <InspectView key={id} conn={parsed.conn} object={object} id={id} />
      )}
    </div>
  );
}

function useRoots(): ServiceTreeItem[] {
  const settings = useServices((s) => s.settings);
  const conns = useServices((s) => s.conns);
  return useMemo(() => dockerItems(settings?.connections ?? [], settings?.registries ?? [], conns), [settings, conns]);
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
    { label: "Docker Registry…", icon: "package", run: () => openRegistryDialog() },
    { label: "Docker Connection…", icon: "file-docker", run: () => openConnectionDialog() },
  ],
};
