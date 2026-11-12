/**
 * Structured Services detail dashboards and views for Docker containers, Compose
 * projects, images, layers, processes, volumes and networks.
 *
 * Reuses the property-drawer primitives (`DrawerRow`, `DrawerSectionBanner`,
 * `LineProgress`) and binary/SI unit & system-local timezone formatters
 * proven in `openidea-kubernetes` (`ResourceDetails.tsx`).
 */
import { writeClipboardText } from "@/platform/clipboard";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import type {
  DockerContainer,
  DockerContainerStats,
  DockerImage,
  DockerImageLayer,
  DockerNetwork,
  DockerProcessList,
  DockerSnapshot,
  DockerVolume,
} from "@/platform/ipc";
import { call, commands, isTauri } from "@/platform/ipc";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { Button, EmptyState, Icon, IconButton, Spinner, T } from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { notifications } from "@/workbench/contributions";
import {
  containersInNetwork,
  containersUsingImage,
  containersUsingVolume,
  findImageForContainer,
  imageKey,
  imageTagsForId,
  isDevContainer,
  isRunning,
  shortId,
  treeKey,
  type DockerTarget,
} from "./model";
import { canRemove, canRestart, canStart, canStop, execShell, remove, restart, showDetail, start, stop } from "./ops";
import { openContainerLogInEditor } from "./logEditor";
import { containerOp, endpointOf, errorMessage } from "./store";
import { useServicesTree } from "./tree";
import styles from "./Services.module.css";

// ---------------------------------------------------------------------------
// Unit, timestamp & inspect parsers (adapted from openidea-kubernetes)

const UNIT_MULTIPLIERS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  PiB: 1024 ** 5,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  kB: 1000,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  PB: 1000 ** 5,
  K: 1000,
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
};

export function unitsToBytes(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)?$/.exec(raw);
  if (!m) return 0;
  const num = Number.parseFloat(m[1]!);
  if (Number.isNaN(num)) return 0;
  const suffix = m[2] ?? "";
  if (!suffix) return num;
  const mult = UNIT_MULTIPLIERS[suffix] ?? UNIT_MULTIPLIERS[suffix.replace(/B$/i, "")];
  return mult ? num * mult : num;
}

export function bytesToUnits(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  if (idx === 0) return `${Math.round(val)} B`;
  return `${val.toFixed(precision)} ${units[idx]!}`;
}

export function parsePercent(raw: string | undefined | null): number {
  if (!raw) return 0;
  const n = Number.parseFloat(raw.replace(/%/g, "").trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface UsagePair {
  used: string;
  limit: string;
  usedBytes: number;
  limitBytes: number;
  percent: number;
}

export function parseUsagePair(raw: string | undefined | null): UsagePair {
  const parts = (raw ?? "").split("/").map((s) => s.trim());
  const used = parts[0] || "0 B";
  const limit = parts[1] || "0 B";
  const usedBytes = unitsToBytes(used);
  const limitBytes = unitsToBytes(limit);
  const percent = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  return { used, limit, usedBytes, limitBytes, percent };
}

function parseDockerTimestamp(raw?: string | null): number {
  if (!raw) return Number.NaN;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("0001-01-01")) return Number.NaN;
  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) return direct;
  // Docker CLI format: `2026-10-01 09:12:44 +0200 CEST` -> drop trailing timezone name
  const cleaned = trimmed.replace(/\s+[A-Z]{2,5}$/, "");
  return Date.parse(cleaned);
}

/**
 * Formats an ISO or Docker CLI timestamp in the user's system local timezone
 * (`YYYY-MM-DD HH:mm:ss <TZ>`) with relative age.
 */
export function formatCreatedDetailed(raw?: string | null, nowMs = Date.now(), timeZone?: string): string {
  if (!raw) return "—";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("0001-01-01")) return "—";
  const ts = parseDockerTimestamp(trimmed);
  if (Number.isNaN(ts)) return trimmed;
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  const d = new Date(ts);
  try {
    const dtf = new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]));
    const datePart = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    const formatted = p.timeZoneName ? `${datePart} ${p.timeZoneName}` : datePart;
    return `${parts.join(" ")} ago (${formatted})`;
  } catch {
    return `${parts.join(" ")} ago (${trimmed})`;
  }
}

export interface PortMapping {
  hostIp: string;
  hostPort: string | null;
  containerPort: string;
  protocol: string;
  url: string | null;
  label: string;
}

