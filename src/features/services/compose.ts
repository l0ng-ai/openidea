/**
 * Run targets of Dockerfiles (`FROM` lines → build image) and Compose files
 * (`services:` → up all, each service → up that service), detected per line like
 * the run gutter does (the configurations they start are in `runTypes.ts`).
 */
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { onFilesMoved } from "@/platform/fileOps";
import { call, commands, type ComposeFileOverride, type Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { bumpFileIconRevision } from "@/ui/icons";
import { notifications, type EditorBannerContribution } from "@/workbench/contributions";

export type DockerTarget =
  | { kind: "build"; line: number; stage: string | null; last: boolean }
  | { kind: "composeAll"; line: number }
  | { kind: "composeService"; line: number; service: string };

interface ComposeFilesState {
  overrides: Record<string, ComposeFileOverride>;
  contentDetected: Record<string, boolean>;
}

export const useComposeFiles = create<ComposeFilesState>(() => ({ overrides: {}, contentDetected: {} }));

const absolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:\//.test(path);

function syncComposeSettings(settings: Settings | null, root: string | null, reset: boolean) {
  const overrides = Object.fromEntries(
    Object.entries(settings?.files?.composeFileOverrides ?? {}).map(([path, status]) => [
      root && !absolutePath(path) ? `${root}/${path}` : path,
      status,
    ]),
  );
  useComposeFiles.setState({ overrides, ...(reset ? { contentDetected: {} } : {}) });
  bumpFileIconRevision();
}

let saving = Promise.resolve();

function writeComposeOverrides(
  change: (current: Record<string, ComposeFileOverride>) => Record<string, ComposeFileOverride>,
) {
  const root = useProject.getState().project?.root ?? null;
  const pending = saving
    .then(async () => {
      if (root !== (useProject.getState().project?.root ?? null)) return;
      const current = useProject.getState().settings?.files?.composeFileOverrides ?? {};
      const next = change(current);
      const settings = await call(
        commands.settingsSet(root ? "project" : "global", "files.composeFileOverrides", JSON.stringify(next)),
      );
      if (root === (useProject.getState().project?.root ?? null)) useProject.setState({ settings });
    })
    .catch((error: unknown) => {
      notifications().notify({
        level: "error",
        title: "Could not save Docker Compose file detection",
        body: String(error),
      });
      throw error;
    });
  saving = pending.catch(() => {});
  return pending;
}

export function setComposeFileOverride(path: string, status: ComposeFileOverride | null): Promise<void> {
  const root = useProject.getState().project?.root;
  const key = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return writeComposeOverrides((current) => {
    const next = { ...current };
    if (status) next[key] = status;
    else delete next[key];
    return next;
  });
}

export function activateComposeFiles(): () => void {
  const state = useProject.getState();
  syncComposeSettings(state.settings, state.project?.root ?? null, true);
  const stopSettings = useProject.subscribe((s, prev) => {
    const reset = s.project?.root !== prev.project?.root;
    if (reset || s.settings !== prev.settings) syncComposeSettings(s.settings, s.project?.root ?? null, reset);
  });
  const stopMoves = onFilesMoved(async (moves) => {
    await saving;
    const root = useProject.getState().project?.root;
    const remap = (path: string) => {
      const move = moves.find((m) => path === m.from || path.startsWith(`${m.from}/`));
      return move ? move.to + path.slice(move.from.length) : path;
    };
    const state = useComposeFiles.getState();
    const detected = Object.fromEntries(
      Object.entries(state.contentDetected).map(([path, value]) => [remap(path), value]),
    );
    const changed = Object.keys(state.overrides).some((path) => remap(path) !== path);
    if (changed) {
      await writeComposeOverrides((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, value]) => {
            const path = remap(root && !absolutePath(key) ? `${root}/${key}` : key);
            return [root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path, value];
          }),
        ),
      );
    }
    if (root === useProject.getState().project?.root) {
      useComposeFiles.setState({ contentDetected: detected });
      bumpFileIconRevision();
    }
  });
  return () => {
    stopSettings();
    stopMoves();
  };
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";

export function isDockerfile(path: string): boolean {
  const name = base(path);
  return /^(Dockerfile|Containerfile)(\.[\w.-]+)?$/i.test(name) || /\.(dockerfile|containerfile)$/i.test(name);
}

export function isYamlFile(path: string): boolean {
  return /\.ya?ml$/i.test(base(path));
}

