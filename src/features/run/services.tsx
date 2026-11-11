/**
 * Run configurations in the Services tool window (IDEA's Run Dashboard): the
 * configuration types added there ("Add Service › Run Configuration Type"), one
 * group each, with run / debug / stop / rerun per configuration. Nothing else is
 * listed, and what is removed leaves at once; a run it started keeps its console
 * in the Run tool window. A configuration that ran shows its console in the
 * detail pane, a running web application its HTTP port.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { projectLocation, useRemote } from "@/platform/remote";
import { tx, useT, useTxTemplate } from "@/platform/i18n";
import { Button, EmptyState, T, showContextMenu } from "@/ui";
import type { MenuItem } from "@/ui";
import {
  toolWindowService,
  notifications,
  useRunConfigTypes,
  useDebugRunSessions,
  type DebugServiceSession,
  type ServiceItemAction,
  type ServiceProviderContribution,
  type ServiceTreeItem,
} from "@/workbench/contributions";
import { pickServices } from "./serviceImport";
import { CATEGORY_ORDER, categoryOf, commandLine, configIcon, KIND_OPTIONS, kindLabel } from "./configs";
import { openUrl } from "./navigate";
import { SessionPanel } from "./RunView";
import { showApplicationUpdate } from "./applicationUpdate";
import { isUpdatable } from "./updatePolicies";
import {
  configRemoved,
  loadConfigs,
  persistTemporary,
  rerunConfig,
  startRun,
  stopSession,
  useRun,
  waitForExit,
  type RunSession,
  isLive,
} from "./store";
import {
  currentServiceSession,
  currentServiceSessions,
  liveServiceSession,
  serviceDebugger,
  serviceSessions,
  stopServiceSessions,
  type ServiceSession,
} from "./serviceSessions";
import { isDebugOnly } from "./types";
import {
  currentServiceOrder,
  moveServiceOrder,
  orderServices,
  saveServiceOrder,
  useServiceOrder,
  type ServiceOrder,
} from "./serviceOrder";
import styles from "./RunServices.module.css";

export const RUN_PROVIDER = "runConfigurations";
const TYPE_PREFIX = "run:type:";
const CONFIG_PREFIX = "run:config:";
const STORAGE_KEY = "openidea.services.runTypes:";
/** Docker run kinds whose containers/deployments are already shown under the Docker provider in Services. */
const DOCKER_PROVIDER_KINDS: ReadonlySet<string> = new Set(["docker-compose", "docker-dockerfile", "docker-image"]);

// ---------------------------------------------------------------------------
// Types added to Services, per project

const useAddedTypes = create<{ root: string | null; types: string[] }>(() => ({ root: null, types: [] }));

/** The project's types; empty until the user adds one with "Add Service". */
export function readTypes(root: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + root);
    if (raw === null) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function addedTypes(root: string | null): string[] {
  const s = useAddedTypes.getState();
  return s.root === root ? s.types : root ? readTypes(root) : [];
}

function setAddedTypes(types: string[]) {
  const root = useProject.getState().project?.root ?? null;
  useAddedTypes.setState({ root, types });
  if (!root) return;
  try {
    localStorage.setItem(STORAGE_KEY + root, JSON.stringify(types));
  } catch {
    /* storage unavailable */
  }
}

const currentTypes = () => addedTypes(useProject.getState().project?.root ?? null);

export function addType(kind: string) {
  const types = currentTypes();
  if (!types.includes(kind)) setAddedTypes([...types, kind]);
}

export function removeType(kind: string) {
  setAddedTypes(currentTypes().filter((t) => t !== kind));
}

// ---------------------------------------------------------------------------
// Project removal: a workspace member's data leaves with it

/** Whether `path` is inside the directory `root` (a removed member, not a sibling with a shared prefix). */
function insideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Drops a removed workspace member's data from Services: stops and forgets its
 * sessions (a finished one still groups the tree), removes its temporary
 * configurations, reloads (the backend no longer lists the member) and clears
 * the added types that would otherwise render empty groups.
 */
