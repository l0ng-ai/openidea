/**
 * Run configurations in the Services tool window (IDEA's Run Dashboard): Spring
 * Boot by default, the configuration types added there ("Add Service › Run
 * Configuration Type") and the types of this window's run sessions, one group
 * each, with run / debug / stop / rerun per configuration. A configuration that
 * ran shows its console in the detail pane, a running web application its HTTP port.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx, useT, useTxTemplate } from "@/platform/i18n";
import { Button, EmptyState, T } from "@/ui";
import type { MenuItem } from "@/ui";
import {
  toolWindowService,
  useRunConfigTypes,
  type ServiceItemAction,
  type ServiceProviderContribution,
  type ServiceTreeItem,
} from "@/workbench/contributions";
import { commandLine, configIcon, KIND_OPTIONS, kindLabel } from "./configs";
import { SessionPanel } from "./RunView";
import { startRun, stopSession, useRun, type RunSession } from "./store";
import { isDebugOnly } from "./types";
import styles from "./RunServices.module.css";

export const RUN_PROVIDER = "runConfigurations";
const TYPE_PREFIX = "run:type:";
const CONFIG_PREFIX = "run:config:";
const STORAGE_KEY = "openidea.services.runTypes:";
/** Types shown in Services until the user changes the list. */
export const DEFAULT_TYPES: readonly string[] = ["spring-boot"];

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
// Tree

const busy = (s: RunSession) => s.status === "running" || s.status === "starting";

/** The newest session of each configuration id. */
function latestSessions(sessions: readonly RunSession[]): Map<string, RunSession> {
  const out = new Map<string, RunSession>();
  for (const s of sessions) {
    const prev = out.get(s.config.id);
    if (!prev || s.startedAt >= prev.startedAt) out.set(s.config.id, s);
  }
  return out;
}

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

/**
 * Groups by configuration type: added types list all their configurations, other
 * types only those that ran. A default type (Spring Boot) without configurations is hidden.
 */