/** Extracts published and exposed ports from `DockerContainer.ports` and `docker inspect` JSON. */
export function parsePortMappings(portsText: string, inspectPorts?: Record<string, unknown> | null): PortMapping[] {
  const seen = new Set<string>();
  const out: PortMapping[] = [];
  const push = (rawHostIp: string, hostPort: string | null, containerPort: string, protocol: string) => {
    const hostIp = rawHostIp === "::" ? "[::]" : rawHostIp;
    const key = `${hostIp}:${hostPort ?? ""}->${containerPort}/${protocol}`;
    if (seen.has(key)) return;
    seen.add(key);
    const browseHost = !hostIp || hostIp === "0.0.0.0" || hostIp === "[::]" ? "localhost" : hostIp;
    const url = hostPort && protocol === "tcp" ? `http://${browseHost}:${hostPort}` : null;
    const label = hostPort
      ? `${hostIp || "0.0.0.0"}:${hostPort} -> ${containerPort}/${protocol}`
      : `${containerPort}/${protocol}`;
    out.push({ hostIp, hostPort, containerPort, protocol, url, label });
  };

  if (inspectPorts && typeof inspectPorts === "object") {
    for (const [spec, bindings] of Object.entries(inspectPorts)) {
      const [cPort = spec, proto = "tcp"] = spec.split("/");
      if (Array.isArray(bindings) && bindings.length > 0) {
        for (const b of bindings) {
          if (b && typeof b === "object") {
            const rec = b as Record<string, unknown>;
            const ip = typeof rec.HostIp === "string" ? rec.HostIp : "0.0.0.0";
            const hp = typeof rec.HostPort === "string" && rec.HostPort ? rec.HostPort : null;
            push(ip, hp, cPort, proto);
          }
        }
      } else {
        push("", null, cPort, proto);
      }
    }
  }

  for (const seg of (portsText ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const arrow = seg.indexOf("->");
    if (arrow > 0) {
      const left = seg.slice(0, arrow);
      const right = seg.slice(arrow + 2);
      const [cPort = right, proto = "tcp"] = right.split("/");
      const colon = left.lastIndexOf(":");
      const hostIp = colon >= 0 ? left.slice(0, colon) : "0.0.0.0";
      const hostPort = colon >= 0 ? left.slice(colon + 1) : left;
      push(hostIp, hostPort, cPort, proto);
    } else {
      const [cPort = seg, proto = "tcp"] = seg.split("/");
      push("", null, cPort, proto);
    }
  }
  return out;
}

const DOCKERFILE_INSTRUCTIONS = new Set([
  "FROM",
  "RUN",
  "CMD",
  "LABEL",
  "MAINTAINER",
  "EXPOSE",
  "ENV",
  "ADD",
  "COPY",
  "ENTRYPOINT",
  "VOLUME",
  "USER",
  "WORKDIR",
  "ARG",
  "ONBUILD",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "SHELL",
]);

/** Cleans `docker image history` `CreatedBy` text into `{ instruction, args }`. */
export function splitLayerInstruction(createdBy: string): { instruction: string; args: string } {
  let text = (createdBy ?? "").trim();
  text = text.replace(/\s*#\s*buildkit\s*$/i, "");
  if (text.startsWith("/bin/sh -c #(nop)")) {
    text = text.slice("/bin/sh -c #(nop)".length).trim();
  } else if (text.startsWith("/bin/sh -c")) {
    const body = text.slice("/bin/sh -c".length).trim();
    return { instruction: "RUN", args: body || text };
  }
  const space = text.search(/\s/);
  if (space < 0) {
    const upper = text.toUpperCase();
    return DOCKERFILE_INSTRUCTIONS.has(upper) ? { instruction: upper, args: "" } : { instruction: "LAYER", args: text };
  }
  const first = text.slice(0, space).toUpperCase();
  const rest = text.slice(space + 1).trim();
  if (DOCKERFILE_INSTRUCTIONS.has(first)) {
    return { instruction: first, args: rest };
  }
  return { instruction: "RUN", args: text };
}

export interface ContainerMountInfo {
  type: string;
  name?: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

export interface ContainerNetworkInfo {
  name: string;
  ipAddress: string;
  gateway: string;
  macAddress: string;
}

export interface ParsedContainerInspect {
  created: string;
  imageId: string;
  restartPolicy: string;
  networkMode: string;
  privileged: boolean;
  pid: number | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  healthStatus: string | null;
  user: string;
  workingDir: string;
  entrypoint: string[];
  cmd: string[];
  env: Array<[string, string]>;
  mounts: ContainerMountInfo[];
  networks: ContainerNetworkInfo[];
  ports: PortMapping[];
  labels: Array<[string, string]>;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function splitEnvList(raw: unknown): Array<[string, string]> {
  return asStringArray(raw).map((entry) => {
    const eq = entry.indexOf("=");
    return eq >= 0 ? [entry.slice(0, eq), entry.slice(eq + 1)] : [entry, ""];
  });
}

function recordEntries(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function parseContainerInspect(raw: string | null, fallbackPorts = ""): ParsedContainerInspect | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") return null;
    const state = (obj.State as Record<string, unknown> | undefined) ?? {};
    const config = (obj.Config as Record<string, unknown> | undefined) ?? {};
    const hostConfig = (obj.HostConfig as Record<string, unknown> | undefined) ?? {};
    const netSettings = (obj.NetworkSettings as Record<string, unknown> | undefined) ?? {};
    const restart = (hostConfig.RestartPolicy as Record<string, unknown> | undefined) ?? {};
    const restartName = typeof restart.Name === "string" && restart.Name ? restart.Name : "no";
    const maxRetry =
      typeof restart.MaximumRetryCount === "number" && restart.MaximumRetryCount > 0
        ? `:${restart.MaximumRetryCount}`
        : "";
    const health = (state.Health as Record<string, unknown> | undefined) ?? {};

    const mountsRaw = Array.isArray(obj.Mounts) ? obj.Mounts : [];
    const mounts: ContainerMountInfo[] = mountsRaw
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map((m) => ({
        type: typeof m.Type === "string" ? m.Type : "volume",
        name: typeof m.Name === "string" && m.Name ? m.Name : undefined,
        source: typeof m.Source === "string" ? m.Source : "",
        destination: typeof m.Destination === "string" ? m.Destination : "",
        mode: typeof m.Mode === "string" ? m.Mode : "",
        rw: m.RW !== false,
      }));

    const netsObj = (netSettings.Networks as Record<string, unknown> | undefined) ?? {};
    const networks: ContainerNetworkInfo[] = Object.entries(netsObj)
      .filter(([, v]) => !!v && typeof v === "object")
      .map(([name, v]) => {
        const n = v as Record<string, unknown>;
        return {
          name,
          ipAddress: typeof n.IPAddress === "string" ? n.IPAddress : "",
          gateway: typeof n.Gateway === "string" ? n.Gateway : "",
          macAddress: typeof n.MacAddress === "string" ? n.MacAddress : "",
        };
      });

    const portsObj =
      (netSettings.Ports as Record<string, unknown> | undefined) ??
      (hostConfig.PortBindings as Record<string, unknown> | undefined) ??
      null;

    return {
      created: typeof obj.Created === "string" ? obj.Created : "",
      imageId: typeof obj.Image === "string" ? obj.Image : "",
      restartPolicy: `${restartName}${maxRetry}`,
      networkMode: typeof hostConfig.NetworkMode === "string" ? hostConfig.NetworkMode : "",
      privileged: hostConfig.Privileged === true,
      pid: typeof state.Pid === "number" && state.Pid > 0 ? state.Pid : null,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      startedAt: typeof state.StartedAt === "string" ? state.StartedAt : "",
      finishedAt: typeof state.FinishedAt === "string" ? state.FinishedAt : "",
      healthStatus: typeof health.Status === "string" ? health.Status : null,
      user: typeof config.User === "string" ? config.User : "",
      workingDir: typeof config.WorkingDir === "string" ? config.WorkingDir : "",
      entrypoint: asStringArray(config.Entrypoint),
      cmd: asStringArray(config.Cmd),
      env: splitEnvList(config.Env),
      mounts,
      networks,
      ports: parsePortMappings(fallbackPorts, portsObj),
      labels: recordEntries(config.Labels),
    };
  } catch {
    return null;
  }
}

export interface ParsedImageInspect {
  created: string;
  size: number;
  architecture: string;
  os: string;
  author: string;
  dockerVersion: string;
  repoTags: string[];
  repoDigests: string[];
  user: string;
  workingDir: string;
  entrypoint: string[];
  cmd: string[];
  exposedPorts: string[];
  volumes: string[];
  env: Array<[string, string]>;
  labels: Array<[string, string]>;
}

export function parseImageInspect(raw: string | null): ParsedImageInspect | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") return null;
    const config = (obj.Config as Record<string, unknown> | undefined) ?? {};
    const exposed =
      config.ExposedPorts && typeof config.ExposedPorts === "object"
        ? Object.keys(config.ExposedPorts as Record<string, unknown>).sort()
        : [];
    const volumes =
      config.Volumes && typeof config.Volumes === "object"
        ? Object.keys(config.Volumes as Record<string, unknown>).sort()
        : [];
    return {
      created: typeof obj.Created === "string" ? obj.Created : "",
      size: typeof obj.Size === "number" ? obj.Size : 0,
      architecture: typeof obj.Architecture === "string" ? obj.Architecture : "",
      os: typeof obj.Os === "string" ? obj.Os : "",
      author: typeof obj.Author === "string" ? obj.Author : "",
      dockerVersion: typeof obj.DockerVersion === "string" ? obj.DockerVersion : "",
      repoTags: asStringArray(obj.RepoTags),
      repoDigests: asStringArray(obj.RepoDigests),
      user: typeof config.User === "string" ? config.User : "",
      workingDir: typeof config.WorkingDir === "string" ? config.WorkingDir : "",
      entrypoint: asStringArray(config.Entrypoint),
      cmd: asStringArray(config.Cmd),
      exposedPorts: exposed,
      volumes,
      env: splitEnvList(config.Env),
      labels: recordEntries(config.Labels),
    };
  } catch {
    return null;
  }
}

export interface ParsedNetworkInspect {
  created: string;
  ipamConfigs: Array<{ subnet: string; gateway: string }>;
  containers: Array<{ id: string; name: string; ipv4Address: string; macAddress: string }>;
  options: Array<[string, string]>;
  labels: Array<[string, string]>;
}

export function parseNetworkInspect(raw: string | null): ParsedNetworkInspect | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") return null;
    const ipam = (obj.IPAM as Record<string, unknown> | undefined) ?? {};
    const ipamRaw = Array.isArray(ipam.Config) ? ipam.Config : [];
    const ipamConfigs = ipamRaw
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        subnet: typeof c.Subnet === "string" ? c.Subnet : "",
        gateway: typeof c.Gateway === "string" ? c.Gateway : "",
      }))
      .filter((c) => c.subnet || c.gateway);
    const containersObj = (obj.Containers as Record<string, unknown> | undefined) ?? {};
    const containers = Object.entries(containersObj)
      .filter(([, v]) => !!v && typeof v === "object")
      .map(([id, v]) => {
        const c = v as Record<string, unknown>;
        return {
          id,
          name: typeof c.Name === "string" ? c.Name : shortId(id),
          ipv4Address: typeof c.IPv4Address === "string" ? c.IPv4Address : "",
          macAddress: typeof c.MacAddress === "string" ? c.MacAddress : "",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      created: typeof obj.Created === "string" ? obj.Created : "",
      ipamConfigs,
      containers,
      options: recordEntries(obj.Options),
      labels: recordEntries(obj.Labels),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared UI primitives (adapted from openidea-kubernetes ResourceDetails.tsx)

const copyText = (text: string) => void writeClipboardText(text);

async function openExternalUrl(url: string): Promise<void> {
  try {
    if (isTauri()) {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  } catch (e) {
    notifications().notify({ group: "run", level: "error", title: "Cannot open link", body: String(e) });
  }
}

export function selectServicesTreeKey(key: string): void {
  useServicesTree.setState((s) => {
    const expanded = new Set(s.expanded);
    // Ensure parent connection and group nodes are expanded so the target row is visible.
    const parts = key.split(":");
    if (parts.length >= 2) expanded.add(`${parts[0]!}:${parts[1]!}`);
    if (parts.length >= 4) {
      const kind = parts[2]!;
      const group =
        kind === "container" || kind === "compose"
          ? "containers"
          : kind === "image"
            ? "images"
            : kind === "volume"
              ? "volumes"
              : kind === "network"
                ? "networks"
                : null;
      if (group) expanded.add(`${parts[0]!}:${parts[1]!}:group:${group}`);
    }
    return { selectedKey: key, selectedKeys: new Set([key]), expanded };
  });
}

function SectionBanner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.sectionBanner}>
      <span>{children}</span>
      {action}
    </div>
  );
}

function PropRow({ label, children, hidden }: { label: ReactNode; children: ReactNode; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <div className={styles.propRow}>
      <div className={styles.propName}>{label}</div>
      <div className={styles.propVal}>{children}</div>
    </div>
  );
}

function LineProgress({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const tone = clamped >= 90 ? styles.progressDanger : clamped >= 75 ? styles.progressWarning : styles.progressNormal;
  return (
    <div className={styles.lineProgress}>
      <div
        className={clsx(styles.lineProgressFill, tone)}
        style={{ width: `${clamped > 0 ? Math.max(2, clamped) : 0}%` }}
      />
    </div>
  );
}

function StatusBadge({ state, text }: { state: string; text?: string }) {
  const s = state.toLowerCase();
  const tone =
    s === "running" || s === "healthy"
      ? styles.badgeOk
      : s === "paused" || s === "restarting" || s === "starting"
        ? styles.badgeWarn
        : s === "dead" || s === "unhealthy" || s === "removing"
          ? styles.badgeDanger
          : styles.badgeMuted;
  return <span className={clsx(styles.statusBadge, tone)}>{text ?? state}</span>;
}

function KeyValueTable({ rows, emptyText }: { rows: ReadonlyArray<readonly [string, string]>; emptyText?: ReactNode }) {
  if (!rows.length) {
    return emptyText ? <div className={styles.emptySection}>{emptyText}</div> : null;
  }
  return (
    <div className={styles.kvTable} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
      {rows.map(([k, v]) => (
        <div key={k} className={styles.kvRow}>
          <span className={styles.kvKey} title={k}>
            {k}
          </span>
          <span className={styles.kvVal} title={v}>
            {v || "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function ContainerLinkChip({ conn, container }: { conn: string; container: DockerContainer }) {
  const running = isRunning(container);
  const key = treeKey(conn, { kind: "container", key: `container:${container.id}`, container });
  const parentKey = container.composeProject
    ? `docker:${conn}:compose:${container.composeProject}`
    : isDevContainer(container)
      ? `docker:${conn}:group:devContainers`
      : `docker:${conn}:group:containers`;
  return (
    <button
      type="button"
      className={styles.entityChip}
      onClick={() => {
        useServicesTree.setState((s) => {
          const expanded = new Set(s.expanded);
          expanded.add(`docker:${conn}`);
          expanded.add(parentKey);
          return { selectedKey: key, selectedKeys: new Set([key]), expanded };
        });
        showDetail("dashboard");
      }}
    >
      <span className={clsx(styles.statusDot, running ? styles.dotOk : styles.dotMuted)} />
      <span className={styles.mono}>{container.name}</span>
      <span className={styles.chipMeta}>{container.status}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Container Dashboard & Processes View

export function ContainerDashboard({
  conn,
  container,
  snapshot,
  inspectText,
}: {
  conn: string;
  container: DockerContainer;
  snapshot: DockerSnapshot;
  inspectText: string | null;
}) {
  const running = isRunning(container);
  const target: DockerTarget = {
    conn,
    node: { kind: "container", key: `container:${container.id}`, container },
  };
  const inspect = useMemo(() => parseContainerInspect(inspectText, container.ports), [inspectText, container.ports]);
  const ports = useMemo(() => inspect?.ports ?? parsePortMappings(container.ports), [inspect, container.ports]);
  const matchedImage = useMemo(() => findImageForContainer(snapshot, container), [snapshot, container]);

  const [stats, setStats] = useState<DockerContainerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    if (!running || !isTauri()) return;
    let alive = true;
    call(commands.dockerContainerStats(endpointOf(conn), container.id))
      .then((s) => alive && setStats(s))
      .catch(() => alive && setStats(null));
    return () => {
      alive = false;
    };
  }, [conn, container.id, running]);

  const reloadStats = useCallback(() => {
    if (!running || !isTauri()) return;
    setStatsLoading(true);
    call(commands.dockerContainerStats(endpointOf(conn), container.id))
      .then((s) => setStats(s))
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false));
  }, [conn, container.id, running]);

  const cpuPct = stats ? parsePercent(stats.cpuPerc) : 0;
  const memPair = stats ? parseUsagePair(stats.memUsage) : null;
  const labels = inspect?.labels.length ? inspect.labels : Object.entries(container.labels ?? {});

  return (
    <div className={styles.dashboard} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
      <div className={styles.dashboardActions}>
        <Button size="small" disabled={!canStart(target)} onClick={() => void start(target)}>
          Start
        </Button>
        <Button size="small" disabled={!canStop(target)} onClick={() => void stop(target)}>
          Stop
        </Button>
        <Button size="small" disabled={!canRestart(target)} onClick={() => void restart(target)}>
          Restart
        </Button>
        {container.state === "paused" ? (
          <Button size="small" onClick={() => void containerOp(conn, [container.id], "unpause")}>
            Unpause
          </Button>
        ) : (
          <Button size="small" disabled={!running} onClick={() => void containerOp(conn, [container.id], "pause")}>
            Pause
          </Button>
        )}
        <Button size="small" disabled={!running} onClick={() => execShell(target)}>
          Create Terminal
        </Button>
        <Button size="small" onClick={() => showDetail("log")}>
          Show Log
        </Button>
        <Button size="small" onClick={() => openContainerLogInEditor(conn, container)}>
          Open Log in Editor
        </Button>
        <Button size="small" disabled={!canRemove(target)} onClick={() => void remove(target)}>
          Delete…
        </Button>
      </div>

      <SectionBanner>
        <T>Container Overview</T>
      </SectionBanner>
      <div className={styles.propList}>
        <PropRow label={<T>Name</T>}>
          <span className={styles.mono}>{container.name}</span>
        </PropRow>
        <PropRow label={<T>Container ID</T>}>
          <span className={styles.inlineRow}>
            <span className={styles.mono} title={container.id}>
              {shortId(container.id)}
            </span>
            <IconButton icon="copy" size="small" title="Copy Container ID" onClick={() => copyText(container.id)} />
          </span>
        </PropRow>
        <PropRow label={<T>Status</T>}>
          <span className={styles.inlineRow}>
            <StatusBadge state={container.state} text={container.status || container.state} />
            {inspect?.healthStatus && <StatusBadge state={inspect.healthStatus} text={inspect.healthStatus} />}
            {inspect?.exitCode !== null && inspect?.exitCode !== undefined && !running && (
              <span className={styles.mutedMeta}>Exit code {inspect.exitCode}</span>
            )}
            {inspect?.pid && <span className={styles.mutedMeta}>PID {inspect.pid}</span>}
          </span>
        </PropRow>
        <PropRow label={<T>Image</T>}>
          <span className={styles.inlineRow}>
            {matchedImage ? (
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  selectServicesTreeKey(
                    treeKey(conn, { kind: "image", key: imageKey(matchedImage), image: matchedImage }),
                  );
                  showDetail("dashboard");
                }}
              >
                <span className={styles.mono}>{container.image}</span>
              </button>
            ) : (
              <span className={styles.mono}>{container.image}</span>
            )}
            <IconButton icon="copy" size="small" title="Copy Image Name" onClick={() => copyText(container.image)} />
          </span>
        </PropRow>
        <PropRow label={<T>Created</T>}>{formatCreatedDetailed(inspect?.created || container.createdAt)}</PropRow>
        <PropRow label={<T>Started</T>} hidden={!inspect?.startedAt || inspect.startedAt.startsWith("0001-01-01")}>
          {formatCreatedDetailed(inspect?.startedAt)}
        </PropRow>
        <PropRow label={<T>Command</T>} hidden={!container.command && !inspect?.cmd.length}>
          <code className={styles.codeInline}>
            {inspect && (inspect.entrypoint.length || inspect.cmd.length)
              ? [...inspect.entrypoint, ...inspect.cmd].join(" ")
              : container.command}
          </code>
        </PropRow>
        <PropRow label={<T>Working directory</T>} hidden={!inspect?.workingDir}>
          <span className={styles.mono}>{inspect?.workingDir}</span>
        </PropRow>
        <PropRow label={<T>User</T>} hidden={!inspect?.user}>
          <span className={styles.mono}>{inspect?.user}</span>
        </PropRow>
        <PropRow label={<T>Restart policy</T>} hidden={!inspect?.restartPolicy}>
          <span className={styles.mono}>{inspect?.restartPolicy}</span>
        </PropRow>
        <PropRow label={<T>Compose</T>} hidden={!container.composeProject}>
          <span className={styles.inlineRow}>
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                if (container.composeProject) {
                  selectServicesTreeKey(
                    treeKey(conn, {
                      kind: "compose",
                      key: `compose:${container.composeProject}`,
                      project: container.composeProject,
                      containers: [],
                    }),
                  );
                }
              }}
            >
              {container.composeProject}
            </button>
            {container.composeService && <span className={styles.mutedMeta}>· {container.composeService}</span>}
          </span>
        </PropRow>
      </div>

      {running && (
        <>
          <SectionBanner
            action={
              <IconButton icon="refresh" size="small" title="Refresh" disabled={statsLoading} onClick={reloadStats} />
            }
          >
            <T>Resource Usage</T>
          </SectionBanner>
          {stats ? (
            <div className={styles.propList}>
              <PropRow label={<T>CPU</T>}>
                <div className={styles.metricBlock}>
                  <span className={styles.mono}>{stats.cpuPerc}</span>
                  <LineProgress percent={cpuPct} />
                </div>
              </PropRow>
              <PropRow label={<T>Memory</T>}>
                <div className={styles.metricBlock}>
                  <span className={styles.mono}>
                    {stats.memUsage} ({stats.memPerc})
                  </span>
                  <LineProgress percent={memPair?.percent ?? parsePercent(stats.memPerc)} />
                </div>
              </PropRow>
              <PropRow label={<T>Network I/O</T>} hidden={!stats.netIo}>
                <span className={styles.mono}>{stats.netIo}</span>
              </PropRow>
              <PropRow label={<T>Block I/O</T>} hidden={!stats.blockIo}>
                <span className={styles.mono}>{stats.blockIo}</span>
              </PropRow>
              <PropRow label={<T>PIDs</T>} hidden={!stats.pids}>
                <span className={styles.mono}>{stats.pids}</span>
              </PropRow>
            </div>
          ) : (
            <div className={styles.emptySection}>
              {statsLoading ? (
                <>
                  <Spinner size={12} /> <T>Loading…</T>
                </>
              ) : (
                <T>Metrics unavailable</T>
              )}
            </div>
          )}
        </>
      )}

      <SectionBanner>
        <T>Port Bindings</T>
      </SectionBanner>
      {ports.length > 0 ? (
        <div className={styles.chipGroup}>
          {ports.map((p) =>
            p.url ? (
              <button
                key={p.label}
                type="button"
                className={clsx(styles.entityChip, styles.portChipLink)}
                title="Open in Browser"
                onClick={() => void openExternalUrl(p.url!)}
              >
                <span className={styles.mono}>{p.label}</span>
                <Icon name="external-link" size={12} />
              </button>
            ) : (
              <span key={p.label} className={styles.entityChip}>
                <span className={styles.mono}>{p.label}</span>
              </span>
            ),
          )}
        </div>
      ) : (
        <div className={styles.emptySection}>
          <T>No port bindings</T>
        </div>
      )}

      <SectionBanner>
        <T>Volume & Bind Mounts</T>
      </SectionBanner>
      {inspect?.mounts && inspect.mounts.length > 0 ? (
        <div className={styles.dataTable}>
          <div className={clsx(styles.dataRow, styles.dataHeader)}>
            <span>
              <T>Type</T>
            </span>
            <span>
              <T>Source</T>
            </span>
            <span>
              <T>Destination</T>
            </span>
            <span>
              <T>Mode</T>
            </span>
          </div>
          {inspect.mounts.map((m, idx) => {
            const volumeObj = m.name ? snapshot.volumes.find((v) => v.name === m.name) : undefined;
            return (
              <div key={`${m.destination}:${idx}`} className={styles.dataRow}>
                <span className={styles.badgeMuted}>{m.type}</span>
                <span className={styles.mono} title={m.source}>
                  {volumeObj ? (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => {
                        selectServicesTreeKey(
                          treeKey(conn, { kind: "volume", key: `volume:${volumeObj.name}`, volume: volumeObj }),
                        );
                        showDetail("dashboard");
                      }}
                    >
                      {volumeObj.name}
                    </button>
                  ) : (
                    m.name || m.source || "—"
                  )}
                </span>
                <span className={styles.mono} title={m.destination}>
                  {m.destination}
                </span>
                <span className={styles.mono}>{m.rw ? m.mode || "rw" : "ro"}</span>
              </div>
            );
          })}
        </div>
      ) : container.mounts && container.mounts.length > 0 ? (
        <div className={styles.chipGroup}>
          {container.mounts.map((m) => {
            const volumeObj = snapshot.volumes.find((v) => v.name === m);
            return volumeObj ? (
              <button
                key={m}
                type="button"
                className={styles.entityChip}
                onClick={() => {
                  selectServicesTreeKey(
                    treeKey(conn, { kind: "volume", key: `volume:${volumeObj.name}`, volume: volumeObj }),
                  );
                  showDetail("dashboard");
                }}
              >
                <Icon name="docker-volumes" size={14} />
                <span className={styles.mono}>{m}</span>
              </button>
            ) : (
              <span key={m} className={styles.entityChip}>
                <span className={styles.mono}>{m}</span>
              </span>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptySection}>
          <T>No mounts</T>
        </div>
      )}

      {inspect?.networks.length || container.networks?.length ? (
        <>
          <SectionBanner>
            <T>Networks</T>
          </SectionBanner>
          <div className={styles.chipGroup}>
            {(inspect?.networks.length
              ? inspect.networks
              : (container.networks ?? []).map((name) => ({ name, ipAddress: "", gateway: "", macAddress: "" }))
            ).map((n) => {
              const netObj = snapshot.networks.find((x) => x.name === n.name);
              return (
                <button
                  key={n.name}
                  type="button"
                  className={styles.entityChip}
                  disabled={!netObj}
                  onClick={() => {
                    if (netObj) {
                      selectServicesTreeKey(
                        treeKey(conn, { kind: "network", key: `network:${netObj.id}`, network: netObj }),
                      );
                      showDetail("dashboard");
                    }
                  }}
                >
                  <Icon name="docker-networks" size={14} />
                  <span className={styles.mono}>{n.name}</span>
                  {n.ipAddress && <span className={styles.chipMeta}>{n.ipAddress}</span>}
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <SectionBanner>
        <T>Environment Variables</T>
      </SectionBanner>
      <KeyValueTable rows={inspect?.env ?? []} emptyText={<T>No environment variables</T>} />

      {labels.length > 0 && (
        <>
          <SectionBanner>
            <T>Labels</T>
          </SectionBanner>
          <KeyValueTable rows={labels} />
        </>
      )}
    </div>
  );
}

export function ContainerProcessesView({ conn, id, running }: { conn: string; id: string; running: boolean }) {
  const tx = useTx();
  const [data, setData] = useState<DockerProcessList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!running || !isTauri()) return;
    let alive = true;
    call(commands.dockerContainerTop(endpointOf(conn), id))
      .then((res) => {
        if (!alive) return;
        setData(res);
        setError(null);
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [conn, id, running]);

  const reload = useCallback(() => {
    if (!running || !isTauri()) return;
    setLoading(true);
    setError(null);
    call(commands.dockerContainerTop(endpointOf(conn), id))
      .then((res) => setData(res))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [conn, id, running]);

  if (!running) {
    return (
      <EmptyState title="Container is not running">
        <T>Start the container to view its running processes.</T>
      </EmptyState>
    );
  }

  return (
    <div className={styles.detailBody}>
      <div className={styles.subToolbar}>
        <span className={styles.subToolbarTitle}>
          <T>Processes</T>
          {data ? ` (${data.processes.length})` : ""}
        </span>
        <IconButton icon="refresh" size="small" title="Refresh" disabled={loading} onClick={reload} />
      </div>
      {error ? (
        <div className={styles.loading}>{error}</div>
      ) : !data ? (
        <div className={styles.loading}>
          <Spinner size={14} /> <T>Loading…</T>
        </div>
      ) : data.processes.length === 0 ? (
        <EmptyState title={tx("No processes reported")} />
      ) : (
        <div className={styles.tableScroll} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
          <table className={styles.gridTable}>
            <thead>
              <tr>
                {data.titles.map((title, i) => (
                  <th key={`${title}:${i}`}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.processes.map((row, rIdx) => (
                <tr key={rIdx}>
                  {data.titles.map((_, cIdx) => (
                    <td key={cIdx} className={styles.mono}>
                      {row[cIdx] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image Dashboard & Layers View

export function ImageDashboard({
  conn,
  image,
  snapshot,
  inspectText,
}: {
  conn: string;
  image: DockerImage;
  snapshot: DockerSnapshot;
  inspectText: string | null;
}) {
  const target: DockerTarget = { conn, node: { kind: "image", key: imageKey(image), image } };
  const inspect = useMemo(() => parseImageInspect(inspectText), [inspectText]);
  const tags = useMemo(() => {
    const fromSnap = imageTagsForId(snapshot, image);
    const fromInspect = inspect?.repoTags ?? [];
    return [...new Set([...fromSnap, ...fromInspect])];
  }, [snapshot, image, inspect]);
  const usingContainers = useMemo(() => containersUsingImage(snapshot, image), [snapshot, image]);

  return (
    <div className={styles.dashboard} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
      <div className={styles.dashboardActions}>
        <Button size="small" onClick={() => showDetail("layers")}>
          Show Layers
        </Button>
        <Button size="small" onClick={() => showDetail("inspect")}>
          Inspect
        </Button>
        <Button size="small" disabled={!canRemove(target)} onClick={() => void remove(target)}>
          Delete…
        </Button>
      </div>

      <SectionBanner>
        <T>Image Overview</T>
      </SectionBanner>
      <div className={styles.propList}>
        <PropRow label={<T>Repository</T>}>
          <span className={styles.mono}>{image.repository}</span>
        </PropRow>
        <PropRow label={<T>Tag</T>}>
          <span className={styles.mono}>{image.tag}</span>
        </PropRow>
        <PropRow label={<T>Image ID</T>}>
          <span className={styles.inlineRow}>
            <span className={styles.mono} title={image.id}>
              {shortId(image.id)}
            </span>
            <IconButton icon="copy" size="small" title="Copy Image ID" onClick={() => copyText(shortId(image.id))} />
          </span>
        </PropRow>
        <PropRow label={<T>Size</T>}>
          <span className={styles.mono}>
            {inspect?.size ? `${bytesToUnits(inspect.size)} (${image.size})` : image.size}
          </span>
        </PropRow>
        <PropRow label={<T>Created</T>}>
          {inspect?.created ? formatCreatedDetailed(inspect.created) : image.createdSince}
        </PropRow>
        <PropRow label={<T>Platform</T>} hidden={!inspect?.os && !inspect?.architecture}>
          <span className={styles.mono}>{[inspect?.os, inspect?.architecture].filter(Boolean).join("/")}</span>
        </PropRow>
        <PropRow label={<T>Command</T>} hidden={!inspect?.entrypoint.length && !inspect?.cmd.length}>
          <code className={styles.codeInline}>
            {[...(inspect?.entrypoint ?? []), ...(inspect?.cmd ?? [])].join(" ")}
          </code>
        </PropRow>
        <PropRow label={<T>Working directory</T>} hidden={!inspect?.workingDir}>
          <span className={styles.mono}>{inspect?.workingDir}</span>
        </PropRow>
        <PropRow label={<T>User</T>} hidden={!inspect?.user}>
          <span className={styles.mono}>{inspect?.user}</span>
        </PropRow>
        <PropRow label={<T>Exposed ports</T>} hidden={!inspect?.exposedPorts.length}>
          <div className={styles.chipGroupInline}>
            {inspect?.exposedPorts.map((p) => (
              <span key={p} className={styles.entityChip}>
                <span className={styles.mono}>{p}</span>
              </span>
            ))}
          </div>
        </PropRow>
      </div>

      {tags.length > 0 && (
        <>
          <SectionBanner>
            <T>Tags</T>
          </SectionBanner>
          <div className={styles.chipGroup}>
            {tags.map((t) => (
              <span key={t} className={styles.entityChip}>
                <span className={styles.mono}>{t}</span>
              </span>
            ))}
          </div>
        </>
      )}

      <SectionBanner>
        <T>Containers Using Image</T>
      </SectionBanner>
      {usingContainers.length > 0 ? (
        <div className={styles.chipGroup}>
          {usingContainers.map((c) => (
            <ContainerLinkChip key={c.id} conn={conn} container={c} />
          ))}
        </div>
      ) : (
        <div className={styles.emptySection}>
          <T>No containers are using this image</T>
        </div>
      )}

      {inspect?.env && inspect.env.length > 0 && (
        <>
          <SectionBanner>
            <T>Environment Variables</T>
          </SectionBanner>
          <KeyValueTable rows={inspect.env} />
        </>
      )}

      {inspect?.labels && inspect.labels.length > 0 && (
        <>
          <SectionBanner>
            <T>Labels</T>
          </SectionBanner>
          <KeyValueTable rows={inspect.labels} />
        </>
      )}
    </div>
  );
}

export function ImageLayersView({ conn, id }: { conn: string; id: string }) {
  const tx = useTx();
  const [layers, setLayers] = useState<DockerImageLayer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    call(commands.dockerImageHistory(endpointOf(conn), id))
      .then((res) => alive && setLayers(res))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [conn, id]);

  const maxBytes = useMemo(() => Math.max(1, ...(layers ?? []).map((l) => unitsToBytes(l.size))), [layers]);

  if (error) return <div className={styles.loading}>{error}</div>;
  if (!layers) {
    return (
      <div className={styles.loading}>
        <Spinner size={14} /> <T>Loading…</T>
      </div>
    );
  }
  if (layers.length === 0) return <EmptyState title={tx("No image layers")} />;

  return (
    <div className={styles.detailBody}>
      <div className={styles.tableScroll} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
        <table className={styles.gridTable}>
          <thead>
            <tr>
              <th>#</th>
              <th>
                <T>Instruction</T>
              </th>
              <th>
                <T>Command</T>
              </th>
              <th>
                <T>Size</T>
              </th>
              <th>
                <T>Created</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {layers.map((layer, idx) => {
              const { instruction, args } = splitLayerInstruction(layer.createdBy);
              const bytes = unitsToBytes(layer.size);
              const pct = bytes > 0 ? (bytes / maxBytes) * 100 : 0;
              return (
                <tr key={`${layer.id}:${idx}`}>
                  <td className={styles.mutedMeta}>{idx + 1}</td>
                  <td>
                    <span className={clsx(styles.statusBadge, styles.badgeMuted)}>{instruction}</span>
                  </td>
                  <td className={styles.layerCmd} title={layer.createdBy}>
                    <code>{args || layer.createdBy}</code>
                  </td>
                  <td className={styles.layerSizeCell}>
                    <div className={styles.metricBlock}>
                      <span className={styles.mono}>{layer.size}</span>
                      {bytes > 0 && <LineProgress percent={pct} />}
                    </div>
                  </td>
                  <td className={styles.mutedMeta}>{layer.createdSince}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Volume, Network & Compose Project Dashboards

export function VolumeDashboard({
  conn,
  volume,
  snapshot,
}: {
  conn: string;
  volume: DockerVolume;
  snapshot: DockerSnapshot;
}) {
  const target: DockerTarget = { conn, node: { kind: "volume", key: `volume:${volume.name}`, volume } };
  const usingContainers = useMemo(() => containersUsingVolume(snapshot, volume), [snapshot, volume]);
  const labels = Object.entries(volume.labels ?? {}).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className={styles.dashboard} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
      <div className={styles.dashboardActions}>
        <Button size="small" onClick={() => showDetail("inspect")}>
          Inspect
        </Button>
        <Button size="small" disabled={!canRemove(target)} onClick={() => void remove(target)}>
          Delete…
        </Button>
      </div>

      <SectionBanner>
        <T>Volume Overview</T>
      </SectionBanner>
      <div className={styles.propList}>
        <PropRow label={<T>Name</T>}>
          <span className={styles.mono}>{volume.name}</span>
        </PropRow>
        <PropRow label={<T>Driver</T>}>
          <span className={styles.mono}>{volume.driver}</span>
        </PropRow>
        <PropRow label={<T>Scope</T>} hidden={!volume.scope}>
          <span className={styles.mono}>{volume.scope}</span>
        </PropRow>
        <PropRow label={<T>Mountpoint</T>} hidden={!volume.mountpoint}>
          <span className={styles.inlineRow}>
            <span className={styles.mono} title={volume.mountpoint}>
              {volume.mountpoint}
            </span>
            <IconButton icon="copy" size="small" title="Copy Path" onClick={() => copyText(volume.mountpoint)} />
          </span>
        </PropRow>
        <PropRow label={<T>Compose</T>} hidden={!volume.composeProject}>
          <span className={styles.mono}>{volume.composeProject}</span>
        </PropRow>
      </div>

      <SectionBanner>
        <T>Containers Using Volume</T>
      </SectionBanner>
      {usingContainers.length > 0 ? (
        <div className={styles.chipGroup}>
          {usingContainers.map((c) => (
            <ContainerLinkChip key={c.id} conn={conn} container={c} />
          ))}
        </div>
      ) : (
        <div className={styles.emptySection}>
          <T>No containers are using this volume</T>
        </div>
      )}

      {labels.length > 0 && (
        <>
          <SectionBanner>
            <T>Labels</T>
          </SectionBanner>
          <KeyValueTable rows={labels} />
        </>
      )}
    </div>
  );
}

export function NetworkDashboard({
  conn,
  network,
  snapshot,
  inspectText,
}: {
  conn: string;
  network: DockerNetwork;
  snapshot: DockerSnapshot;
  inspectText: string | null;
}) {
  const target: DockerTarget = { conn, node: { kind: "network", key: `network:${network.id}`, network } };
  const inspect = useMemo(() => parseNetworkInspect(inspectText), [inspectText]);
  const connected = useMemo(() => containersInNetwork(snapshot, network), [snapshot, network]);
  const labels = inspect?.labels.length
    ? inspect.labels
    : Object.entries(network.labels ?? {}).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className={styles.dashboard} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
      <div className={styles.dashboardActions}>
        <Button size="small" onClick={() => showDetail("inspect")}>
          Inspect
        </Button>
        <Button size="small" disabled={!canRemove(target)} onClick={() => void remove(target)}>
          Delete…
        </Button>
      </div>

      <SectionBanner>
        <T>Network Overview</T>
      </SectionBanner>
      <div className={styles.propList}>
        <PropRow label={<T>Name</T>}>
          <span className={styles.mono}>{network.name}</span>
        </PropRow>
        <PropRow label={<T>Network ID</T>}>
          <span className={styles.inlineRow}>
            <span className={styles.mono} title={network.id}>
              {shortId(network.id)}
            </span>
            <IconButton icon="copy" size="small" title="Copy" onClick={() => copyText(network.id)} />
          </span>
        </PropRow>
        <PropRow label={<T>Driver</T>}>
          <span className={styles.mono}>{network.driver}</span>
        </PropRow>
        <PropRow label={<T>Scope</T>}>
          <span className={styles.mono}>{network.scope}</span>
        </PropRow>
        <PropRow label={<T>Created</T>} hidden={!inspect?.created && !network.createdAt}>
          {formatCreatedDetailed(inspect?.created || network.createdAt)}
        </PropRow>
        <PropRow label={<T>Subnet / Gateway</T>} hidden={!inspect?.ipamConfigs.length}>
          <div className={styles.chipGroupInline}>
            {inspect?.ipamConfigs.map((cfg, idx) => (
              <span key={idx} className={styles.entityChip}>
                <span className={styles.mono}>
                  {[cfg.subnet, cfg.gateway ? `gw ${cfg.gateway}` : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
            ))}
          </div>
        </PropRow>
        <PropRow label={<T>Compose</T>} hidden={!network.composeProject}>
          <span className={styles.mono}>{network.composeProject}</span>
        </PropRow>
      </div>

      <SectionBanner>
        <T>Connected Containers</T>
      </SectionBanner>
      {connected.length > 0 ? (
        <div className={styles.chipGroup}>
          {connected.map((c) => {
            const ipInfo = inspect?.containers.find((ic) => ic.id === c.id || ic.name === c.name);
            return (
              <span key={c.id} className={styles.inlineRow}>
                <ContainerLinkChip conn={conn} container={c} />
                {ipInfo?.ipv4Address && <span className={styles.mutedMeta}>{ipInfo.ipv4Address}</span>}
              </span>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptySection}>
          <T>No containers are connected to this network</T>
        </div>
      )}

      {labels.length > 0 && (
        <>
          <SectionBanner>
            <T>Labels</T>
          </SectionBanner>
          <KeyValueTable rows={labels} />
        </>
      )}
    </div>
  );
}

export function ComposeProjectDashboard({
  conn,
  project,
  containers,
}: {
  conn: string;
  project: string;
  containers: DockerContainer[];
}) {
  const txTemplate = useTxTemplate();
  const target: DockerTarget = {
    conn,
    node: { kind: "compose", key: `compose:${project}`, project, containers },
  };
  const first = containers[0];
  const runningCount = containers.filter(isRunning).length;

  return (
    <div className={styles.dashboard} tabIndex={0} onKeyDown={copySelectionOnKeyDown}>
      <div className={styles.dashboardActions}>
        <Button size="small" disabled={!canStart(target)} onClick={() => void start(target)}>
          Start
        </Button>
        <Button size="small" disabled={!canStop(target)} onClick={() => void stop(target)}>
          Stop
        </Button>
        <Button size="small" disabled={!canRestart(target)} onClick={() => void restart(target)}>
          Restart
        </Button>
        <Button size="small" disabled={!canRemove(target)} onClick={() => void remove(target)}>
          Compose Down
        </Button>
      </div>

      <SectionBanner>{txTemplate(`Compose project '${project}'`)}</SectionBanner>
      <div className={styles.propList}>
        <PropRow label={<T>Project</T>}>
          <span className={styles.mono}>{project}</span>
        </PropRow>
        <PropRow label={<T>Status</T>}>
          <span>
            {runningCount}/{containers.length} running
          </span>
        </PropRow>
        <PropRow label={<T>Working directory</T>} hidden={!first?.composeWorkingDir}>
          <span className={styles.mono}>{first?.composeWorkingDir}</span>
        </PropRow>
        <PropRow label={<T>Compose files</T>} hidden={!first?.composeFiles.length}>
          <span className={styles.mono}>{first?.composeFiles.join(", ")}</span>
        </PropRow>
      </div>

      <SectionBanner>
        <T>Services</T>
      </SectionBanner>
      <div className={styles.chipGroup}>
        {containers.map((c) => (
          <ContainerLinkChip key={c.id} conn={conn} container={c} />
        ))}
      </div>
    </div>
  );
}