export async function cleanupRemovedProject(removedRoot: string): Promise<void> {
  const { configs, sessions, temporary } = useRun.getState();
  const ofRemoved = (c: RunConfig) => !!c.cwd && insideRoot(c.cwd, removedRoot);
  const removedIds = new Set(configs.filter(ofRemoved).map((c) => c.id));

  const removedSessions = sessions.filter((s) => removedIds.has(s.config.id));
  for (const s of removedSessions) if (busy(s)) await stopSession(s.id);
  if (removedSessions.length) {
    const ids = new Set(removedSessions.map((s) => s.id));
    useRun.setState((s) => ({ sessions: s.sessions.filter((x) => !ids.has(x.id)) }));
  }

  if (temporary.some((id) => removedIds.has(id))) {
    const temporaryLeft = temporary.filter((id) => !removedIds.has(id));
    useRun.setState({
      configs: useRun.getState().configs.filter((c) => !removedIds.has(c.id)),
      temporary: temporaryLeft,
    });
    persistTemporary();
  }

  // The kinds the member had configurations of; after the reload those that are
  // left without any (and without a session) are removed from the added types.
  const kinds = new Set(configs.filter(ofRemoved).map((c) => c.kind));
  await loadConfigs();

  const { configs: fresh, sessions: liveSessions } = useRun.getState();
  const liveKinds = new Set([...fresh.map((c) => c.kind), ...liveSessions.map((s) => s.config.kind)]);
  for (const kind of kinds) if (!liveKinds.has(kind)) removeType(kind);
}

// Configurations hidden from Services, per project (removed one by one; "Add Service" restores)

const HIDDEN_KEY = "openidea.services.runHidden:";

const useHiddenConfigs = create<{ location: string | null; hidden: Record<string, string[]> }>(() => ({
  location: null,
  hidden: {},
}));

/** Hidden configuration ids per kind, persisted per project. */
export function readHidden(location: string | null): Record<string, string[]> {
  if (!location) return {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY + location) ?? "{}");
    const hidden: Record<string, string[]> = {};
    if (raw && typeof raw === "object")
      for (const [kind, ids] of Object.entries(raw))
        if (Array.isArray(ids)) hidden[kind] = ids.filter((id): id is string => typeof id === "string");
    return hidden;
  } catch {
    return {};
  }
}

function currentHidden(): Record<string, string[]> {
  const s = useHiddenConfigs.getState();
  const location = projectLocation(useProject.getState().project?.root);
  return s.location === location ? s.hidden : readHidden(location);
}

function saveHidden(hidden: Record<string, string[]>) {
  const location = projectLocation(useProject.getState().project?.root);
  useHiddenConfigs.setState({ location, hidden });
  if (!location) return;
  try {
    localStorage.setItem(HIDDEN_KEY + location, JSON.stringify(hidden));
  } catch {
    /* storage unavailable */
  }
}

/** Removes one configuration from Services at once, even while it runs (its console is in the Run window). */
function hideConfig(kind: string, id: string) {
  const hidden = currentHidden();
  if ((hidden[kind] ?? []).includes(id)) return;
  saveHidden({ ...hidden, [kind]: [...(hidden[kind] ?? []), id] });
}

/** "Add Service" on a type group: pick which of the kind's configurations show. */
async function pickForKind(kind: string) {
  const location = projectLocation(useProject.getState().project?.root);
  const configs = useRun.getState().configs.filter((c) => c.kind === kind);
  if (configs.length <= 1) {
    saveHidden({ ...currentHidden(), [kind]: [] });
    addType(kind);
    return;
  }
  const hidden = new Set(currentHidden()[kind] ?? []);
  const picked = await pickServices(kind, configs, new Set(configs.filter((c) => !hidden.has(c.id)).map((c) => c.id)));
  if (!picked || projectLocation(useProject.getState().project?.root) !== location) return;
  addType(kind);
  const remaining = configs.filter((c) => !picked.has(c.id)).map((c) => c.id);
  saveHidden({ ...currentHidden(), [kind]: remaining });
}

// ---------------------------------------------------------------------------
// Tree

const busy = (s: RunSession) => isLive(s);

export function sessionStatus(s: RunSession | undefined): string | undefined {
  if (!s) return undefined;
  if (busy(s)) return s.status === "starting" ? "Starting" : "Running";
  if (s.stopped) return "Stopped";
  if (s.status === "failed") return s.exitCode === null ? "Failed" : `Failed (exit ${s.exitCode})`;
  return "Finished";
}

/** A node's grey text: the HTTP port of a running web application, else the state. */
export function sessionDetail(s: RunSession | undefined): string | undefined {
  return s && busy(s) && s.httpPort ? `:${s.httpPort}` : sessionStatus(s);
}

