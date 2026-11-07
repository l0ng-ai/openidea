import React, { useMemo, useState } from "react";
import type { ClusterEvent, ClusterResource } from "./types";

export interface ResourceDetailsProps {
  selectedResource: ClusterResource;
  drawerJson: any | null;
  allResources: ClusterResource[];
  allEvents: ClusterEvent[];
  extraPods: ClusterResource[];
  extraResources: ClusterResource[];
  extraEvents: ClusterEvent[];
  formatCreatedDetailed: (iso?: string) => string;
  formatAgeShort: (iso?: string) => string;
  statusClass: (status: string) => string;
  onSelectNamespace: (ns: string) => void;
  onSelectKind?: (kind: string) => void;
  onOpenResourceByRef: (kind: string, name: string, namespace?: string) => void;
  onPortForward: (kind: string, namespace: string, name: string, port: string) => void;
}

const BINARY_PREFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  K: 1000,
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
};

export function unitsToBytes(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  const m = raw.match(/^([0-9.]+)\s*([A-Za-z]+)?$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return 0;
  const suffix = m[2] || "";
  if (!suffix) return num;
  const cleanSuffix = suffix.replace(/B$/, "");
  const mult = BINARY_PREFIXES[cleanSuffix] ?? BINARY_PREFIXES[suffix];
  return mult ? num * mult : num;
}

export function bytesToUnits(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  if (idx === 0) return `${Math.round(val)}B`;
  return `${val.toFixed(precision)}${units[idx]}`;
}

export function formatKubeMemory(raw: string | number | undefined | null): { display: string; tooltip?: string } {
  if (raw === undefined || raw === null) return { display: "-" };
  const str = String(raw).trim();
  const bytes = unitsToBytes(str);
  if (bytes <= 0) return { display: str };
  const formatted = bytesToUnits(bytes, 1);
  return { display: formatted, tooltip: formatted !== str ? str : undefined };
}

export function cpuUnitsToNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const str = String(value).trim();
  if (!str) return 0;
  if (str.endsWith("m")) {
    const n = parseFloat(str.slice(0, -1));
    return Number.isNaN(n) ? 0 : n / 1000;
  }
  if (str.endsWith("n")) {
    const n = parseFloat(str.slice(0, -1));
    return Number.isNaN(n) ? 0 : n / 1_000_000_000;
  }
  const n = parseFloat(str);
  return Number.isNaN(n) ? 0 : n;
}

function formatDurationSeconds(seconds?: number | null): string {
  if (seconds === undefined || seconds === null) return "-";
  const sec = Math.max(0, Math.floor(Number(seconds)));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function startCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_./]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatProbe(probe: any): string[] {
  if (!probe || typeof probe !== "object") return [];
  const out: string[] = [];
  if (probe.httpGet) {
    const { scheme = "HTTP", host = "", port = "", path = "/" } = probe.httpGet;
    out.push(`http-get ${scheme.toLowerCase()}://${host}:${port}${path}`);
  } else if (probe.exec?.command) {
    out.push(`exec [${(probe.exec.command as string[]).join(" ")}]`);
  } else if (probe.tcpSocket) {
    out.push(`tcp-socket :${probe.tcpSocket.port ?? ""}`);
  } else if (probe.grpc) {
    out.push(`grpc :${probe.grpc.port ?? ""}`);
  }
  out.push(`delay=${probe.initialDelaySeconds ?? 0}s`);
  out.push(`timeout=${probe.timeoutSeconds ?? 1}s`);
  out.push(`period=${probe.periodSeconds ?? 10}s`);
  out.push(`#success=${probe.successThreshold ?? 1}`);
  out.push(`#failure=${probe.failureThreshold ?? 3}`);
  return out;
}

function formatNodeTaint(t: { key?: string; value?: string; effect?: string }): string {
  if (t.value) {
    return `${t.key}=${t.value}:${t.effect}`;
  }
  return `${t.key || ""}:${t.effect || ""}`;
}

function extractSelectors(spec: any): string[] {
  const out: string[] = [];
  const ml =
    spec?.selector?.matchLabels ??
    (typeof spec?.selector === "object" && !spec?.selector?.matchExpressions ? spec?.selector : null);
  if (ml && typeof ml === "object") {
    for (const [k, v] of Object.entries(ml)) {
      if (typeof v === "string" || typeof v === "number") {
        out.push(`${k}=${v}`);
      }
    }
  }
  if (Array.isArray(spec?.selector?.matchExpressions)) {
    for (const expr of spec.selector.matchExpressions) {
      out.push(`${expr.key} ${expr.operator} (${(expr.values || []).join(",")})`);
    }
  }
  return out;
}

function extractNodeSelectors(spec: any): string[] {
  const ns = spec?.nodeSelector ?? spec?.template?.spec?.nodeSelector ?? spec?.scheduling?.nodeSelector;
  if (!ns || typeof ns !== "object") return [];
  return Object.entries(ns).map(([k, v]) => `${k}=${String(v)}`);
}

function extractImages(spec: any): string[] {
  const containers =
    spec?.containers ?? spec?.template?.spec?.containers ?? spec?.jobTemplate?.spec?.template?.spec?.containers ?? [];
  const initContainers = spec?.initContainers ?? spec?.template?.spec?.initContainers ?? [];
  const imgs: string[] = [];
  for (const c of [...containers, ...initContainers]) {
    if (c?.image && !imgs.includes(c.image)) {
      imgs.push(c.image);
    }
  }
  return imgs;
}

function extractTolerations(spec: any): any[] {
  return (
    spec?.tolerations ??
    spec?.template?.spec?.tolerations ??
    spec?.jobTemplate?.spec?.template?.spec?.tolerations ??
    spec?.scheduling?.tolerations ??
    []
  );
}

function extractAffinity(spec: any): any | null {
  return spec?.affinity ?? spec?.template?.spec?.affinity ?? spec?.jobTemplate?.spec?.template?.spec?.affinity ?? null;
}

function DrawerRow({ name, children, hidden }: { name: React.ReactNode; children: React.ReactNode; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <div className="fl-prop-row">
      <div className="fl-prop-name">{name}</div>
      <div className="fl-prop-val">{children}</div>
    </div>
  );
}

function DrawerSectionBanner({ children }: { children: React.ReactNode }) {
  return <div className="fl-section-banner">{children}</div>;
}

