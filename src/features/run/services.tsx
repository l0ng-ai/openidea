/**
 * Run configurations in the Services tool window (IDEA's Run Dashboard): Spring
 * Boot by default, the configuration types added there ("Add Service › Run
 * Configuration Type"), the types of this window's run sessions and the
 * configurations that ran before (kept per project across restarts), one group
 * each, with run / debug / stop / rerun per configuration. A configuration that
 * ran shows its console in the detail pane, a running web application its HTTP port.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { projectLocation, useRemote } from "@/platform/remote";
import { tx, useT, useTxTemplate } from "@/platform/i18n";
import { Button, EmptyState, T } from "@/ui";
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
import { CATEGORY_ORDER, categoryOf, commandLine, configIcon, KIND_OPTIONS, kindLabel } from "./configs";
import { openUrl } from "./navigate";
import { SessionPanel } from "./RunView";
import { pickServices } from "./serviceImport";
import { startRun, useRun, type RunSession } from "./store";
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
const RAN_KEY = "openidea.services.ran:";
/** Types shown in Services until the user changes the list. */
export const DEFAULT_TYPES: readonly string[] = ["spring-boot", "vue"];

// ---------------------------------------------------------------------------
// Types added to Services, per project

const useAddedTypes = create<{ root: string | null; types: string[] }>(() => ({ root: null, types: [] }));

/** The project's types; Spring Boot until the user changes the list. */
export function readTypes(root: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + root);
    if (raw === null) return [...DEFAULT_TYPES];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [...DEFAULT_TYPES];
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
// Configurations that ran, per project (shown again after a restart)

const useRanConfigs = create<{ root: string | null; ids: string[] }>(() => ({ root: null, ids: [] }));