function executionDetail(s: ServiceSession | undefined): string | undefined {
  if (!s) return undefined;
  const debug = serviceDebugger(s);
  if (debug?.status === "paused") return "Suspended";
  if (debug) {
    // The app's HTTP port: a Run owns the console for an attached debugger, a direct
    // debug launch announces it on the debug session's own console (#1718).
    const run = s.run && busy(s.run) ? s.run : undefined;
    const port = run?.httpPort ?? debug.httpPort;
    if (port) return `:${port}`;
    return debug.status === "starting" ? "Starting" : "Debugging";
  }
  return s.run ? sessionDetail(s.run) : "Finished";
}

/**
 * Groups by configuration type: only the types added in this window list their
 * configurations, and a configuration removed from the window stays out even
 * while it runs (its console is in the Run tool window). A configuration deleted
 * since it ran (`removed`) stays only while its run is live.
 */
export function runServiceItems(
  configs: readonly RunConfig[],
  sessions: readonly RunSession[],
  added: readonly string[],
  order: ServiceOrder = {},
  debug: readonly DebugServiceSession[] = [],
  removed: (id: string) => boolean = () => false,
  hidden: Record<string, readonly string[]> = {},
): ServiceTreeItem[] {
  const executions = serviceSessions(sessions, debug);
  const latest = currentServiceSessions(executions);
  const kinds = added.filter((kind) => !DOCKER_PROVIDER_KINDS.has(kind));
  const shown = (s: ServiceSession) => liveServiceSession(s) || !removed(s.config.id);
  return kinds.flatMap((kind) => {
    const entries: RunConfig[] = configs.filter((c) => c.kind === kind);
    for (const s of latest.values())
      if (s.config.kind === kind && shown(s) && !entries.some((c) => c.id === s.config.id)) entries.push(s.config);
    const hiddenIds = new Set(hidden[kind] ?? []);
    const visible = entries.filter((c) => !hiddenIds.has(c.id));
    const children = orderServices(visible, order[kind]).map((c): ServiceTreeItem => {
      const s = latest.get(c.id);
      return {
        key: CONFIG_PREFIX + c.id,
        label: c.name,
        icon: serviceDebugger(s) ? "debug" : s && liveServiceSession(s) ? "run" : configIcon(c),
        detail: executionDetail(s),
        dim: !s || !liveServiceSession(s),
      };
    });
    const running = visible.filter((c) => {
      const s = latest.get(c.id);
      return !!s && liveServiceSession(s);
    }).length;
    return [
      {
        key: TYPE_PREFIX + kind,
        label: kindLabel(kind),
        icon: configIcon({ kind, isTest: false }),
        detail: running ? tx`${running} running` : undefined,
        expanded: true,
        children,
      },
    ];
  });
}

function useRoots(): ServiceTreeItem[] {
  const root = useProject((s) => s.project?.root ?? null);
  useRemote((s) => s.session);
  const location = projectLocation(root);
  const order = useServiceOrder(location);
  const configs = useRun((s) => s.configs);
  const sessions = useRun((s) => s.sessions);
  const debug = useDebugRunSessions((s) => s.serviceSessions);
  const types = useAddedTypes((s) => s.types);
  const typesRoot = useAddedTypes((s) => s.root);
  const hidden = useHiddenConfigs((s) => s.hidden);
  const hiddenLocation = useHiddenConfigs((s) => s.location);
  useEffect(() => {
    if (typesRoot !== root) useAddedTypes.setState({ root, types: root ? readTypes(root) : [] });
    if (hiddenLocation !== location) useHiddenConfigs.setState({ location, hidden: readHidden(location) });
  }, [root, typesRoot, hiddenLocation, location]);
  return useMemo(
    () =>
      runServiceItems(
        configs,
        sessions,
        typesRoot === root ? types : [],
        order,
        debug,
        configRemoved,
        hiddenLocation === location ? hidden : {},
      ),
    [configs, sessions, types, typesRoot, root, order, debug, hidden, hiddenLocation, location],
  );
}

interface Resolved {
  kind: string | null;
  config: RunConfig | null;
  session: ServiceSession | undefined;
  /** Sessions of a group's configurations. */
  sessions: ServiceSession[];
}