function LineProgress({ value, max, tooltip }: { value: number; max: number; tooltip?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const barColor = pct >= 90 ? "#ce3933" : pct >= 75 ? "#ff9800" : "#00a7a0";
  return (
    <div className="fl-line-progress" title={tooltip}>
      <div
        className="fl-line-progress-fill"
        style={{
          width: `${pct > 0 ? Math.max(2, pct) : 0}%`,
          background: barColor,
        }}
      />
    </div>
  );
}

function ConditionsDrawerRow({ conditions }: { conditions?: any[] }) {
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  return (
    <DrawerRow name="Conditions">
      <div className="fl-chips">
        {conditions.map((c, idx) => {
          const isTrue = c.status === "True";
          const isPressure =
            ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable", "ReplicaFailure"].includes(
              c.type,
            ) && isTrue;
          const cls = isPressure ? "fl-cond-badge danger" : isTrue ? "fl-cond-badge ok" : "fl-cond-badge muted";
          const tip = [
            `Status: ${c.status}`,
            c.reason ? `Reason: ${c.reason}` : "",
            c.message ? `Message: ${c.message}` : "",
            c.lastTransitionTime ? `Last Transition: ${c.lastTransitionTime}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return (
            <span key={`${c.type}-${idx}`} className={cls} title={tip}>
              {c.type}
            </span>
          );
        })}
      </div>
    </DrawerRow>
  );
}

function formatScalarYaml(val: any): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  const s = String(val);
  if (s === "") return "''";
  if (/[:#{}[\],&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

export function toYamlLines(val: any, indent = 0): string[] {
  const pad = "  ".repeat(indent);
  if (val === null || val === undefined || typeof val !== "object") {
    return [`${pad}${formatScalarYaml(val)}`];
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return [`${pad}[]`];
    const out: string[] = [];
    for (const item of val) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          out.push(`${pad}- {}`);
        } else {
          const [firstKey, firstVal] = entries[0];
          if (
            firstVal !== null &&
            typeof firstVal === "object" &&
            ((Array.isArray(firstVal) && firstVal.length > 0) ||
              (!Array.isArray(firstVal) && Object.keys(firstVal).length > 0))
          ) {
            out.push(`${pad}- ${firstKey}:`);
            out.push(...toYamlLines(firstVal, Array.isArray(firstVal) ? indent + 1 : indent + 2));
          } else {
            out.push(`${pad}- ${firstKey}: ${formatScalarYaml(firstVal)}`);
          }
          for (let i = 1; i < entries.length; i++) {
            const [k, v] = entries[i];
            const childPad = "  ".repeat(indent + 1);
            if (
              v !== null &&
              typeof v === "object" &&
              ((Array.isArray(v) && v.length > 0) || (!Array.isArray(v) && Object.keys(v).length > 0))
            ) {
              out.push(`${childPad}${k}:`);
              out.push(...toYamlLines(v, Array.isArray(v) ? indent + 1 : indent + 2));
            } else {
              out.push(`${childPad}${k}: ${formatScalarYaml(v)}`);
            }
          }
        }
      } else {
        out.push(`${pad}- ${formatScalarYaml(item)}`);
      }
    }
    return out;
  }
  const entries = Object.entries(val).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return [`${pad}{}`];
  const out: string[] = [];
  for (const [k, v] of entries) {
    if (
      v !== null &&
      typeof v === "object" &&
      ((Array.isArray(v) && v.length > 0) || (!Array.isArray(v) && Object.keys(v).length > 0))
    ) {
      out.push(`${pad}${k}:`);
      out.push(...toYamlLines(v, Array.isArray(v) ? indent : indent + 1));
    } else {
      out.push(`${pad}${k}: ${formatScalarYaml(v)}`);
    }
  }
  return out;
}

function renderYamlLineContent(line: string) {
  const m = line.match(/^(\s*)(-\s+)?([^:\s][^:]*):(.*)$/);
  if (m) {
    const [, leading, dash, key, rest] = m;
    const indentGuidesCount = Math.floor((leading?.length || 0) / 2);
    return (
      <>
        {Array.from({ length: indentGuidesCount }).map((_, idx) => (
          <span key={idx} className="fl-yaml-indent-guide">
            {"  "}
          </span>
        ))}
        {(leading?.length || 0) % 2 === 1 ? " " : ""}
        {dash && <span className="fl-yaml-dash">{dash}</span>}
        <span className="fl-yaml-key">{key}</span>
        <span className="fl-yaml-colon">:</span>
        {rest && <span className="fl-yaml-val">{rest}</span>}
      </>
    );
  }
  const listMatch = line.match(/^(\s*)(-\s+)(.*)$/);
  if (listMatch) {
    const [, leading, dash, val] = listMatch;
    const indentGuidesCount = Math.floor((leading?.length || 0) / 2);
    return (
      <>
        {Array.from({ length: indentGuidesCount }).map((_, idx) => (
          <span key={idx} className="fl-yaml-indent-guide">
            {"  "}
          </span>
        ))}
        {(leading?.length || 0) % 2 === 1 ? " " : ""}
        <span className="fl-yaml-dash">{dash}</span>
        <span className="fl-yaml-val">{val}</span>
      </>
    );
  }
  return <span>{line}</span>;
}

function YamlCodeViewer({ value }: { value: any }) {
  const lines = useMemo(() => {
    const raw = toYamlLines(value);
    return [...raw, ""];
  }, [value]);

  return (
    <div className="fl-yaml-code-viewer">
      {lines.map((line, i) => (
        <div key={i} className="fl-yaml-code-line">
          <span className="fl-yaml-code-ln">{i + 1}</span>
          <span className="fl-yaml-code-text">{renderYamlLineContent(line)}</span>
        </div>
      ))}
    </div>
  );
}

function DrawerParamToggler({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="fl-param-toggler" onClick={() => setOpen((v) => !v)}>
        <span>{label}</span>
        <span className="fl-param-toggler-btn">
          <span className="fl-link-teal">{open ? "Hide" : "Show"}</span>
          <span className="fl-param-toggler-caret">{open ? "▴" : "▾"}</span>
        </span>
      </div>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

function TolerationsDrawerRow({ tolerations }: { tolerations: any[] }) {
  if (!Array.isArray(tolerations) || tolerations.length === 0) return null;
  return (
    <DrawerRow name="Tolerations">
      <DrawerParamToggler label={tolerations.length}>
        <table className="fl-subtable">
          <thead>
            <tr>
              <th>Key</th>
              <th>Operator</th>
              <th>Value</th>
              <th>Effect</th>
              <th>Seconds</th>
            </tr>
          </thead>
          <tbody>
            {tolerations.map((t, idx) => (
              <tr key={idx}>
                <td>{t.key || "-"}</td>
                <td>{t.operator || "-"}</td>
                <td>{t.value || "-"}</td>
                <td>{t.effect || "-"}</td>
                <td>{t.tolerationSeconds ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DrawerParamToggler>
    </DrawerRow>
  );
}

function AffinitiesDrawerRow({ affinity }: { affinity: any }) {
  if (!affinity || typeof affinity !== "object") return null;
  const keys = Object.keys(affinity);
  if (keys.length === 0) return null;
  return (
    <DrawerRow name="Affinities">
      <DrawerParamToggler label={keys.length}>
        <YamlCodeViewer value={affinity} />
      </DrawerParamToggler>
    </DrawerRow>
  );
}

function PodStatusesDrawerRow({ pods }: { pods: ClusterResource[] }) {
  if (!pods || pods.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const p of pods) {
    const phase = p.status || "Unknown";
    counts[phase] = (counts[phase] || 0) + 1;
  }
  return (
    <DrawerRow name="Pod Status">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {Object.entries(counts).map(([phase, count]) => {
          const low = phase.toLowerCase();
          const cls =
            low === "running" || low === "ready"
              ? "ok"
              : low.includes("pending") || low.includes("creating")
                ? "warn"
                : low.includes("fail") || low.includes("err") || low.includes("crash")
                  ? "err"
                  : "";
          return (
            <span key={phase} className={`fl-status-text ${cls}`}>
              {phase}: {count}
            </span>
          );
        })}
      </div>
    </DrawerRow>
  );
}

function PodDetailsListSection({
  pods,
  ownerKind,
  maxCpu,
  maxMemory,
  statusClass,
  onSelectResource,
  onSelectNamespace,
}: {
  pods: ClusterResource[];
  ownerKind: string;
  maxCpu?: number;
  maxMemory?: number;
  statusClass: (s: string) => string;
  onSelectResource: (kind: string, name: string, namespace?: string) => void;
  onSelectNamespace: (ns: string) => void;
}) {
  const [sortCol, setSortCol] = useState<"name" | "node" | "namespace" | "cpu" | "memory">("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const hideNode = ownerKind === "Node";

  const sortedPods = useMemo(() => {
    const copy = [...pods];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortCol === "name") cmp = a.name.localeCompare(b.name);
      else if (sortCol === "node") cmp = (a.node_name || "").localeCompare(b.node_name || "");
      else if (sortCol === "namespace") cmp = (a.namespace || "").localeCompare(b.namespace || "");
      else if (sortCol === "cpu") cmp = cpuUnitsToNumber(a.cpu) - cpuUnitsToNumber(b.cpu);
      else if (sortCol === "memory") cmp = unitsToBytes(a.memory) - unitsToBytes(b.memory);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [pods, sortCol, sortDir]);

  if (!pods || pods.length === 0) return null;

  const toggleSort = (col: "name" | "node" | "namespace" | "cpu" | "memory") => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "cpu" || col === "memory" ? "desc" : "asc");
    }
  };

  const effMaxCpu = maxCpu && maxCpu > 0 ? maxCpu : 1;
  const effMaxMem = maxMemory && maxMemory > 0 ? maxMemory : 4 * 1024 ** 3;

  return (
    <div style={{ marginTop: 8 }}>
      <DrawerSectionBanner>Pods</DrawerSectionBanner>
      <table className="fl-subtable fl-pods-subtable">
        <thead>
          <tr>
            <th className="sortable" onClick={() => toggleSort("name")}>
              Name {sortCol === "name" ? (sortDir === "asc" ? "▲" : "▼") : ""}
            </th>
            {!hideNode && (
              <th className="sortable" onClick={() => toggleSort("node")}>
                Node {sortCol === "node" ? (sortDir === "asc" ? "▲" : "▼") : ""}
              </th>
            )}
            <th className="sortable" onClick={() => toggleSort("namespace")}>
              Namespace {sortCol === "namespace" ? (sortDir === "asc" ? "▲" : "▼") : ""}
            </th>
            <th>Ready</th>
            <th className="sortable" onClick={() => toggleSort("cpu")}>
              CPU {sortCol === "cpu" ? (sortDir === "asc" ? "▲" : "▼") : ""}
            </th>
            <th className="sortable" onClick={() => toggleSort("memory")}>
              Memory {sortCol === "memory" ? (sortDir === "asc" ? "▲" : "▼") : ""}
            </th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {sortedPods.map((pod) => {
            const cpuVal = cpuUnitsToNumber(pod.cpu);
            const memBytes = unitsToBytes(pod.memory);
            const readyText = (pod.ready || "0/0").replace("/", " / ");
            const cpuPct = effMaxCpu > 0 ? Math.ceil((cpuVal * 100) / effMaxCpu) : 0;
            const memPct = effMaxMem > 0 ? Math.ceil((memBytes * 100) / effMaxMem) : 0;
            return (
              <tr key={`${pod.namespace}/${pod.name}`}>
                <td>
                  <span
                    className="fl-link-teal"
                    title={pod.name}
                    onClick={() => onSelectResource("Pod", pod.name, pod.namespace)}
                  >
                    {pod.name}
                  </span>
                </td>
                {!hideNode && (
                  <td>
                    {pod.node_name ? (
                      <span
                        className="fl-link-teal"
                        title={pod.node_name}
                        onClick={() => onSelectResource("Node", pod.node_name || "")}
                      >
                        {pod.node_name}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                )}
                <td>
                  <span className="fl-link-teal" title={pod.namespace} onClick={() => onSelectNamespace(pod.namespace)}>
                    {pod.namespace}
                  </span>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{readyText}</td>
                <td style={{ minWidth: 74 }}>
                  <LineProgress
                    value={cpuVal}
                    max={effMaxCpu}
                    tooltip={cpuVal > 0 ? `CPU: ${cpuPct}%\n${cpuVal.toFixed(3)}` : "CPU: 0"}
                  />
                </td>
                <td style={{ minWidth: 74 }}>
                  <LineProgress
                    value={memBytes}
                    max={effMaxMem}
                    tooltip={memBytes > 0 ? `Memory: ${memPct}%\n${bytesToUnits(memBytes, 2)}` : "Memory: 0"}
                  />
                </td>
                <td>
                  <span className={`fl-status-text ${statusClass(pod.status)}`}>{pod.status}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PodContainerSection({
  containers,
  containerStatuses,
  isInit,
  podName,
  namespace,
  onOpenResourceByRef,
  onPortForward,
}: {
  containers: any[];
  containerStatuses: any[];
  isInit?: boolean;
  podName: string;
  namespace: string;
  onOpenResourceByRef: (kind: string, name: string, namespace?: string) => void;
  onPortForward: (kind: string, namespace: string, name: string, port: string) => void;
}) {
  if (!Array.isArray(containers) || containers.length === 0) return null;

  return (
    <>
      <DrawerSectionBanner>{isInit ? "Init Containers" : "Containers"}</DrawerSectionBanner>
      {containers.map((c: any) => {
        const st = (containerStatuses || []).find((cs: any) => cs.name === c.name);
        const stateKey = st?.state ? Object.keys(st.state)[0] : "running";
        const terminated = st?.state?.terminated;
        const waiting = st?.state?.waiting;
        const lastTerminated = st?.lastState?.terminated;
        const brickCls =
          stateKey === "running" && (st?.ready ?? true) ? "running" : stateKey === "waiting" ? "waiting" : "terminated";
        const statusParts: string[] = [stateKey || "unknown"];
        if (isInit) statusParts.push("init");
        if (st?.restartCount) statusParts.push(`restarted (${st.restartCount})`);
        if (st?.ready) statusParts.push("ready");
        let statusLine = statusParts.join(", ");
        if (terminated) {
          statusLine += ` - ${terminated.reason || "Terminated"} (exit code: ${terminated.exitCode ?? 0})`;
        } else if (waiting?.reason) {
          statusLine += ` - ${waiting.reason}`;
        }

        const liveness = formatProbe(c.livenessProbe);
        const readiness = formatProbe(c.readinessProbe);
        const startup = formatProbe(c.startupProbe);
        const requests = Object.entries(c.resources?.requests ?? {});
        const limits = Object.entries(c.resources?.limits ?? {});

        return (
          <div key={c.name} className="fl-container-block">
            <div className="fl-container-title">
              <span className={`fl-csq ${brickCls}`} />
              <span>{c.name}</span>
            </div>
            {st && (
              <DrawerRow name="Status">
                <span
                  className={`fl-status-text ${brickCls === "running" ? "ok" : brickCls === "waiting" ? "warn" : ""}`}
                >
                  {statusLine}
                </span>
              </DrawerRow>
            )}
            {lastTerminated && (
              <DrawerRow name="Last Status">
                <div>
                  <div>
                    terminated — Reason: {lastTerminated.reason || "Error"} (exit code: {lastTerminated.exitCode ?? 0})
                  </div>
                  {lastTerminated.startedAt && <div>Started: {lastTerminated.startedAt}</div>}
                  {lastTerminated.finishedAt && <div>Finished: {lastTerminated.finishedAt}</div>}
                </div>
              </DrawerRow>
            )}
            <DrawerRow name="Image">
              <span className="fl-chip" title={st?.imageID || c.image}>
                {c.image}
              </span>
            </DrawerRow>
            {c.imagePullPolicy && c.imagePullPolicy !== "IfNotPresent" && (
              <DrawerRow name="ImagePullPolicy">{c.imagePullPolicy}</DrawerRow>
            )}
            {Array.isArray(c.ports) && c.ports.length > 0 && (
              <DrawerRow name="Ports">
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {c.ports.map((p: any, i: number) => (
                    <div key={i}>
                      <span
                        className="fl-link-teal"
                        title="Click to port-forward"
                        onClick={() => onPortForward("Pod", namespace, podName, String(p.containerPort))}
                      >
                        {p.name ? `${p.name}: ` : ""}
                        {p.containerPort}/{p.protocol || "TCP"}
                      </span>
                    </div>
                  ))}
                </div>
              </DrawerRow>
            )}
            {(Array.isArray(c.env) && c.env.length > 0) || (Array.isArray(c.envFrom) && c.envFrom.length > 0) ? (
              <DrawerRow name="Environment">
                <div className="fl-env-list">
                  {(c.env || []).map((e: any) => {
                    let valNode: React.ReactNode = e.value ?? "";
                    if (e.value === undefined && e.valueFrom) {
                      if (e.valueFrom.fieldRef) {
                        valNode = `fieldRef(${e.valueFrom.fieldRef.fieldPath})`;
                      } else if (e.valueFrom.resourceFieldRef) {
                        valNode = `resourceFieldRef(${e.valueFrom.resourceFieldRef.resource})`;
                      } else if (e.valueFrom.secretKeyRef) {
                        const sname = e.valueFrom.secretKeyRef.name;
                        const skey = e.valueFrom.secretKeyRef.key;
                        valNode = (
                          <span>
                            secretKeyRef(
                            <span
                              className="fl-link-teal"
                              onClick={() => onOpenResourceByRef("Secret", sname, namespace)}
                            >
                              {sname}
                            </span>
                            [{skey}])
                          </span>
                        );
                      } else if (e.valueFrom.configMapKeyRef) {
                        const cmname = e.valueFrom.configMapKeyRef.name;
                        const cmkey = e.valueFrom.configMapKeyRef.key;
                        valNode = (
                          <span>
                            configMapKeyRef(
                            <span
                              className="fl-link-teal"
                              onClick={() => onOpenResourceByRef("ConfigMap", cmname, namespace)}
                            >
                              {cmname}
                            </span>
                            [{cmkey}])
                          </span>
                        );
                      }
                    }
                    return (
                      <div key={e.name} className="fl-env-item">
                        <span className="fl-env-key">{e.name}</span>: {valNode}
                      </div>
                    );
                  })}
                  {(c.envFrom || []).map((ef: any, idx: number) => {
                    if (ef.configMapRef?.name) {
                      return (
                        <div key={`ef-cm-${idx}`} className="fl-env-item">
                          envFrom ConfigMap:{" "}
                          <span
                            className="fl-link-teal"
                            onClick={() => onOpenResourceByRef("ConfigMap", ef.configMapRef.name, namespace)}
                          >
                            {ef.configMapRef.name}
                          </span>
                        </div>
                      );
                    }
                    if (ef.secretRef?.name) {
                      return (
                        <div key={`ef-sec-${idx}`} className="fl-env-item">
                          envFrom Secret:{" "}
                          <span
                            className="fl-link-teal"
                            onClick={() => onOpenResourceByRef("Secret", ef.secretRef.name, namespace)}
                          >
                            {ef.secretRef.name}
                          </span>
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              </DrawerRow>
            ) : null}
            {Array.isArray(c.volumeMounts) && c.volumeMounts.length > 0 && (
              <DrawerRow name="Mounts">
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {c.volumeMounts.map((vm: any, idx: number) => (
                    <div key={`${vm.name}-${vm.mountPath}-${idx}`}>
                      <div style={{ fontWeight: 500 }}>{vm.mountPath}</div>
                      <div style={{ fontSize: 11.5, color: "var(--fl-text-muted)" }}>
                        from {vm.name} ({vm.readOnly ? "ro" : "rw"}){vm.subPath ? ` subPath=${vm.subPath}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </DrawerRow>
            )}
            {liveness.length > 0 && (
              <DrawerRow name="Liveness">
                <div className="fl-chips">
                  {liveness.map((b, i) => (
                    <span key={i} className="fl-chip">
                      {b}
                    </span>
                  ))}
                </div>
              </DrawerRow>
            )}
            {readiness.length > 0 && (
              <DrawerRow name="Readiness">
                <div className="fl-chips">
                  {readiness.map((b, i) => (
                    <span key={i} className="fl-chip">
                      {b}
                    </span>
                  ))}
                </div>
              </DrawerRow>
            )}
            {startup.length > 0 && (
              <DrawerRow name="Startup">
                <div className="fl-chips">
                  {startup.map((b, i) => (
                    <span key={i} className="fl-chip">
                      {b}
                    </span>
                  ))}
                </div>
              </DrawerRow>
            )}
            {Array.isArray(c.command) && c.command.length > 0 && (
              <DrawerRow name="Command">
                <code style={{ fontFamily: "var(--fl-mono)", fontSize: 11.5 }}>{c.command.join(" ")}</code>
              </DrawerRow>
            )}
            {Array.isArray(c.args) && c.args.length > 0 && (
              <DrawerRow name="Arguments">
                <code style={{ fontFamily: "var(--fl-mono)", fontSize: 11.5 }}>{c.args.join(" ")}</code>
              </DrawerRow>
            )}
            {requests.length > 0 && (
              <DrawerRow name="Requests">
                <div className="fl-chips">
                  {requests.map(([k, v]) => (
                    <span key={k} className="fl-chip">
                      {k}={String(v)}
                    </span>
                  ))}
                </div>
              </DrawerRow>
            )}
            {limits.length > 0 && (
              <DrawerRow name="Limits">
                <div className="fl-chips">
                  {limits.map(([k, v]) => (
                    <span key={k} className="fl-chip">
                      {k}={String(v)}
                    </span>
                  ))}
                </div>
              </DrawerRow>
            )}
          </div>
        );
      })}
    </>
  );
}