/** The project's previously run configuration ids, most recent last. */
export function readRan(root: string): string[] {
  try {
    const raw = localStorage.getItem(RAN_KEY + root);
    if (raw === null) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function ranIds(root: string | null): string[] {
  const s = useRanConfigs.getState();
  return s.root === root ? s.ids : root ? readRan(root) : [];
}

/** Records a run, so its configuration is back in Services after a restart. */
export function recordRun(configId: string) {
  const root = useProject.getState().project?.root ?? null;
  const ids = [...ranIds(root).filter((id) => id !== configId), configId];
  useRanConfigs.setState({ root, ids });
  if (!root) return;
  try {
    localStorage.setItem(RAN_KEY + root, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
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

/** Removes one configuration from Services; it reappears while it runs (its console stays reachable). */
function hideConfig(kind: string, id: string) {
  const hidden = currentHidden();
  if ((hidden[kind] ?? []).includes(id)) return;
  saveHidden({ ...hidden, [kind]: [...(hidden[kind] ?? []), id] });
}

/** "Add Service" on a type group: pick which of the kind's configurations show. */
async function pickForKind(kind: string) {
  const configs = useRun.getState().configs.filter((c) => c.kind === kind);
  if (configs.length <= 1) {
    addType(kind);
    return;
  }
  const hidden = new Set(currentHidden()[kind] ?? []);
  const picked = await pickServices(kind, configs, new Set(configs.filter((c) => !hidden.has(c.id)).map((c) => c.id)));
  if (!picked) return;
  addType(kind);
  const remaining = configs.filter((c) => !picked.has(c.id)).map((c) => c.id);
  saveHidden({ ...currentHidden(), [kind]: remaining });
}

// ---------------------------------------------------------------------------
// Tree

const busy = (s: RunSession) => s.status === "running" || s.status === "starting";

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
  if (debug)
    return s.run && busy(s.run) && s.run.httpPort
      ? `:${s.run.httpPort}`
      : debug.status === "starting"
        ? "Starting"
        : "Debugging";
  return s.run ? sessionDetail(s.run) : "Finished";
}

/** The configurations of `kind` the tree shows: all, for added types; the ran ones, otherwise. */
function kindConfigs(
  kind: string,
  configs: readonly RunConfig[],
  added: readonly string[],
  ran: readonly string[],
  latest: ReadonlyMap<string, ServiceSession>,
): RunConfig[] {
  const entries: RunConfig[] = added.includes(kind)
    ? configs.filter((c) => c.kind === kind)
    : ran.map((id) => configs.find((c) => c.id === id)).filter((c): c is RunConfig => !!c && c.kind === kind);
  for (const s of latest.values())
    if (s.config.kind === kind && !entries.some((c) => c.id === s.config.id)) entries.push(s.config);
  return entries;
}

/**
 * Groups by configuration type: added types list all their configurations, other
 * types only those that ran. A default type (Spring Boot) without configurations is hidden.
 */
export function runServiceItems(
  configs: readonly RunConfig[],
  sessions: readonly RunSession[],
  added: readonly string[],
  ran: readonly string[] = [],
  order: ServiceOrder = {},
  debug: readonly DebugServiceSession[] = [],
  hidden: Record<string, readonly string[]> = {},
): ServiceTreeItem[] {
  const executions = serviceSessions(sessions, debug);
  const latest = currentServiceSessions(executions);
  const kinds = [...added];
  for (const s of executions) if (!kinds.includes(s.config.kind)) kinds.push(s.config.kind);
  for (const id of ran) {
    const kind = configs.find((c) => c.id === id)?.kind;
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.flatMap((kind) => {
    const hiddenIds = new Set(hidden[kind] ?? []);
    let entries = kindConfigs(kind, configs, added, ran, latest);
    // Removed configurations reappear only while they run (their console stays reachable).
    entries = entries.filter((c) => {
      const s = latest.get(c.id);
      return !hiddenIds.has(c.id) || (s && liveServiceSession(s));
    });
    // A default type with everything removed keeps its empty group, so "Add Service" can restore it.
    if (!entries.length && DEFAULT_TYPES.includes(kind) && hiddenIds.size === 0) return [];
    // Configurations are listed flat under their type, as in IDEA's Run Dashboard.
    const children = orderServices(entries, order[kind]).map((c): ServiceTreeItem => {
      const s = latest.get(c.id);
      return {
        key: CONFIG_PREFIX + c.id,
        label: c.name,
        icon: serviceDebugger(s) ? "debug" : s && liveServiceSession(s) ? "run" : configIcon(c),
        detail: executionDetail(s),
        dim: !s || !liveServiceSession(s),
      };
    });
    const running = entries.filter((c) => {
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
  const ran = useRanConfigs((s) => s.ids);
  const ranRoot = useRanConfigs((s) => s.root);
  const hidden = useHiddenConfigs((s) => s.hidden);
  const hiddenLocation = useHiddenConfigs((s) => s.location);
  useEffect(() => {
    if (typesRoot !== root) useAddedTypes.setState({ root, types: root ? readTypes(root) : [] });
    if (ranRoot !== root) useRanConfigs.setState({ root, ids: root ? readRan(root) : [] });
    if (hiddenLocation !== location) useHiddenConfigs.setState({ location, hidden: readHidden(location) });
  }, [root, typesRoot, ranRoot, hiddenLocation, location]);
  return useMemo(
    () =>
      runServiceItems(
        configs,
        sessions,
        typesRoot === root ? types : [],
        ranRoot === root ? ran : [],
        order,
        debug,
        hiddenLocation === location ? hidden : {},
      ),
    [configs, sessions, types, typesRoot, ran, ranRoot, root, order, debug, hidden, hiddenLocation, location],
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
  if (debug) debug.rerun?.();
  else if (r.session?.run) {
    const s = r.session.run;
    void startRun(s.config, s.id, s.baseConfig, { show: false });
  } else if (r.config) void startRun(r.config, undefined, undefined, { show: false });
}

function debug(r: Resolved) {
  const session = serviceDebugger(r.session);
  if (session) session.rerun?.();
  else if (r.config) void executeAction("run.debugConfig", r.config);
}

/** Run All / Restart All: starts the configurations of `kind` that can run, in display order. */
async function startAll(kind: string, restart: boolean): Promise<void> {
  const root = useProject.getState().project?.root ?? null;
  const { configs, sessions } = useRun.getState();
  const executions = serviceSessions(sessions, useDebugRunSessions.getState().serviceSessions);
  const latest = currentServiceSessions(executions);
  const running = executions.filter((s) => s.config.kind === kind && liveServiceSession(s));
  if (restart) await stopServiceSessions(running);
  const location = projectLocation(root);
  const order = location ? currentServiceOrder(location) : {};
  const entries = orderServices(kindConfigs(kind, configs, currentTypes(), ranIds(root), latest), order[kind]);
  for (const c of entries) {
    if (isDebugOnly(c)) continue;
    // Run All skips running configurations; Restart All stopped them above (the snapshot is stale then).
    if (!restart) {
      const s = latest.get(c.id);
      if (s && liveServiceSession(s)) continue;
    }
    await startRun(c, undefined, undefined, { show: false });
  }
}

function actions(item: ServiceTreeItem): ServiceItemAction[] {
  const r = resolve(item);
  // A type group: batch actions over its configurations.
  if (!r.config && r.kind) {
    const kind = r.kind;
    const root = useProject.getState().project?.root ?? null;
    const { configs, sessions } = useRun.getState();
    const executions = serviceSessions(sessions, useDebugRunSessions.getState().serviceSessions);
    const latest = currentServiceSessions(executions);
    const entries = kindConfigs(kind, configs, currentTypes(), ranIds(root), latest);
    const running = executions.filter((s) => s.config.kind === kind && liveServiceSession(s));
    const runnable = entries.some((c) => {
      const s = latest.get(c.id);
      return !(s && liveServiceSession(s)) && !isDebugOnly(c);
    });
    return [
      { id: "run-all", title: "Run All", icon: "run", disabled: !runnable, run: () => startAll(kind, false) },
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
        run: () => void stopServiceSessions(running),
      },
    ];
  }
  const running = r.sessions.filter(liveServiceSession);
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
  // A running web application's HTTP port becomes a browser link (IDEA's port URL).
  const browser: ServiceItemAction[] =
    live && r.session?.run?.httpPort
      ? [
          {
            id: "open-browser",
            title: "Open in Browser",
            icon: "web",
            run: () => void openUrl(`http://localhost:${r.session!.run!.httpPort}`),
          },
        ]
      : [];
  return [
    {
      id: "run",
      title: live ? "Rerun" : "Run",
      icon: live ? "rerun" : "run",
      disabled: debugging ? !debugging.rerun : isDebugOnly(r.config),
      run: () => run(r),
    },
    { id: "debug", title: "Debug", icon: "debug", disabled: !!debugging && !debugging.rerun, run: () => debug(r) },
    ...browser,
    stop,
  ];
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
        run: () => void pickForKind(kind),
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
      { label: "Remove from Services", icon: "close", run: () => hideConfig(config.kind, config.id) },
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
  // The configuration ran: its console, as in the Run tool window.
  if (r.session?.run) {
    const execution = r.session;
    const d = serviceDebugger(execution);
    return (
      <SessionPanel
        key={execution.run!.id}
        session={execution.run!}
        onRerun={d ? d.rerun : undefined}
        onStop={d ? () => void stopServiceSessions([execution]) : undefined}
      />
    );
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

/** "Add Service › Run Configuration Type": the project's types first, then the rest. */
function addMenu(): MenuItem[] {
  const added = currentTypes();
  const used = [...new Set(useRun.getState().configs.map((c) => c.kind))];
  const known = [...KIND_OPTIONS.map((o) => o.value), ...useRunConfigTypes.getState().types.keys()];
  const kinds = [...new Set([...used, ...known])].filter((k) => k !== "compound" && !added.includes(k));
  /** A leaf item: the type's own label; grouped types live in their group's submenu. */
  const item = (kind: string): MenuItem => ({
    label: useRunConfigTypes.getState().types.get(kind)?.label ?? kindLabel(kind),
    icon: configIcon({ kind, isTest: false }),
    run: () => void pickForKind(kind),
  });
  const grouped = (list: readonly string[]) =>
    categorizedTypes(list).map(({ category, kinds: members }) => ({
      label: category,
      icon: configIcon({ kind: members[0]!, isTest: false }),
      submenu: members.map(item),
    }));
  const submenu: MenuItem[] = [
    ...grouped(kinds.filter((k) => used.includes(k))),
    ...(used.some((k) => kinds.includes(k)) && kinds.some((k) => !used.includes(k))
      ? [{ kind: "separator" } as MenuItem]
      : []),
    ...grouped(kinds.filter((k) => !used.includes(k))),
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
        ranIds(useProject.getState().project?.root ?? null),
        order,
        useDebugRunSessions.getState().serviceSessions,
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