function resolve(item: ServiceTreeItem): Resolved {
  const { configs, sessions } = useRun.getState();
  const executions = serviceSessions(sessions, useDebugRunSessions.getState().serviceSessions);
  // A configuration type's group node (`run:type:spring-boot`).
  if (item.key.startsWith(TYPE_PREFIX)) {
    const kind = item.key.slice(TYPE_PREFIX.length);
    return {
      kind,
      config: null,
      session: undefined,
      sessions: executions.filter((s) => s.config.kind === kind),
    };
  }
  // A configuration (`run:config:<id>`).
  const id = item.key.slice(CONFIG_PREFIX.length);
  const session = currentServiceSession(id, executions);
  const config = configs.find((c) => c.id === id) ?? session?.config ?? null;
  return {
    kind: config?.kind ?? null,
    config,
    session,
    sessions: session ? [session] : [],
  };
}

function showOutput(s: RunSession) {
  useRun.setState({ activeSession: s.id });
  toolWindowService().show("run", true);
}

/** Runs (or reruns, in its tab) a configuration; the output stays in Services instead of opening Run. */
function run(r: Resolved) {
  const debug = serviceDebugger(r.session);
  if (debug) (debug.rerunInPlace ?? debug.rerun)?.();
  else if (r.session?.run) {
    const s = r.session.run;
    void startRun(rerunConfig(s), s.id, s.baseConfig, { show: false });
  } else if (r.config) void startRun(r.config, undefined, undefined, { show: false });
}

function debug(r: Resolved) {
  const session = serviceDebugger(r.session);
  if (session) (session.rerunInPlace ?? session.rerun)?.();
  else if (r.config) void executeAction("run.debugConfig", { config: r.config, show: false });
}

function groupConfigs(kind: string): RunConfig[] {
  const root = useProject.getState().project?.root ?? null;
  const location = projectLocation(root);
  const { configs, sessions } = useRun.getState();
  const debug = useDebugRunSessions.getState().serviceSessions;
  const latest = currentServiceSessions(serviceSessions(sessions, debug));
  const group = runServiceItems(
    configs,
    sessions,
    currentTypes(),
    location ? currentServiceOrder(location) : {},
    debug,
    configRemoved,
    currentHidden(),
  ).find((item) => item.key === TYPE_PREFIX + kind);
  return (group?.children ?? []).flatMap((item) => {
    const id = item.key.slice(CONFIG_PREFIX.length);
    const config = configs.find((c) => c.id === id) ?? latest.get(id)?.config;
    return config ? [config] : [];
  });
}

async function startAll(kind: string, restart: boolean): Promise<void> {
  const root = useProject.getState().project?.root;
  const entries = groupConfigs(kind).filter((c) => !isDebugOnly(c));
  if (restart) {
    const { sessions } = useRun.getState();
    const running = serviceSessions(sessions, useDebugRunSessions.getState().serviceSessions).filter(
      (s) => s.config.kind === kind && liveServiceSession(s),
    );
    await stopServiceSessions(running);
    await waitForExit(
      running.flatMap((s) => (s.run ? [s.run.id] : [])),
      null,
    );
  }
  for (const config of entries) {
    if (useProject.getState().project?.root !== root) return;
    const running = serviceSessions(useRun.getState().sessions, useDebugRunSessions.getState().serviceSessions);
    if (running.some((s) => s.config.id === config.id && liveServiceSession(s))) continue;
    try {
      await startRun(config, undefined, undefined, { show: false });
    } catch (e) {
      notifications().notify({ group: "run", level: "error", title: tx`Cannot run '${config.name}'`, body: String(e) });
    }
  }
}

function browserActions(sessions: readonly ServiceSession[]): ServiceItemAction[] {
  const urls = new Map<string, string>();
  for (const s of sessions) {
    if (!liveServiceSession(s)) continue;
    const port = (s.run && isLive(s.run) ? s.run.httpPort : undefined) ?? serviceDebugger(s)?.httpPort;
    if (port && Number.isInteger(port) && port > 0 && port < 65536) urls.set(`http://localhost:${port}`, s.config.name);
  }
  return [
    {
      id: "open-browser",
      title: "Open in Browser",
      icon: "web",
      disabled: !urls.size,
      run: () => {
        if (urls.size === 1) return void openUrl(urls.keys().next().value!);
        if (!urls.size) return;
        showContextMenu(
          { x: window.innerWidth / 2, y: window.innerHeight / 2 },
          [...urls].map(([url, name]) => ({
            label: `${name} — ${url}`,
            verbatim: true,
            icon: "web",
            run: () => void openUrl(url),
          })),
        );
      },
    },
  ];
}