function PodVolumesSection({
  volumes,
  namespace,
  onOpenResourceByRef,
}: {
  volumes?: any[];
  namespace: string;
  onOpenResourceByRef: (kind: string, name: string, namespace?: string) => void;
}) {
  if (!Array.isArray(volumes) || volumes.length === 0) return null;
  return (
    <>
      <DrawerSectionBanner>Volumes</DrawerSectionBanner>
      {volumes.map((v: any) => {
        const kindKey = Object.keys(v).find((k) => k !== "name") || "emptyDir";
        const val = v[kindKey];
        return (
          <div key={v.name} className="fl-container-block">
            <div className="fl-container-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M2 20h20v-4H2v4zm2-3h2v2H4v-2zM2 4v4h20V4H2zm4 3H4V5h2v2zm-4 7h20v-4H2v4zm2-3h2v2H4v-2z" />
              </svg>
              <span>{v.name}</span>
            </div>
            <DrawerRow name="Kind">{kindKey}</DrawerRow>
            {kindKey === "configMap" && val?.name && (
              <DrawerRow name="Name">
                <span className="fl-link-teal" onClick={() => onOpenResourceByRef("ConfigMap", val.name, namespace)}>
                  {val.name}
                </span>
              </DrawerRow>
            )}
            {kindKey === "secret" && val?.secretName && (
              <DrawerRow name="Name">
                <span className="fl-link-teal" onClick={() => onOpenResourceByRef("Secret", val.secretName, namespace)}>
                  {val.secretName}
                </span>
              </DrawerRow>
            )}
            {kindKey === "persistentVolumeClaim" && val?.claimName && (
              <DrawerRow name="Claim Name">
                <span
                  className="fl-link-teal"
                  onClick={() => onOpenResourceByRef("PersistentVolumeClaim", val.claimName, namespace)}
                >
                  {val.claimName}
                </span>
              </DrawerRow>
            )}
            {kindKey === "hostPath" && val?.path && (
              <>
                <DrawerRow name="Path">{val.path}</DrawerRow>
                {val.type && <DrawerRow name="Type">{val.type}</DrawerRow>}
              </>
            )}
            {kindKey === "emptyDir" && (
              <>
                {val?.medium && <DrawerRow name="Medium">{val.medium}</DrawerRow>}
                {val?.sizeLimit && <DrawerRow name="Size Limit">{val.sizeLimit}</DrawerRow>}
              </>
            )}
            {kindKey === "csi" && val?.driver && <DrawerRow name="Driver">{val.driver}</DrawerRow>}
          </div>
        );
      })}
    </>
  );
}