export function isNamedComposeFile(path: string): boolean {
  return /^.*compose.*\.ya?ml$/i.test(base(path));
}

const COMPOSE_TOP_SECTIONS = new Set(["version", "name", "networks", "volumes", "configs", "secrets", "include"]);

const COMPOSE_SERVICE_KEYS = new Set([
  "image",
  "build",
  "container_name",
  "hostname",
  "domainname",
  "ports",
  "expose",
  "environment",
  "env_file",
  "volumes",
  "volumes_from",
  "networks",
  "network_mode",
  "depends_on",
  "command",
  "entrypoint",
  "restart",
  "pull_policy",
  "healthcheck",
  "deploy",
  "develop",
  "labels",
  "annotations",
  "platform",
  "profiles",
  "user",
  "working_dir",
  "privileged",
  "read_only",
  "stdin_open",
  "tty",
  "init",
  "cap_add",
  "cap_drop",
  "cgroup",
  "cgroup_parent",
  "configs",
  "secrets",
  "cpus",
  "cpu_count",
  "cpu_percent",
  "cpu_shares",
  "cpu_period",
  "cpu_quota",
  "cpuset",
  "devices",
  "dns",
  "dns_opt",
  "dns_search",
  "extends",
  "external_links",
  "extra_hosts",
  "group_add",
  "ipc",
  "isolation",
  "links",
  "logging",
  "mac_address",
  "mem_limit",
  "mem_reservation",
  "oom_kill_disable",
  "oom_score_adj",
  "pid",
  "pids_limit",
  "post_start",
  "pre_stop",
  "runtime",
  "scale",
  "security_opt",
  "shm_size",
  "stop_grace_period",
  "stop_signal",
  "storage_opt",
  "sysctls",
  "tmpfs",
  "ulimits",
  "userns_mode",
  "uts",
]);

export const COMPOSE_SCAN_LIMIT = 64 * 1024;

const isServiceName = (name: string) => /^[a-zA-Z0-9_.-]+$/.test(name) && !name.startsWith("x-");

/** Whether a bounded YAML prefix looks like a Docker Compose configuration. */
export function isComposeContent(text: string): boolean {
  const lines = text
    .slice(0, COMPOSE_SCAN_LIMIT)
    .split("\n", 600)
    .map((l) => l.replace(/\r$/, ""));
  const topKeys = new Set<string>();
  let servicesLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:(?:\s|$)/.exec(line);
    if (m) {
      const k = m[1] ?? m[2] ?? m[3]!;
      topKeys.add(k);
      if (k === "services" && servicesLine < 0) servicesLine = i;
    } else if (!/^\s/.test(line) && line !== "---" && line !== "...") {
      return false;
    }
  }
  if (servicesLine < 0) return false;
  for (const key of topKeys) {
    if (key !== "services" && !COMPOSE_TOP_SECTIONS.has(key) && !key.startsWith("x-")) return false;
  }
  let serviceIndent: number | null = null;
  let propIndent: number | null = null;
  let service = false;
  for (let i = servicesLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break;
    serviceIndent ??= lead;
    if (lead === serviceIndent) {
      propIndent = null;
      const match = KEY.exec(line);
      const name = match?.[3] ?? match?.[4] ?? match?.[5];
      service = !!name && isServiceName(name);
      continue;
    }
    if (service && lead > serviceIndent) {
      propIndent ??= lead;
      if (lead === propIndent) {
        const km = /^\s*("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:/.exec(line);
        const prop = km?.[2] ?? km?.[3] ?? km?.[4];
        if (prop && (COMPOSE_SERVICE_KEYS.has(prop) || prop.startsWith("x-"))) return true;
      }
    }
  }
  return false;
}

export function noteComposeContent(path: string, text: string): boolean {
  if (!isYamlFile(path)) return false;
  const detected = isComposeContent(text);
  const prev = !!useComposeFiles.getState().contentDetected[path];
  if (detected !== prev) {
    useComposeFiles.setState((s) => {
      const contentDetected = { ...s.contentDetected };
      if (detected) contentDetected[path] = true;
      else delete contentDetected[path];
      return { contentDetected };
    });
    bumpFileIconRevision();
  }
  return detected;
}

export function composeFileIcon(_fileName: string, path: string | null): string | null {
  if (!path || !isYamlFile(path)) return null;
  const state = useComposeFiles.getState();
  const override = state.overrides[path];
  if (override === "excluded") return "file-yaml";
  if (override === "kept" || state.contentDetected[path]) return "file-docker";
  return null;
}