function itemActions(item: ServiceTreeItem): ServiceItemAction[] {
  const r = resolve(item);
  const running = r.sessions.filter(liveServiceSession);
  if (!r.config && r.kind) {
    const kind = r.kind;
    const entries = groupConfigs(kind).filter((c) => !isDebugOnly(c));
    return [
      {
        id: "run-all",
        title: "Run All",
        icon: "run",
        disabled: !entries.some((c) => !running.some((s) => s.config.id === c.id)),
        run: () => startAll(kind, false),
      },
      {
        id: "restart-all",
        title: "Restart All",
        icon: "rerun",
        disabled: !entries.length,
        run: () => startAll(kind, true),
      },
      {
        id: "stop-all",
        title: "Stop All",
        icon: "stop",
        disabled: !running.length,
        run: () => stopServiceSessions(running),
      },
      ...browserActions(r.sessions),
    ];
  }
  const stop = {
    id: "stop",
    title: "Stop",
    icon: "stop",
    disabled: !running.length,
    run: () => void stopServiceSessions(running),
  };
  if (!r.config) return [stop];
  const live = !!r.session && liveServiceSession(r.session);
  const debugging = serviceDebugger(r.session);
  return [
    {
      id: "run",
      title: live ? "Rerun" : "Run",
      icon: live ? "rerun" : "run",
      disabled: debugging ? !debugging.rerun : isDebugOnly(r.config),
      run: () => run(r),
    },
    { id: "debug", title: "Debug", icon: "debug", disabled: !!debugging && !debugging.rerun, run: () => debug(r) },
    ...browserActions(r.sessions),
    stop,
    ...(isUpdatable(r.config)
      ? [
          {
            id: "update",
            title: "Update Application",
            icon: "refresh",
            disabled: !live,
            run: () => showApplicationUpdate(r.session?.run?.id ?? (debugging ? `debug:${debugging.id}` : undefined)),
          },
        ]
      : []),
  ];
}

const SERVICE_ACTIONS = [
  { id: "run-all", action: "run.services.runAll", title: "Run All", icon: "run" },
  { id: "restart-all", action: "run.services.restartAll", title: "Restart All", icon: "rerun" },
  { id: "stop-all", action: "run.services.stopAll", title: "Stop All", icon: "stop" },
  { id: "open-browser", action: "run.services.openBrowser", title: "Open in Browser", icon: "web" },
];

export function registerRunServiceActions(): () => void {
  return registerActions([
    ...SERVICE_ACTIONS.map<Action>(({ id, action, title, icon }) => ({
      id: action,
      title,
      icon,
      category: "Run",
      hidden: true,
      run: async ({ arg }) => {
        if (typeof arg !== "string" || (!arg.startsWith(TYPE_PREFIX) && !arg.startsWith(CONFIG_PREFIX))) return;
        const action = itemActions({ key: arg, label: "", icon: "" }).find((a) => a.id === id);
        if (action && !action.disabled) await action.run();
      },
    })),
    {
      id: "run.services.addType",
      title: "Add Service",
      icon: "plus",
      category: "Run",
      hidden: true,
      run: async ({ arg }) => {
        if (typeof arg === "string") await pickForKind(arg);
      },
    },
    {
      id: "run.services.hideConfig",
      title: "Remove from Services",
      icon: "close",
      category: "Run",
      hidden: true,
      run: ({ arg }) => {
        if (typeof arg !== "string") return;
        const { config } = resolve({ key: CONFIG_PREFIX + arg, label: "", icon: "" });
        if (config) hideConfig(config.kind, config.id);
      },
    },
  ]);
}

function actions(item: ServiceTreeItem): ServiceItemAction[] {
  return itemActions(item).map((entry) => {
    const action = SERVICE_ACTIONS.find((a) => a.id === entry.id);
    return action
      ? {
          ...entry,
          run: async () => {
            await executeAction(action.action, item.key);
          },
        }
      : entry;
  });
}