export function ResourceDetails({
  selectedResource,
  drawerJson,
  allResources,
  allEvents,
  extraPods,
  extraResources,
  extraEvents,
  formatCreatedDetailed,
  formatAgeShort,
  statusClass,
  onSelectNamespace,
  onSelectKind,
  onOpenResourceByRef,
  onPortForward,
}: ResourceDetailsProps) {
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});

  const meta = drawerJson?.metadata || {};
  const spec = drawerJson?.spec || {};
  const st = drawerJson?.status || {};
  const kind = selectedResource.kind;

  const labelsEntries: Array<[string, string]> = meta.labels
    ? Object.entries(meta.labels)
    : (selectedResource.labels || []).map((kv) => {
        const [k, ...rest] = kv.split("=");
        return [k, rest.join("=")];
      });
  const annotationsEntries: Array<[string, string]> = meta.annotations
    ? Object.entries(meta.annotations)
        .filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration")
        .map(([k, v]) => [k, String(v)] as [string, string])
    : [];
  const finalizers: string[] = meta.finalizers || [];
  const owners: Array<{ kind: string; name: string }> =
    meta.ownerReferences ||
    (selectedResource.controlled_by_kind
      ? [
          {
            kind: selectedResource.controlled_by_kind,
            name: selectedResource.controlled_by_name || "",
          },
        ]
      : []);
  const managedFields: Array<{
    manager?: string;
    operation?: string;
    subresource?: string;
    fieldsV1?: any;
  }> = meta.managedFields || [];

  // Resolve related pods for Node / Workloads / PVC
  const relatedPods = useMemo(() => {
    if (extraPods && extraPods.length > 0) return extraPods;
    if (kind === "Node") {
      return allResources.filter((r) => r.kind === "Pod" && r.node_name === selectedResource.name);
    }
    if (["Deployment", "DaemonSet", "StatefulSet", "ReplicaSet", "Job"].includes(kind)) {
      return allResources.filter(
        (r) =>
          r.kind === "Pod" &&
          r.namespace === selectedResource.namespace &&
          (r.controlled_by_name === selectedResource.name || r.name.startsWith(`${selectedResource.name}-`)),
      );
    }
    return [];
  }, [extraPods, allResources, kind, selectedResource.name, selectedResource.namespace]);

  // Resolve related events for the bottom Events section
  const objectEvents = useMemo(() => {
    if (extraEvents && extraEvents.length > 0) return extraEvents;
    return allEvents.filter(
      (ev) =>
        ev.object === selectedResource.name &&
        (!ev.kind || ev.kind === selectedResource.kind) &&
        (!selectedResource.namespace || ev.namespace === selectedResource.namespace),
    );
  }, [extraEvents, allEvents, selectedResource.name, selectedResource.kind, selectedResource.namespace]);

  const selectors = extractSelectors(spec);
  const nodeSelectors = extractNodeSelectors(spec);
  const images = extractImages(spec);
  const tolerations = extractTolerations(spec);
  const affinity = extractAffinity(spec);

  return (
    <>
      {/* 1. Standard KubeObjectMeta rows */}
      <DrawerRow name="Created">{formatCreatedDetailed(meta.creationTimestamp || selectedResource.age)}</DrawerRow>
      {meta.deletionTimestamp && <DrawerRow name="Deleted">{formatCreatedDetailed(meta.deletionTimestamp)}</DrawerRow>}
      <DrawerRow name="Name">{meta.name || selectedResource.name}</DrawerRow>
      {selectedResource.namespace && (
        <DrawerRow name="Namespace">
          <span className="fl-link-teal" onClick={() => onSelectNamespace(selectedResource.namespace)}>
            {selectedResource.namespace}
          </span>
        </DrawerRow>
      )}
      {labelsEntries.length > 0 && (
        <DrawerRow name="Labels">
          <div className="fl-chips">
            {labelsEntries.map(([k, v]) => (
              <span key={k} className="fl-chip">
                {k}={String(v)}
              </span>
            ))}
          </div>
        </DrawerRow>
      )}
      {annotationsEntries.length > 0 && (
        <DrawerRow name="Annotations">
          <div className="fl-chips">
            {annotationsEntries.map(([k, v]) => (
              <span key={k} className="fl-chip">
                {k}={String(v)}
              </span>
            ))}
          </div>
        </DrawerRow>
      )}
      {finalizers.length > 0 && (
        <DrawerRow name="Finalizers">
          <div className="fl-chips">
            {finalizers.map((f) => (
              <span key={f} className="fl-chip">
                {f}
              </span>
            ))}
          </div>
        </DrawerRow>
      )}
      {owners.length > 0 && (
        <DrawerRow name="Controlled By">
          {owners.map((o, i) => (
            <div key={i}>
              {o.kind}{" "}
              <span
                className="fl-link-teal"
                onClick={() => onOpenResourceByRef(o.kind, o.name, selectedResource.namespace)}
              >
                {o.name}
              </span>
            </div>
          ))}
        </DrawerRow>
      )}
      {managedFields.length > 0 && (
        <DrawerRow name="Managed Fields">
          {managedFields.map((mf, idx) => (
            <div key={idx} style={{ marginBottom: 4 }}>
              <DrawerParamToggler
                label={`${mf.manager}: ${mf.operation}${mf.subresource ? ` (${mf.subresource})` : ""}`}
              >
                {mf.fieldsV1 && <YamlCodeViewer value={mf.fieldsV1} />}
              </DrawerParamToggler>
            </div>
          ))}
        </DrawerRow>
      )}

      {/* 2. Kind-specific Freelens sections */}

      {/* NODE DETAILS */}
      {kind === "Node" && (
        <>
          {Array.isArray(st.addresses) && st.addresses.length > 0 && (
            <DrawerRow name="Addresses">
              <div>
                {st.addresses.map((a: any) => (
                  <div key={`${a.type}-${a.address}`}>
                    {a.type}: {a.address}
                  </div>
                ))}
              </div>
            </DrawerRow>
          )}
          {spec.providerID && <DrawerRow name="Provider ID">{spec.providerID}</DrawerRow>}
          {st.nodeInfo && (
            <>
              <DrawerRow name="OS">
                {st.nodeInfo.operatingSystem} ({st.nodeInfo.architecture})
              </DrawerRow>
              <DrawerRow name="OS Image">{st.nodeInfo.osImage}</DrawerRow>
              <DrawerRow name="Kernel version">{st.nodeInfo.kernelVersion}</DrawerRow>
              <DrawerRow name="Container runtime">{st.nodeInfo.containerRuntimeVersion}</DrawerRow>
              <DrawerRow name="Kubelet version">{st.nodeInfo.kubeletVersion}</DrawerRow>
            </>
          )}
          {Array.isArray(spec.taints) && spec.taints.length > 0 && (
            <DrawerRow name="Taints">
              <div className="fl-chips">
                {spec.taints.map((t: any, i: number) => (
                  <span key={`${t.key}-${i}`} className="fl-chip">
                    {formatNodeTaint(t)}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          <ConditionsDrawerRow conditions={st.conditions} />

          {st.capacity && Object.keys(st.capacity).length > 0 && (
            <>
              <DrawerSectionBanner>Capacity</DrawerSectionBanner>
              {Object.entries(st.capacity)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => {
                  if (v === undefined || v === null) return null;
                  if (k === "memory" || k === "ephemeral-storage") {
                    const fmt = formatKubeMemory(v as string);
                    return (
                      <DrawerRow key={`cap-${k}`} name={k}>
                        <span title={fmt.tooltip}>{fmt.display}</span>
                      </DrawerRow>
                    );
                  }
                  return (
                    <DrawerRow key={`cap-${k}`} name={k}>
                      {String(v)}
                    </DrawerRow>
                  );
                })}
            </>
          )}

          {st.allocatable && Object.keys(st.allocatable).length > 0 && (
            <>
              <DrawerSectionBanner>Allocatable</DrawerSectionBanner>
              {Object.entries(st.allocatable)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => {
                  if (v === undefined || v === null) return null;
                  if (k === "memory" || k === "ephemeral-storage") {
                    const fmt = formatKubeMemory(v as string);
                    return (
                      <DrawerRow key={`alloc-${k}`} name={k}>
                        <span title={fmt.tooltip}>{fmt.display}</span>
                      </DrawerRow>
                    );
                  }
                  return (
                    <DrawerRow key={`alloc-${k}`} name={k}>
                      {String(v)}
                    </DrawerRow>
                  );
                })}
            </>
          )}

          <PodDetailsListSection
            pods={relatedPods}
            ownerKind="Node"
            maxCpu={cpuUnitsToNumber(st.capacity?.cpu)}
            maxMemory={unitsToBytes(st.capacity?.memory)}
            statusClass={statusClass}
            onSelectResource={onOpenResourceByRef}
            onSelectNamespace={onSelectNamespace}
          />
        </>
      )}

      {/* POD DETAILS */}
      {kind === "Pod" && (
        <>
          <DrawerRow name="Status">
            <span className={`fl-status-text ${statusClass(st.phase || selectedResource.status)}`}>
              {st.phase || selectedResource.status}
            </span>
          </DrawerRow>
          {spec.schedulerName && spec.schedulerName !== "default-scheduler" && (
            <DrawerRow name="Scheduler">{spec.schedulerName}</DrawerRow>
          )}
          {(spec.nodeName || selectedResource.node_name) && (
            <DrawerRow name="Node">
              <span
                className="fl-link-teal"
                onClick={() => onOpenResourceByRef("Node", spec.nodeName || selectedResource.node_name)}
              >
                {spec.nodeName || selectedResource.node_name}
              </span>
            </DrawerRow>
          )}
          {(Array.isArray(st.hostIPs) && st.hostIPs.length > 0) || st.hostIP || selectedResource.host_ip ? (
            <DrawerRow name="Host IPs">
              <div className="fl-chips">
                {(Array.isArray(st.hostIPs) && st.hostIPs.length > 0
                  ? st.hostIPs.map((h: any) => h.ip)
                  : [st.hostIP || selectedResource.host_ip]
                )
                  .filter(Boolean)
                  .map((ip: string) => (
                    <span key={ip} className="fl-chip">
                      {ip}
                    </span>
                  ))}
              </div>
            </DrawerRow>
          ) : null}
          {(Array.isArray(st.podIPs) && st.podIPs.length > 0) || st.podIP || selectedResource.pod_ip ? (
            <DrawerRow name="Pod IPs">
              <div className="fl-chips">
                {(Array.isArray(st.podIPs) && st.podIPs.length > 0
                  ? st.podIPs.map((p: any) => p.ip)
                  : [st.podIP || selectedResource.pod_ip]
                )
                  .filter(Boolean)
                  .map((ip: string) => (
                    <span key={ip} className="fl-chip">
                      {ip}
                    </span>
                  ))}
              </div>
            </DrawerRow>
          ) : null}
          {spec.serviceAccountName && (
            <DrawerRow name="Service Account">
              <span
                className="fl-link-teal"
                onClick={() =>
                  onOpenResourceByRef("ServiceAccount", spec.serviceAccountName, selectedResource.namespace)
                }
              >
                {spec.serviceAccountName}
              </span>
            </DrawerRow>
          )}
          {spec.priorityClassName && (
            <DrawerRow name="Priority Class">
              <span
                className="fl-link-teal"
                onClick={() => onOpenResourceByRef("PriorityClass", spec.priorityClassName)}
              >
                {spec.priorityClassName}
              </span>
            </DrawerRow>
          )}
          {(st.qosClass || selectedResource.qos) && (
            <DrawerRow name="QoS Class">{st.qosClass || selectedResource.qos}</DrawerRow>
          )}
          {spec.runtimeClassName && (
            <DrawerRow name="Runtime Class">
              <span className="fl-link-teal" onClick={() => onOpenResourceByRef("RuntimeClass", spec.runtimeClassName)}>
                {spec.runtimeClassName}
              </span>
            </DrawerRow>
          )}
          <DrawerRow name="Termination Grace Period">
            {formatDurationSeconds(spec.terminationGracePeriodSeconds ?? 30)}
          </DrawerRow>
          {nodeSelectors.length > 0 && (
            <DrawerRow name="Node Selector">
              <div className="fl-chips">
                {nodeSelectors.map((ns) => (
                  <span key={ns} className="fl-chip">
                    {ns}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          <TolerationsDrawerRow tolerations={tolerations} />
          <AffinitiesDrawerRow affinity={affinity} />
          <ConditionsDrawerRow conditions={st.conditions} />

          <PodContainerSection
            containers={spec.initContainers || []}
            containerStatuses={st.initContainerStatuses || []}
            isInit={true}
            podName={selectedResource.name}
            namespace={selectedResource.namespace}
            onOpenResourceByRef={onOpenResourceByRef}
            onPortForward={onPortForward}
          />
          <PodContainerSection
            containers={spec.containers || []}
            containerStatuses={st.containerStatuses || []}
            isInit={false}
            podName={selectedResource.name}
            namespace={selectedResource.namespace}
            onOpenResourceByRef={onOpenResourceByRef}
            onPortForward={onPortForward}
          />
          <PodVolumesSection
            volumes={spec.volumes}
            namespace={selectedResource.namespace}
            onOpenResourceByRef={onOpenResourceByRef}
          />
        </>
      )}

      {/* DEPLOYMENT / DAEMONSET / STATEFULSET / REPLICASET / REPLICATIONCONTROLLER DETAILS */}
      {["Deployment", "DaemonSet", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(kind) && (
        <>
          {kind === "Deployment" && (
            <DrawerRow name="Replicas">
              {`${spec.replicas ?? 1} desired, ${st.updatedReplicas ?? 0} updated, ${st.replicas ?? 0} total, ${st.availableReplicas ?? 0} available, ${st.unavailableReplicas ?? 0} unavailable`}
            </DrawerRow>
          )}
          {(kind === "StatefulSet" || kind === "ReplicaSet" || kind === "ReplicationController") && (
            <DrawerRow name="Replicas">
              {`${st.availableReplicas ?? st.readyReplicas ?? 0} current / ${spec.replicas ?? 1} desired (${st.readyReplicas ?? 0} ready)`}
            </DrawerRow>
          )}
          {kind === "DaemonSet" && (
            <DrawerRow name="Scheduled">
              {`${st.currentNumberScheduled ?? 0} current / ${st.desiredNumberScheduled ?? 0} desired (${st.numberReady ?? 0} ready, ${st.updatedNumberScheduled ?? 0} updated)`}
            </DrawerRow>
          )}
          {kind === "StatefulSet" && spec.serviceName && (
            <DrawerRow name="Service Name">
              <span
                className="fl-link-teal"
                onClick={() => onOpenResourceByRef("Service", spec.serviceName, selectedResource.namespace)}
              >
                {spec.serviceName}
              </span>
            </DrawerRow>
          )}
          {selectors.length > 0 && (
            <DrawerRow name="Selector">
              <div className="fl-chips">
                {selectors.map((s) => (
                  <span key={s} className="fl-chip">
                    {s}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          {nodeSelectors.length > 0 && (
            <DrawerRow name="Node Selector">
              <div className="fl-chips">
                {nodeSelectors.map((ns) => (
                  <span key={ns} className="fl-chip">
                    {ns}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          {images.length > 0 && (
            <DrawerRow name="Images">
              <div>
                {images.map((img) => (
                  <div key={img}>{img}</div>
                ))}
              </div>
            </DrawerRow>
          )}
          {(spec.strategy?.type || spec.updateStrategy?.type) && (
            <DrawerRow name="Strategy Type">{spec.strategy?.type || spec.updateStrategy?.type}</DrawerRow>
          )}
          <ConditionsDrawerRow conditions={st.conditions} />
          <TolerationsDrawerRow tolerations={tolerations} />
          <AffinitiesDrawerRow affinity={affinity} />
          <PodStatusesDrawerRow pods={relatedPods} />

          {/* Deploy Revisions (owned ReplicaSets) for Deployment */}
          {kind === "Deployment" && extraResources && extraResources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <DrawerSectionBanner>Deploy Revisions</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Namespace</th>
                    <th>Pods</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {extraResources.map((rs) => (
                    <tr key={rs.name}>
                      <td>
                        <span
                          className="fl-link-teal"
                          onClick={() => onOpenResourceByRef("ReplicaSet", rs.name, rs.namespace)}
                        >
                          {rs.name}
                        </span>
                      </td>
                      <td>
                        <span className="fl-link-teal" onClick={() => onSelectNamespace(rs.namespace)}>
                          {rs.namespace}
                        </span>
                      </td>
                      <td>{rs.ready}</td>
                      <td>{formatAgeShort(rs.age)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <PodDetailsListSection
            pods={relatedPods}
            ownerKind={kind}
            statusClass={statusClass}
            onSelectResource={onOpenResourceByRef}
            onSelectNamespace={onSelectNamespace}
          />
        </>
      )}

      {/* JOB DETAILS */}
      {kind === "Job" && (
        <>
          {selectors.length > 0 && (
            <DrawerRow name="Selector">
              <div className="fl-chips">
                {selectors.map((s) => (
                  <span key={s} className="fl-chip">
                    {s}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          {images.length > 0 && (
            <DrawerRow name="Images">
              <div>
                {images.map((img) => (
                  <div key={img}>{img}</div>
                ))}
              </div>
            </DrawerRow>
          )}
          <DrawerRow name="Status">
            <span className={`fl-status-text ${statusClass(selectedResource.status)}`}>{selectedResource.status}</span>
          </DrawerRow>
          <DrawerRow name="Parallelism">{spec.parallelism ?? 1}</DrawerRow>
          <DrawerRow name="Completions">{spec.completions ?? 1}</DrawerRow>
          {spec.completionMode && <DrawerRow name="Completion Mode">{spec.completionMode}</DrawerRow>}
          <DrawerRow name="Resumed">
            <span className="fl-chip">{String(!spec.suspend)}</span>
          </DrawerRow>
          {spec.backoffLimit !== undefined && <DrawerRow name="Backoff Limit">{spec.backoffLimit}</DrawerRow>}
          {st.startTime && <DrawerRow name="Start Time">{formatCreatedDetailed(st.startTime)}</DrawerRow>}
          {st.completionTime && <DrawerRow name="Completed At">{formatCreatedDetailed(st.completionTime)}</DrawerRow>}
          <DrawerRow name="Pods Statuses">
            {`${st.active || 0} Active / ${st.succeeded || 0} Succeeded / ${st.failed || 0} Failed`}
          </DrawerRow>
          <TolerationsDrawerRow tolerations={tolerations} />
          <AffinitiesDrawerRow affinity={affinity} />
          <PodStatusesDrawerRow pods={relatedPods} />
          <ConditionsDrawerRow conditions={st.conditions} />
          <PodDetailsListSection
            pods={relatedPods}
            ownerKind="Job"
            statusClass={statusClass}
            onSelectResource={onOpenResourceByRef}
            onSelectNamespace={onSelectNamespace}
          />
        </>
      )}

      {/* CRONJOB DETAILS */}
      {kind === "CronJob" && (
        <>
          <DrawerRow name="Schedule">{spec.schedule || selectedResource.ready}</DrawerRow>
          {spec.timeZone && <DrawerRow name="Timezone">{spec.timeZone}</DrawerRow>}
          {spec.concurrencyPolicy && <DrawerRow name="Concurrency Policy">{spec.concurrencyPolicy}</DrawerRow>}
          <DrawerRow name="Resumed">
            <span className="fl-chip">{String(!spec.suspend)}</span>
          </DrawerRow>
          {spec.successfulJobsHistoryLimit !== undefined && (
            <DrawerRow name="Successful Jobs History Limit">{spec.successfulJobsHistoryLimit}</DrawerRow>
          )}
          {spec.failedJobsHistoryLimit !== undefined && (
            <DrawerRow name="Failed Jobs History Limit">{spec.failedJobsHistoryLimit}</DrawerRow>
          )}
          {st.lastScheduleTime && (
            <DrawerRow name="Last Schedule">{formatCreatedDetailed(st.lastScheduleTime)}</DrawerRow>
          )}
          {st.lastSuccessfulTime && (
            <DrawerRow name="Last Successful Run">{formatCreatedDetailed(st.lastSuccessfulTime)}</DrawerRow>
          )}
          <DrawerRow name="Active">{Array.isArray(st.active) ? st.active.length : 0}</DrawerRow>

          {spec.jobTemplate && (
            <>
              <DrawerSectionBanner>Template</DrawerSectionBanner>
              <DrawerRow name="Parallelism">{spec.jobTemplate.spec?.parallelism ?? 1}</DrawerRow>
              <DrawerRow name="Completions">{spec.jobTemplate.spec?.completions ?? 1}</DrawerRow>
              {images.length > 0 && (
                <DrawerRow name="Images">
                  <div>
                    {images.map((img) => (
                      <div key={img}>{img}</div>
                    ))}
                  </div>
                </DrawerRow>
              )}
            </>
          )}

          {extraResources && extraResources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <DrawerSectionBanner>Jobs</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Completions</th>
                    <th>Status</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {extraResources.map((jb) => (
                    <tr key={jb.name}>
                      <td>
                        <span
                          className="fl-link-teal"
                          onClick={() => onOpenResourceByRef("Job", jb.name, jb.namespace)}
                        >
                          {jb.name}
                        </span>
                      </td>
                      <td>{jb.ready}</td>
                      <td>
                        <span className={`fl-status-text ${statusClass(jb.status)}`}>{jb.status}</span>
                      </td>
                      <td>{formatAgeShort(jb.age)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* SERVICE DETAILS */}
      {kind === "Service" && (
        <>
          {selectors.length > 0 && (
            <DrawerRow name="Selector">
              <div className="fl-chips">
                {selectors.map((s) => (
                  <span key={s} className="fl-chip">
                    {s}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          <DrawerRow name="Type">{spec.type || selectedResource.status}</DrawerRow>
          {spec.sessionAffinity && <DrawerRow name="Session Affinity">{spec.sessionAffinity}</DrawerRow>}

          <DrawerSectionBanner>Connection</DrawerSectionBanner>
          {spec.clusterIP && <DrawerRow name="Cluster IP">{spec.clusterIP}</DrawerRow>}
          {Array.isArray(spec.clusterIPs) && spec.clusterIPs.length > 0 && (
            <DrawerRow name="Cluster IPs">
              <div className="fl-chips">
                {spec.clusterIPs.map((ip: string) => (
                  <span key={ip} className="fl-chip">
                    {ip}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          {spec.ipFamilyPolicy && <DrawerRow name="IP family policy">{spec.ipFamilyPolicy}</DrawerRow>}
          {Array.isArray(spec.ipFamilies) && spec.ipFamilies.length > 0 && (
            <DrawerRow name="IP families">{spec.ipFamilies.join(", ")}</DrawerRow>
          )}
          {spec.externalName && <DrawerRow name="External Name">{spec.externalName}</DrawerRow>}
          {Array.isArray(st.loadBalancer?.ingress) && st.loadBalancer.ingress.length > 0 && (
            <DrawerRow name="Load Balancer Ingress">
              <div className="fl-chips">
                {st.loadBalancer.ingress.map((ing: any, i: number) => (
                  <span key={i} className="fl-chip">
                    {ing.ip || ing.hostname}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          {Array.isArray(spec.ports) && spec.ports.length > 0 && (
            <DrawerRow name="Ports">
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {spec.ports.map((p: any, i: number) => (
                  <div key={i}>
                    <span
                      className="fl-link-teal"
                      title="Click to port-forward"
                      onClick={() =>
                        onPortForward("Service", selectedResource.namespace, selectedResource.name, String(p.port))
                      }
                    >
                      {p.name ? `${p.name}: ` : ""}
                      {p.port}
                      {p.targetPort ? `:${p.targetPort}` : ""}
                      {p.nodePort ? ` (nodePort: ${p.nodePort})` : ""}/{p.protocol || "TCP"}
                    </span>
                  </div>
                ))}
              </div>
            </DrawerRow>
          )}
        </>
      )}

      {/* ENDPOINTS & ENDPOINTSLICE DETAILS */}
      {(kind === "Endpoints" || kind === "EndpointSlice") && (
        <>
          {drawerJson?.addressType && <DrawerRow name="Address Type">{drawerJson.addressType}</DrawerRow>}
          {Array.isArray(drawerJson?.subsets) &&
            drawerJson.subsets.map((sub: any, idx: number) => (
              <div key={idx}>
                <DrawerSectionBanner>Subset {idx + 1}</DrawerSectionBanner>
                {Array.isArray(sub.addresses) && sub.addresses.length > 0 && (
                  <table className="fl-subtable" style={{ marginBottom: 8 }}>
                    <thead>
                      <tr>
                        <th>IP</th>
                        <th>Node</th>
                        <th>Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sub.addresses.map((a: any, i: number) => (
                        <tr key={i}>
                          <td>{a.ip}</td>
                          <td>
                            {a.nodeName ? (
                              <span className="fl-link-teal" onClick={() => onOpenResourceByRef("Node", a.nodeName)}>
                                {a.nodeName}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td>
                            {a.targetRef?.name ? (
                              <span
                                className="fl-link-teal"
                                onClick={() =>
                                  onOpenResourceByRef(
                                    a.targetRef.kind || "Pod",
                                    a.targetRef.name,
                                    a.targetRef.namespace || selectedResource.namespace,
                                  )
                                }
                              >
                                {a.targetRef.kind}/{a.targetRef.name}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {Array.isArray(sub.ports) && sub.ports.length > 0 && (
                  <DrawerRow name="Ports">
                    {sub.ports
                      .map((p: any) => `${p.name ? `${p.name}: ` : ""}${p.port}/${p.protocol || "TCP"}`)
                      .join(", ")}
                  </DrawerRow>
                )}
              </div>
            ))}
          {Array.isArray(drawerJson?.endpoints) && drawerJson.endpoints.length > 0 && (
            <>
              <DrawerSectionBanner>Endpoints</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Addresses</th>
                    <th>Node</th>
                    <th>Target</th>
                    <th>Ready</th>
                  </tr>
                </thead>
                <tbody>
                  {drawerJson.endpoints.map((ep: any, i: number) => (
                    <tr key={i}>
                      <td>{(ep.addresses || []).join(", ")}</td>
                      <td>
                        {ep.nodeName ? (
                          <span className="fl-link-teal" onClick={() => onOpenResourceByRef("Node", ep.nodeName)}>
                            {ep.nodeName}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>
                        {ep.targetRef?.name ? (
                          <span
                            className="fl-link-teal"
                            onClick={() =>
                              onOpenResourceByRef(
                                ep.targetRef.kind || "Pod",
                                ep.targetRef.name,
                                ep.targetRef.namespace || selectedResource.namespace,
                              )
                            }
                          >
                            {ep.targetRef.name}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>{String(ep.conditions?.ready ?? true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {/* INGRESS & INGRESSCLASS DETAILS */}
      {kind === "Ingress" && (
        <>
          {spec.ingressClassName && (
            <DrawerRow name="Ingress Class">
              <span className="fl-link-teal" onClick={() => onOpenResourceByRef("IngressClass", spec.ingressClassName)}>
                {spec.ingressClassName}
              </span>
            </DrawerRow>
          )}
          {Array.isArray(spec.tls) && spec.tls.length > 0 && (
            <DrawerRow name="TLS">
              <div>
                {spec.tls.map((t: any, i: number) => (
                  <div key={i}>
                    {t.secretName ? (
                      <span
                        className="fl-link-teal"
                        onClick={() => onOpenResourceByRef("Secret", t.secretName, selectedResource.namespace)}
                      >
                        {t.secretName}
                      </span>
                    ) : (
                      "TLS"
                    )}{" "}
                    {Array.isArray(t.hosts) ? `(${t.hosts.join(", ")})` : ""}
                  </div>
                ))}
              </div>
            </DrawerRow>
          )}
          {Array.isArray(spec.rules) && spec.rules.length > 0 && (
            <>
              <DrawerSectionBanner>Rules</DrawerSectionBanner>
              {spec.rules.map((r: any, idx: number) => (
                <div key={idx} style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Host: {r.host || "*"}</div>
                  <table className="fl-subtable">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Path Type</th>
                        <th>Backend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(r.http?.paths || []).map((p: any, pi: number) => {
                        const svcName = p.backend?.service?.name;
                        const svcPort = p.backend?.service?.port?.number ?? p.backend?.service?.port?.name;
                        return (
                          <tr key={pi}>
                            <td>{p.path || "/"}</td>
                            <td>{p.pathType || "Prefix"}</td>
                            <td>
                              {svcName ? (
                                <span
                                  className="fl-link-teal"
                                  onClick={() => onOpenResourceByRef("Service", svcName, selectedResource.namespace)}
                                >
                                  {svcName}:{svcPort}
                                </span>
                              ) : (
                                "-"
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
          {Array.isArray(st.loadBalancer?.ingress) && st.loadBalancer.ingress.length > 0 && (
            <>
              <DrawerSectionBanner>Load-Balancer Ingress Points</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Hostname</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {st.loadBalancer.ingress.map((ing: any, i: number) => (
                    <tr key={i}>
                      <td>{ing.hostname || "-"}</td>
                      <td>{ing.ip || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {kind === "IngressClass" && (
        <DrawerRow name="Controller">
          <span className="fl-chip">{spec.controller || selectedResource.ready || "-"}</span>
        </DrawerRow>
      )}

      {/* NETWORKPOLICY DETAILS */}
      {kind === "NetworkPolicy" && (
        <>
          <DrawerRow name="Pod Selector">
            {selectors.length > 0 ? (
              <div className="fl-chips">
                {selectors.map((s) => (
                  <span key={s} className="fl-chip">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              "(empty) (Allowing the specific traffic to all pods in this namespace)"
            )}
          </DrawerRow>
          {Array.isArray(spec.policyTypes) && <DrawerRow name="Policy Types">{spec.policyTypes.join(", ")}</DrawerRow>}
          {Array.isArray(spec.ingress) && spec.ingress.length > 0 && (
            <>
              <DrawerSectionBanner>Ingress</DrawerSectionBanner>
              <YamlCodeViewer value={spec.ingress} />
            </>
          )}
          {Array.isArray(spec.egress) && spec.egress.length > 0 && (
            <>
              <DrawerSectionBanner>Egress</DrawerSectionBanner>
              <YamlCodeViewer value={spec.egress} />
            </>
          )}
        </>
      )}

      {/* CONFIGMAP DETAILS */}
      {kind === "ConfigMap" && drawerJson?.data && (
        <>
          <DrawerSectionBanner>Data</DrawerSectionBanner>
          {Object.entries(drawerJson.data).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{k}</div>
              <pre
                className="fl-pre-output"
                style={{
                  background: "var(--fl-bg-elevated)",
                  border: "1px solid var(--fl-border)",
                  borderRadius: 4,
                  maxHeight: 220,
                  overflow: "auto",
                }}
              >
                {String(v)}
              </pre>
            </div>
          ))}
        </>
      )}

      {/* SECRET DETAILS */}
      {kind === "Secret" && (
        <>
          <DrawerRow name="Type">{drawerJson?.type || selectedResource.status}</DrawerRow>
          {drawerJson?.data && (
            <>
              <DrawerSectionBanner>Data</DrawerSectionBanner>
              {Object.entries(drawerJson.data).map(([k, v]) => {
                const revealed = Boolean(revealedSecrets[k]);
                let decoded = String(v);
                if (revealed) {
                  try {
                    decoded = atob(String(v));
                  } catch {
                    decoded = String(v);
                  }
                }
                return (
                  <DrawerRow key={k} name={k}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <code
                        style={{
                          fontFamily: "var(--fl-mono)",
                          fontSize: 11.5,
                          wordBreak: "break-all",
                        }}
                      >
                        {revealed ? decoded : "••••••••••••••••"}
                      </code>
                      <span
                        className="fl-link-teal"
                        onClick={() => setRevealedSecrets((prev) => ({ ...prev, [k]: !prev[k] }))}
                      >
                        {revealed ? "Hide" : "Reveal"}
                      </span>
                    </div>
                  </DrawerRow>
                );
              })}
            </>
          )}
        </>
      )}

      {/* RESOURCEQUOTA & LIMITRANGE DETAILS */}
      {kind === "ResourceQuota" && st.hard && (
        <>
          <DrawerSectionBanner>Quotas</DrawerSectionBanner>
          {Object.entries(st.hard).map(([resName, hardVal]) => {
            const usedVal = st.used?.[resName] ?? "0";
            return (
              <DrawerRow key={resName} name={resName}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span>
                    {String(usedVal)} / {String(hardVal)}
                  </span>
                </div>
              </DrawerRow>
            );
          })}
        </>
      )}

      {kind === "LimitRange" && Array.isArray(spec.limits) && (
        <>
          <DrawerSectionBanner>Limits</DrawerSectionBanner>
          {spec.limits.map((lim: any, idx: number) => (
            <DrawerRow key={idx} name={lim.type || `Limit ${idx + 1}`}>
              <div className="fl-chips">
                {["min", "max", "default", "defaultRequest"].flatMap((part) =>
                  Object.entries(lim[part] || {}).map(([res, val]) => (
                    <span key={`${part}-${res}`} className="fl-chip">
                      {res} {part}: {String(val)}
                    </span>
                  )),
                )}
              </div>
            </DrawerRow>
          ))}
        </>
      )}

      {/* HPA & PDB DETAILS */}
      {kind === "HorizontalPodAutoscaler" && (
        <>
          {spec.scaleTargetRef && (
            <DrawerRow name="Reference">
              <span
                className="fl-link-teal"
                onClick={() =>
                  onOpenResourceByRef(spec.scaleTargetRef.kind, spec.scaleTargetRef.name, selectedResource.namespace)
                }
              >
                {spec.scaleTargetRef.kind}/{spec.scaleTargetRef.name}
              </span>
            </DrawerRow>
          )}
          <DrawerRow name="Min Pods">{spec.minReplicas ?? 1}</DrawerRow>
          <DrawerRow name="Max Pods">{spec.maxReplicas ?? 1}</DrawerRow>
          <DrawerRow name="Replicas">
            {st.currentReplicas ?? 0} current / {st.desiredReplicas ?? 0} desired
          </DrawerRow>
          <ConditionsDrawerRow conditions={st.conditions} />
        </>
      )}

      {kind === "PodDisruptionBudget" && (
        <>
          {selectors.length > 0 && (
            <DrawerRow name="Selector">
              <div className="fl-chips">
                {selectors.map((s) => (
                  <span key={s} className="fl-chip">
                    {s}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          <DrawerRow name="Min Available">{String(spec.minAvailable ?? "N/A")}</DrawerRow>
          <DrawerRow name="Max Unavailable">{String(spec.maxUnavailable ?? "N/A")}</DrawerRow>
          <DrawerRow name="Current Healthy">{st.currentHealthy ?? 0}</DrawerRow>
          <DrawerRow name="Desired Healthy">{st.desiredHealthy ?? 0}</DrawerRow>
          <DrawerRow name="Disruptions Allowed">{st.disruptionsAllowed ?? 0}</DrawerRow>
          <ConditionsDrawerRow conditions={st.conditions} />
        </>
      )}

      {/* PRIORITYCLASS / RUNTIMECLASS / LEASE / WEBHOOKS */}
      {kind === "PriorityClass" && (
        <>
          <DrawerRow name="Value">{drawerJson?.value ?? selectedResource.ready}</DrawerRow>
          <DrawerRow name="Global Default">{String(Boolean(drawerJson?.globalDefault))}</DrawerRow>
          {drawerJson?.preemptionPolicy && (
            <DrawerRow name="Preemption Policy">{drawerJson.preemptionPolicy}</DrawerRow>
          )}
          {drawerJson?.description && <DrawerRow name="Description">{drawerJson.description}</DrawerRow>}
        </>
      )}

      {kind === "RuntimeClass" && (
        <>
          <DrawerRow name="Handler">{drawerJson?.handler ?? selectedResource.ready}</DrawerRow>
          {nodeSelectors.length > 0 && (
            <DrawerRow name="Node Selector">
              <div className="fl-chips">
                {nodeSelectors.map((ns) => (
                  <span key={ns} className="fl-chip">
                    {ns}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          <TolerationsDrawerRow tolerations={tolerations} />
        </>
      )}

      {kind === "Lease" && (
        <>
          <DrawerRow name="Holder Identity">{spec.holderIdentity || selectedResource.ready || "-"}</DrawerRow>
          {spec.leaseDurationSeconds !== undefined && (
            <DrawerRow name="Lease Duration Seconds">{spec.leaseDurationSeconds}</DrawerRow>
          )}
          {spec.leaseTransitions !== undefined && (
            <DrawerRow name="Lease Transitions">{spec.leaseTransitions}</DrawerRow>
          )}
          {spec.acquireTime && <DrawerRow name="Acquire Time">{spec.acquireTime}</DrawerRow>}
          {spec.renewTime && <DrawerRow name="Renew Time">{spec.renewTime}</DrawerRow>}
        </>
      )}

      {(kind === "MutatingWebhookConfiguration" || kind === "ValidatingWebhookConfiguration") &&
        Array.isArray(drawerJson?.webhooks) && (
          <>
            <DrawerSectionBanner>Webhooks ({drawerJson.webhooks.length})</DrawerSectionBanner>
            {drawerJson.webhooks.map((wh: any) => (
              <div key={wh.name} className="fl-container-block">
                <div className="fl-container-title">{wh.name}</div>
                {wh.clientConfig?.service && (
                  <DrawerRow name="Client Service">
                    {wh.clientConfig.service.namespace}/{wh.clientConfig.service.name}:
                    {wh.clientConfig.service.port || 443}
                    {wh.clientConfig.service.path || ""}
                  </DrawerRow>
                )}
                {wh.failurePolicy && <DrawerRow name="Failure Policy">{wh.failurePolicy}</DrawerRow>}
                {wh.matchPolicy && <DrawerRow name="Match Policy">{wh.matchPolicy}</DrawerRow>}
                {wh.sideEffects && <DrawerRow name="Side Effects">{wh.sideEffects}</DrawerRow>}
                {wh.timeoutSeconds !== undefined && <DrawerRow name="Timeout">{wh.timeoutSeconds}s</DrawerRow>}
              </div>
            ))}
          </>
        )}

      {/* STORAGE: PVC / PV / STORAGECLASS */}
      {(kind === "PersistentVolumeClaim" || kind === "PersistentVolume") && (
        <>
          <DrawerRow name="Status">
            <span className={`fl-status-text ${statusClass(st.phase || selectedResource.status)}`}>
              {st.phase || selectedResource.status}
            </span>
          </DrawerRow>
          {spec.storageClassName && (
            <DrawerRow name="Storage Class Name">
              <span className="fl-link-teal" onClick={() => onOpenResourceByRef("StorageClass", spec.storageClassName)}>
                {spec.storageClassName}
              </span>
            </DrawerRow>
          )}
          {(st.capacity?.storage || spec.capacity?.storage || spec.resources?.requests?.storage) && (
            <DrawerRow name="Capacity">
              {st.capacity?.storage || spec.capacity?.storage || spec.resources?.requests?.storage}
            </DrawerRow>
          )}
          {Array.isArray(spec.accessModes) && <DrawerRow name="Access Modes">{spec.accessModes.join(", ")}</DrawerRow>}
          {spec.persistentVolumeReclaimPolicy && (
            <DrawerRow name="Reclaim Policy">{spec.persistentVolumeReclaimPolicy}</DrawerRow>
          )}
          {spec.volumeMode && <DrawerRow name="Volume Mode">{spec.volumeMode}</DrawerRow>}
          {spec.volumeName && (
            <DrawerRow name="Volume">
              <span className="fl-link-teal" onClick={() => onOpenResourceByRef("PersistentVolume", spec.volumeName)}>
                {spec.volumeName}
              </span>
            </DrawerRow>
          )}
          {spec.claimRef?.name && (
            <>
              <DrawerSectionBanner>Claim</DrawerSectionBanner>
              <DrawerRow name="Name">
                <span
                  className="fl-link-teal"
                  onClick={() =>
                    onOpenResourceByRef("PersistentVolumeClaim", spec.claimRef.name, spec.claimRef.namespace)
                  }
                >
                  {spec.claimRef.name}
                </span>
              </DrawerRow>
              <DrawerRow name="Namespace">{spec.claimRef.namespace}</DrawerRow>
            </>
          )}
        </>
      )}

      {kind === "StorageClass" && (
        <>
          <DrawerRow name="Provisioner">
            <span className="fl-chip">{drawerJson?.provisioner || selectedResource.ready || "-"}</span>
          </DrawerRow>
          <DrawerRow name="Volume Binding Mode">
            {drawerJson?.volumeBindingMode || selectedResource.detail || "Immediate"}
          </DrawerRow>
          <DrawerRow name="Reclaim Policy">
            {drawerJson?.reclaimPolicy || selectedResource.status || "Delete"}
          </DrawerRow>
          {drawerJson?.allowVolumeExpansion !== undefined && (
            <DrawerRow name="Allow Volume Expansion">{String(Boolean(drawerJson.allowVolumeExpansion))}</DrawerRow>
          )}
          {Array.isArray(drawerJson?.mountOptions) && drawerJson.mountOptions.length > 0 && (
            <DrawerRow name="Mount Options">{drawerJson.mountOptions.join(", ")}</DrawerRow>
          )}
          {drawerJson?.parameters && Object.keys(drawerJson.parameters).length > 0 && (
            <>
              <DrawerSectionBanner>Parameters</DrawerSectionBanner>
              {Object.entries(drawerJson.parameters).map(([k, v]) => (
                <DrawerRow key={k} name={startCase(k)}>
                  {String(v)}
                </DrawerRow>
              ))}
            </>
          )}
          {extraResources && extraResources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <DrawerSectionBanner>Volumes</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Capacity</th>
                    <th>Status</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {extraResources.map((pv) => (
                    <tr key={pv.name}>
                      <td>
                        <span className="fl-link-teal" onClick={() => onOpenResourceByRef("PersistentVolume", pv.name)}>
                          {pv.name}
                        </span>
                      </td>
                      <td>{pv.ready}</td>
                      <td>
                        <span className={`fl-status-text ${statusClass(pv.status)}`}>{pv.status}</span>
                      </td>
                      <td>{formatAgeShort(pv.age)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* NAMESPACE DETAILS */}
      {kind === "Namespace" && (
        <>
          <DrawerRow name="Status">
            <span className={`fl-status-text ${statusClass(st.phase || selectedResource.status)}`}>
              {st.phase || selectedResource.status}
            </span>
          </DrawerRow>
          {extraResources && extraResources.length > 0 && (
            <>
              <DrawerRow name="Resource Quotas">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {extraResources
                    .filter((r) => r.kind === "ResourceQuota")
                    .map((rq) => (
                      <span
                        key={rq.name}
                        className="fl-link-teal"
                        onClick={() => onOpenResourceByRef("ResourceQuota", rq.name, selectedResource.name)}
                      >
                        {rq.name}
                      </span>
                    ))}
                </div>
              </DrawerRow>
              <DrawerRow name="Limit Ranges">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {extraResources
                    .filter((r) => r.kind === "LimitRange")
                    .map((lr) => (
                      <span
                        key={lr.name}
                        className="fl-link-teal"
                        onClick={() => onOpenResourceByRef("LimitRange", lr.name, selectedResource.name)}
                      >
                        {lr.name}
                      </span>
                    ))}
                </div>
              </DrawerRow>
            </>
          )}
        </>
      )}

      {/* ACCESS CONTROL: SERVICEACCOUNT / ROLE / CLUSTERROLE / ROLEBINDING / CLUSTERROLEBINDING */}
      {kind === "ServiceAccount" && (
        <>
          {drawerJson?.automountServiceAccountToken !== undefined && (
            <DrawerRow name="Automount Token">{String(Boolean(drawerJson.automountServiceAccountToken))}</DrawerRow>
          )}
          {Array.isArray(drawerJson?.imagePullSecrets) && drawerJson.imagePullSecrets.length > 0 && (
            <DrawerRow name="ImagePullSecrets">
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {drawerJson.imagePullSecrets.map((s: any, i: number) => (
                  <span
                    key={i}
                    className="fl-link-teal"
                    onClick={() => onOpenResourceByRef("Secret", s.name, selectedResource.namespace)}
                  >
                    {s.name}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          {Array.isArray(drawerJson?.secrets) && drawerJson.secrets.length > 0 && (
            <>
              <DrawerSectionBanner>Mountable secrets</DrawerSectionBanner>
              {drawerJson.secrets.map((s: any, i: number) => (
                <DrawerRow key={i} name="Secret">
                  <span
                    className="fl-link-teal"
                    onClick={() => onOpenResourceByRef("Secret", s.name, selectedResource.namespace)}
                  >
                    {s.name}
                  </span>
                </DrawerRow>
              ))}
            </>
          )}
        </>
      )}

      {(kind === "Role" || kind === "ClusterRole") && Array.isArray(drawerJson?.rules) && (
        <>
          <DrawerSectionBanner>Rules</DrawerSectionBanner>
          {drawerJson.rules.map((r: any, idx: number) => (
            <div key={idx} className="fl-container-block">
              {Array.isArray(r.resources) && <DrawerRow name="Resources">{r.resources.join(", ")}</DrawerRow>}
              {Array.isArray(r.verbs) && <DrawerRow name="Verbs">{r.verbs.join(", ")}</DrawerRow>}
              {Array.isArray(r.apiGroups) && (
                <DrawerRow name="Api Groups">
                  {r.apiGroups.map((g: string) => (g === "" ? "''" : g)).join(", ")}
                </DrawerRow>
              )}
              {Array.isArray(r.resourceNames) && (
                <DrawerRow name="Resource Names">{r.resourceNames.join(", ")}</DrawerRow>
              )}
              {Array.isArray(r.nonResourceURLs) && (
                <DrawerRow name="Non-Resource URLs">{r.nonResourceURLs.join(", ")}</DrawerRow>
              )}
            </div>
          ))}
        </>
      )}

      {(kind === "RoleBinding" || kind === "ClusterRoleBinding") && (
        <>
          {drawerJson?.roleRef && (
            <>
              <DrawerSectionBanner>Reference</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Name</th>
                    <th>API Group</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{drawerJson.roleRef.kind}</td>
                    <td>
                      <span
                        className="fl-link-teal"
                        onClick={() =>
                          onOpenResourceByRef(
                            drawerJson.roleRef.kind || "Role",
                            drawerJson.roleRef.name,
                            selectedResource.namespace,
                          )
                        }
                      >
                        {drawerJson.roleRef.name}
                      </span>
                    </td>
                    <td>{drawerJson.roleRef.apiGroup}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
          {Array.isArray(drawerJson?.subjects) && drawerJson.subjects.length > 0 && (
            <>
              <DrawerSectionBanner>Bindings</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Namespace</th>
                  </tr>
                </thead>
                <tbody>
                  {drawerJson.subjects.map((sub: any, idx: number) => (
                    <tr key={idx}>
                      <td>{sub.kind}</td>
                      <td>
                        {sub.kind === "ServiceAccount" ? (
                          <span
                            className="fl-link-teal"
                            onClick={() =>
                              onOpenResourceByRef(
                                "ServiceAccount",
                                sub.name,
                                sub.namespace || selectedResource.namespace,
                              )
                            }
                          >
                            {sub.name}
                          </span>
                        ) : (
                          sub.name
                        )}
                      </td>
                      <td>{sub.namespace || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {/* CUSTOMRESOURCEDEFINITION DETAILS */}
      {kind === "CustomResourceDefinition" && (
        <>
          <DrawerRow name="Group">{spec.group || selectedResource.detail}</DrawerRow>
          {Array.isArray(spec.versions) && (
            <DrawerRow name="Versions">
              <div className="fl-chips">
                {spec.versions.map((v: any) => (
                  <span key={v.name} className="fl-chip">
                    {v.name}
                    {v.storage ? " ★" : ""}
                  </span>
                ))}
              </div>
            </DrawerRow>
          )}
          <DrawerRow name="Scope">{spec.scope || selectedResource.status}</DrawerRow>
          <DrawerRow name="Resource">
            <span className="fl-link-teal" onClick={() => onSelectKind && onSelectKind(`CR:${selectedResource.name}`)}>
              {spec.names?.kind || selectedResource.controlled_by_kind || selectedResource.name}
            </span>
          </DrawerRow>
          {spec.conversion?.strategy && <DrawerRow name="Conversion">{spec.conversion.strategy}</DrawerRow>}
          <ConditionsDrawerRow conditions={st.conditions} />
          {spec.names && (
            <>
              <DrawerSectionBanner>Names</DrawerSectionBanner>
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>plural</th>
                    <th>singular</th>
                    <th>kind</th>
                    <th>listKind</th>
                    <th>shortNames</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{spec.names.plural}</td>
                    <td>{spec.names.singular}</td>
                    <td>{spec.names.kind}</td>
                    <td>{spec.names.listKind}</td>
                    <td>{(spec.names.shortNames || []).join(", ") || "-"}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
          {Array.isArray(spec.versions?.[0]?.additionalPrinterColumns) &&
            spec.versions[0].additionalPrinterColumns.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <DrawerSectionBanner>Additional Printer Columns</DrawerSectionBanner>
                <table className="fl-subtable">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>JSON Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spec.versions[0].additionalPrinterColumns.map((col: any, idx: number) => (
                      <tr key={idx}>
                        <td>{col.name}</td>
                        <td>{col.type}</td>
                        <td>
                          <span className="fl-chip">{col.jsonPath}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          <div style={{ marginTop: 8 }}>
            <DrawerSectionBanner>Custom Objects ({extraResources ? extraResources.length : 0})</DrawerSectionBanner>
            {!extraResources || extraResources.length === 0 ? (
              <div style={{ color: "var(--fl-text-muted)", fontSize: 12, padding: "6px 0" }}>
                No custom objects found for {selectedResource.name}
              </div>
            ) : (
              <table className="fl-subtable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Namespace</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {extraResources.map((cr) => (
                    <tr key={`${cr.namespace}/${cr.name}`}>
                      <td>
                        <span
                          className="fl-link-teal"
                          onClick={() => onOpenResourceByRef(cr.kind, cr.name, cr.namespace)}
                        >
                          {cr.name}
                        </span>
                      </td>
                      <td>
                        {cr.namespace ? (
                          <span className="fl-link-teal" onClick={() => onSelectNamespace(cr.namespace)}>
                            {cr.namespace}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>{formatAgeShort(cr.age)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* CUSTOM RESOURCE INSTANCE DETAILS */}
      {kind.startsWith("CR:") && (
        <>
          <DrawerRow name="Kind">{drawerJson?.kind || selectedResource.controlled_by_kind || kind.slice(3)}</DrawerRow>
          {drawerJson?.apiVersion && <DrawerRow name="API Version">{drawerJson.apiVersion}</DrawerRow>}
          <DrawerRow name="Definition">
            <span
              className="fl-link-teal"
              onClick={() =>
                onOpenResourceByRef("CustomResourceDefinition", selectedResource.controlled_by_name || kind.slice(3))
              }
            >
              {selectedResource.controlled_by_name || kind.slice(3)}
            </span>
          </DrawerRow>
          <ConditionsDrawerRow conditions={st.conditions} />
          {spec && Object.keys(spec).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <DrawerSectionBanner>Spec</DrawerSectionBanner>
              <YamlCodeViewer value={spec} />
            </div>
          )}
          {st && Object.keys(st).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <DrawerSectionBanner>Status</DrawerSectionBanner>
              <YamlCodeViewer value={st} />
            </div>
          )}
        </>
      )}

      {/* 3. Bottom Events section (KubeEventDetails) for all non-Event resources */}
      {kind !== "Event" && (
        <div style={{ marginTop: 8 }}>
          <DrawerSectionBanner>Events</DrawerSectionBanner>
          {objectEvents.length === 0 ? (
            <div style={{ color: "var(--fl-text-muted)", fontSize: 12, padding: "6px 0" }}>No events found</div>
          ) : (
            objectEvents.map((ev, idx) => (
              <div key={idx} className="fl-container-block" style={{ marginBottom: 8 }}>
                <div
                  style={{
                    fontWeight: 600,
                    color: ev.event_type === "Warning" ? "#e57373" : "var(--fl-text)",
                    marginBottom: 4,
                  }}
                >
                  {ev.message}
                </div>
                <DrawerRow name="Reason">{ev.reason || "-"}</DrawerRow>
                <DrawerRow name="Count">{ev.count}</DrawerRow>
                {ev.last_seen && <DrawerRow name="Last seen">{formatCreatedDetailed(ev.last_seen)}</DrawerRow>}
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