export function isComposeFile(path: string, text?: string): boolean {
  if (!isYamlFile(path)) return false;
  const state = useComposeFiles.getState();
  const override = state.overrides[path];
  if (override === "excluded") return false;
  if (override === "kept") return true;
  if (isNamedComposeFile(path)) return true;
  if (text !== undefined) return isComposeContent(text);
  return !!state.contentDetected[path];
}

export function isAutoDetectedComposeFile(path: string, text?: string): boolean {
  if (isNamedComposeFile(path) || !isComposeFile(path, text)) return false;
  return useComposeFiles.getState().overrides[path] !== "kept";
}

/** Every `FROM` line; a named stage (`AS build`) is built with `--target`, the last one whole. */
export function dockerfileTargets(text: string): DockerTarget[] {
  const out: Array<Extract<DockerTarget, { kind: "build" }>> = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+([\w.-]+))?\s*$/i.exec(line.replace(/\r$/, ""));
    if (m) out.push({ kind: "build", line: i, stage: m[1] ?? null, last: false });
  });
  if (out.length) out[out.length - 1]!.last = true;
  return out;
}

const KEY = /^(\s*)("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:\s*(?:[&*{#].*)?$/;

/** The top-level `services:` key and each service directly below it. */
export function composeTargets(text: string): DockerTarget[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const out: DockerTarget[] = [];
  const start = lines.findIndex((l) => /^services\s*:\s*(?:[&#].*)?$/.test(l));
  if (start < 0) return out;
  out.push({ kind: "composeAll", line: start });
  let indent: number | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break; // next top-level key
    indent ??= lead;
    if (lead !== indent) continue;
    const m = KEY.exec(line);
    const service = m?.[3] ?? m?.[4] ?? m?.[5];
    if (service && isServiceName(service)) out.push({ kind: "composeService", line: i, service });
  }
  return out;
}

/** The Compose target enclosing 0-based `line` (a service block, or `composeAll`). */
export function composeTargetAtLine(text: string, line: number): DockerTarget | null {
  const targets = composeTargets(text);
  if (!targets.length) return null;
  const all = targets.find((t) => t.kind === "composeAll") ?? targets[0]!;
  if (line <= all.line) return all;
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  let endOfServices = lines.length;
  for (let i = all.line + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    if (l.length === l.trimStart().length) {
      endOfServices = i;
      break;
    }
  }
  if (line >= endOfServices) return all;
  const services = targets.filter(
    (t): t is Extract<DockerTarget, { kind: "composeService" }> => t.kind === "composeService",
  );
  for (let i = services.length - 1; i >= 0; i--) {
    if (line >= services[i]!.line) return services[i]!;
  }
  return all;
}

export function fileTargets(path: string, text: string): DockerTarget[] {
  if (isDockerfile(path)) return dockerfileTargets(text);
  if (isComposeFile(path, text)) return composeTargets(text);
  return [];
}

/** An image tag from the build context's folder name (`My App` → `my-app:latest`). */
export function imageTag(path: string): string {
  const folder = base(dir(path))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return `${folder || "image"}:latest`;
}

export function targetTitle(t: DockerTarget, path: string): string {
  switch (t.kind) {
    case "build":
      return t.stage && !t.last ? `Build Stage '${t.stage}'` : `Run '${base(path)}'`;
    case "composeAll":
      return "Compose Up (All Services)";
    case "composeService":
      return `Compose Up '${t.service}'`;
  }
}

export const composeAutoDetectBanner: EditorBannerContribution = {
  id: "docker.composeAutoDetect",
  order: 5,
  useBanner: (path) => {
    const detected = useComposeFiles((s) => {
      if (!isYamlFile(path)) return false;
      const override = s.overrides[path];
      if (override === "excluded" || override === "kept") return false;
      return isAutoDetectedComposeFile(path);
    });
    if (!detected) return null;
    return {
      text: "This file was auto-detected as a Docker Compose configuration based on its content",
      icon: "info",
      actions: [
        {
          label: "Not a Compose file",
          run: () => void executeAction("docker.setComposeFileOverride", { path, status: "excluded" }),
        },
        {
          label: "Keep as Docker Compose",
          run: () => void executeAction("docker.setComposeFileOverride", { path, status: "kept" }),
        },
      ],
    };
  },
};