function menu(item: ServiceTreeItem): MenuItem[] {
  const items: MenuItem[] = actions(item).map((a) => ({
    id: a.id,
    label: a.title,
    icon: a.icon,
    disabled: a.disabled,
    run: a.run,
  }));
  const r = resolve(item);
  if (!r.config && r.kind) {
    const kind = r.kind;
    items.push(
      { kind: "separator" },
      {
        label: "Add Service",
        icon: "plus",
        disabled: !useRun.getState().configs.some((c) => c.kind === kind),
        run: async () => {
          await executeAction("run.services.addType", kind);
        },
      },
    );
    if (currentTypes().includes(kind))
      items.push({ label: "Remove from Services", icon: "close", run: () => removeType(kind) });
  }
  if (r.config) {
    const config = r.config;
    const session = r.session?.run;
    const debuggerSession = serviceDebugger(r.session) ?? r.session?.debug.at(-1);
    items.push(
      { kind: "separator" },
      {
        label: "Show in Run Tool Window",
        icon: "toolwindow-run",
        disabled: !session,
        run: () => session && showOutput(session),
      },
      {
        label: "Show in Debug Tool Window",
        icon: "toolwindow-debug",
        disabled: !debuggerSession,
        run: () => debuggerSession?.show(),
      },
      { label: "Edit Configuration…", icon: "edit", run: () => void executeAction("run.editConfigs", config.id) },
      {
        label: "Remove from Services",
        icon: "close",
        run: () => void executeAction("run.services.hideConfig", config.id),
      },
    );
  }
  return items;
}

function RunDetail({ item }: { item: ServiceTreeItem }) {
  // Re-render on session changes.
  useRun((s) => s.sessions);
  const debugViews = useDebugRunSessions();
  const Console = debugViews.Console;
  const t = useT();
  const txTemplate = useTxTemplate();
  const r = resolve(item);
  if (!r.config)
    return (
      <EmptyState title={kindLabel(r.kind ?? "")}>
        <div>
          {item.children?.length
            ? t("run.services.configurationCount", { count: item.children.length })
            : txTemplate("No configurations of this type")}
        </div>
      </EmptyState>
    );
  // The configuration ran: its console, as in the Run tool window. Run / Debug / Stop
  // come from this window's toolbar (the selection), so the console strip leaves them out.
  if (r.session?.run) {
    const execution = r.session;
    return <SessionPanel key={execution.run!.id} session={execution.run!} showLifecycle={false} />;
  }
  const d = r.session?.debug[0];
  if (d && Console)
    return (
      <div className={styles.debugConsole}>
        <Console key={d.id} sessionId={d.id} />
      </div>
    );
  return (
    <div className={styles.detail}>
      <dl className={styles.facts}>
        <dt>
          <T>Configuration</T>
        </dt>
        <dd>{r.config.name}</dd>
        <dt>
          <T>Type</T>
        </dt>
        <dd>
          <T>{kindLabel(r.config.kind)}</T>
        </dd>
        {r.config.module && (
          <>
            <dt>
              <T>Module</T>
            </dt>
            <dd>{r.config.module}</dd>
          </>
        )}
        <dt>
          <T>Command</T>
        </dt>
        <dd className={styles.mono}>{commandLine(r.config)}</dd>
        <dt>
          <T>Status</T>
        </dt>
        <dd>
          <T>Not started</T>
        </dd>
      </dl>
      <div className={styles.actions}>
        <Button icon="run" disabled={isDebugOnly(r.config)} onClick={() => run(r)}>
          Run
        </Button>
        <Button icon="debug" onClick={() => debug(r)}>
          Debug
        </Button>
      </div>
    </div>
  );
}

/** The leaf label of a kind: the registered type's own label, else its kind label. */
const labelOf = (kind: string) => useRunConfigTypes.getState().types.get(kind)?.label ?? kindLabel(kind);

/**
 * The kinds grouped by menu category, in display order: `CATEGORY_ORDER` first,
 * then unlisted (plugin) categories alphabetically, then "Others" last; each
 * bucket's kinds sorted by leaf label. One submenu is rendered per bucket, even
 * for a single member, so adding groups and members later keeps the structure.
 */