export function runServiceItems(
  configs: readonly RunConfig[],
  sessions: readonly RunSession[],
  added: readonly string[],
): ServiceTreeItem[] {
  const latest = latestSessions(sessions);
  const kinds = [...added];
  for (const s of sessions) if (!kinds.includes(s.config.kind)) kinds.push(s.config.kind);
  return kinds.flatMap((kind) => {
    const entries: RunConfig[] = added.includes(kind) ? configs.filter((c) => c.kind === kind) : [];
    for (const s of latest.values())
      if (s.config.kind === kind && !entries.some((c) => c.id === s.config.id)) entries.push(s.config);
    if (!entries.length && DEFAULT_TYPES.includes(kind)) return [];
    const children = entries.map((c): ServiceTreeItem => {
      const s = latest.get(c.id);
      return {
        key: CONFIG_PREFIX + c.id,
        label: c.name,
        icon: s && busy(s) ? "run" : configIcon(c),
        detail: sessionDetail(s),
        dim: !s || !busy(s),
      };
    });
    const running = entries.filter((c) => {
      const s = latest.get(c.id);
      return !!s && busy(s);
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
  const configs = useRun((s) => s.configs);
  const sessions = useRun((s) => s.sessions);
  const types = useAddedTypes((s) => s.types);
  const typesRoot = useAddedTypes((s) => s.root);
  useEffect(() => {
    if (typesRoot !== root) useAddedTypes.setState({ root, types: root ? readTypes(root) : [] });
  }, [root, typesRoot]);
  return useMemo(
    () => runServiceItems(configs, sessions, typesRoot === root ? types : []),
    [configs, sessions, types, typesRoot, root],
  );
}

interface Resolved {
  kind: string | null;
  config: RunConfig | null;
  session: RunSession | undefined;
  /** Sessions of a group's configurations. */
  sessions: RunSession[];
}

function resolve(item: ServiceTreeItem): Resolved {
  const { configs, sessions } = useRun.getState();
  const latest = latestSessions(sessions);
  if (item.key.startsWith(TYPE_PREFIX)) {
    const kind = item.key.slice(TYPE_PREFIX.length);
    return { kind, config: null, session: undefined, sessions: sessions.filter((s) => s.config.kind === kind) };
  }
  const id = item.key.slice(CONFIG_PREFIX.length);
  const session = latest.get(id);
  const config = configs.find((c) => c.id === id) ?? session?.config ?? null;
  return { kind: config?.kind ?? null, config, session, sessions: session ? [session] : [] };
}

function showOutput(s: RunSession) {
  useRun.setState({ activeSession: s.id });
  toolWindowService().show("run", true);
}

/** Runs (or reruns, in its tab) a configuration; the output stays in Services instead of opening Run. */
function run(r: Resolved) {
  if (r.session && r.session.config.id === r.config?.id)
    void startRun(r.session.config, r.session.id, r.session.baseConfig, { show: false });
  else if (r.config) void startRun(r.config, undefined, undefined, { show: false });
}

function debug(r: Resolved) {
  if (r.config) void executeAction("run.debugConfig", r.config);
}

function actions(item: ServiceTreeItem): ServiceItemAction[] {
  const r = resolve(item);
  const running = r.sessions.filter(busy);
  const stop = {
    id: "stop",
    title: "Stop",
    icon: "stop",
    disabled: !running.length,
    run: () => running.forEach((s) => void stopSession(s.id)),
  };
  if (!r.config) return [stop];
  const live = !!r.session && busy(r.session);
  return [
    {
      id: "run",
      title: live ? "Rerun" : "Run",
      icon: live ? "rerun" : "run",
      disabled: isDebugOnly(r.config),
      run: () => run(r),
    },
    { id: "debug", title: "Debug", icon: "debug", run: () => debug(r) },
    stop,
  ];
}

function menu(item: ServiceTreeItem): MenuItem[] {
  const items: MenuItem[] = actions(item).map((a) => ({
    label: a.title,
    icon: a.icon,
    disabled: a.disabled,
    run: a.run,
  }));
  const r = resolve(item);
  if (!r.config && r.kind && currentTypes().includes(r.kind)) {
    const kind = r.kind;
    items.push({ kind: "separator" }, { label: "Remove from Services", icon: "close", run: () => removeType(kind) });
  }
  if (r.config) {
    const config = r.config;
    const session = r.session;
    items.push(
      { kind: "separator" },
      {
        label: "Show in Run Tool Window",
        icon: "toolwindow-run",
        disabled: !session,
        run: () => session && showOutput(session),
      },
      { label: "Edit Configuration…", icon: "edit", run: () => void executeAction("run.editConfigs", config.id) },
    );
  }
  return items;
}

function RunDetail({ item }: { item: ServiceTreeItem }) {
  // Re-render on session changes.
  useRun((s) => s.sessions);
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
  if (r.session) return <SessionPanel session={r.session} />;
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

/** "Add Service › Run Configuration Type": the project's types first, then the rest. */
function addMenu(): MenuItem[] {
  const added = currentTypes();
  const used = [...new Set(useRun.getState().configs.map((c) => c.kind))];
  const known = [...KIND_OPTIONS.map((o) => o.value), ...useRunConfigTypes.getState().types.keys()];
  const kinds = [...new Set([...used, ...known])].filter((k) => k !== "compound" && !added.includes(k));
  const item = (kind: string): MenuItem => ({
    label: kindLabel(kind),
    icon: configIcon({ kind, isTest: false }),
    run: () => addType(kind),
  });
  const submenu: MenuItem[] = [
    ...kinds.filter((k) => used.includes(k)).map(item),
    ...(used.some((k) => kinds.includes(k)) ? [{ kind: "separator" } as MenuItem] : []),
    ...kinds
      .filter((k) => !used.includes(k))
      .sort((a, b) => kindLabel(a).localeCompare(kindLabel(b)))
      .map(item),
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
    if (r.config && !(r.session && busy(r.session)) && !isDebugOnly(r.config)) run(r);
  },
  detail: RunDetail,
  addMenu,
};