export function categorizedTypes(kinds: readonly string[]): Array<{ category: string; kinds: string[] }> {
  const byCategory = new Map<string, string[]>();
  for (const kind of kinds) {
    const category = categoryOf(kind);
    byCategory.set(category, [...(byCategory.get(category) ?? []), kind]);
  }
  const rank = (category: string) => {
    const i = CATEGORY_ORDER.indexOf(category);
    // Unlisted (plugin) categories sort after the fixed order, before "Others".
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  const categories = [...byCategory.keys()].sort(
    (a, b) => rank(a) - rank(b) || (a === "Others" ? 1 : b === "Others" ? -1 : 0) || a.localeCompare(b),
  );
  return categories.map((category) => ({
    category,
    kinds: [...byCategory.get(category)!].sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
  }));
}

/** The project's categories, then the rest. A category appears once, even when the project uses only some of its kinds. */
export function addMenuCategories(kinds: readonly string[], used: readonly string[]) {
  const buckets = categorizedTypes(kinds);
  const inProject = (bucket: (typeof buckets)[number]) => bucket.kinds.some((kind) => used.includes(kind));
  return { project: buckets.filter(inProject), rest: buckets.filter((bucket) => !inProject(bucket)) };
}

/** "Add Service › Run Configuration Type": the project's types first, then the rest. */
function addMenu(): MenuItem[] {
  const added = currentTypes();
  const used = [...new Set(useRun.getState().configs.map((c) => c.kind))];
  const known = [...KIND_OPTIONS.map((o) => o.value), ...useRunConfigTypes.getState().types.keys()];
  const kinds = [...new Set([...used, ...known])].filter(
    (k) => k !== "compound" && !DOCKER_PROVIDER_KINDS.has(k) && !added.includes(k),
  );
  /** A leaf item: the type's own label; grouped types live in their group's submenu. */
  const item = (kind: string): MenuItem => ({
    label: useRunConfigTypes.getState().types.get(kind)?.label ?? kindLabel(kind),
    icon: configIcon({ kind, isTest: false }),
    run: async () => {
      await executeAction("run.services.addType", kind);
    },
  });
  const grouped = (buckets: ReturnType<typeof categorizedTypes>) =>
    buckets.map(({ category, kinds: members }) => ({
      label: category,
      icon: configIcon({ kind: members[0]!, isTest: false }),
      submenu: members.map(item),
    }));
  const { project, rest } = addMenuCategories(kinds, used);
  const submenu: MenuItem[] = [
    ...grouped(project),
    ...(project.length && rest.length ? [{ kind: "separator" } as MenuItem] : []),
    ...grouped(rest),
  ];
  return [{ label: "Run Configuration Type", icon: "toolwindow-run", disabled: !submenu.length, submenu }];
}

export const runServiceProvider: ServiceProviderContribution = {
  id: RUN_PROVIDER,
  order: 0,
  useRoots,
  actions,
  menu,
  activate: (item) => {
    const r = resolve(item);
    if (r.config && !(r.session && liveServiceSession(r.session)) && !isDebugOnly(r.config)) run(r);
  },
  detail: RunDetail,
  addMenu,
  reorder: {
    canMove: (source, target) => {
      if (!source.key.startsWith(CONFIG_PREFIX) || !target.key.startsWith(CONFIG_PREFIX) || source.key === target.key)
        return false;
      const from = resolve(source),
        to = resolve(target);
      return !!from.config && !!to.config && from.kind === to.kind;
    },
    move: (source, target, position) => {
      if (!runServiceProvider.reorder!.canMove(source, target)) return;
      const location = projectLocation(useProject.getState().project?.root);
      const kind = resolve(source).kind;
      if (!location || !kind) return;
      const { configs, sessions } = useRun.getState();
      const order = currentServiceOrder(location);
      const group = runServiceItems(
        configs,
        sessions,
        currentTypes(),
        order,
        useDebugRunSessions.getState().serviceSessions,
        configRemoved,
        currentHidden(),
      ).find((g) => g.key === TYPE_PREFIX + kind);
      const ids = group?.children?.map((c) => c.key.slice(CONFIG_PREFIX.length)) ?? [];
      const from = source.key.slice(CONFIG_PREFIX.length),
        to = target.key.slice(CONFIG_PREFIX.length);
      if (!ids.includes(from) || !ids.includes(to)) return;
      if (
        !saveServiceOrder(location, {
          ...order,
          [kind]: moveServiceOrder(order[kind] ?? [], ids, from, to, position),
        })
      ) {
        notifications().notify({
          group: "run",
          level: "warning",
          title: "Cannot save service order",
          body: "The order will be kept for this session only.",
        });
      }
    },
  },
};
