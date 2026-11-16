/**
 * Interpreter / toolchain backend (`sdk_*` commands) with a small per-kind
 * cache, so switching between settings pages doesn't re-run `--version` probes.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import type { RunTargetValid } from "@/platform/remoteSettings";
import type { SelectOption } from "@/ui";
import {
  call,
  commands,
  isTauri,
  type ContainerPython,
  nextRequestId,
  type PhpLanguageLevels,
  type ProjectInterpreter,
  type PythonPackage,
  type Sdk,
  type SdkKind,
} from "@/platform/ipc";

export type { ContainerPython, ProjectInterpreter, PythonPackage, Sdk, SdkKind };

interface SdkCache {
  byKind: Partial<Record<SdkKind, Sdk[]>>;
  loading: Partial<Record<SdkKind, boolean>>;
  errors: Partial<Record<SdkKind, string>>;
}

export const useSdks = create<SdkCache>(() => ({ byKind: {}, loading: {}, errors: {} }));

const inflight = new Map<SdkKind, Promise<Sdk[]>>();

/** Detected SDKs of `kind`; cached unless `force`. */
export function detectSdks(kind: SdkKind, force = false): Promise<Sdk[]> {
  const cached = useSdks.getState().byKind[kind];
  if (cached && !force) return Promise.resolve(cached);
  const running = inflight.get(kind);
  if (running) return running;
  if (!isTauri()) {
    useSdks.setState((s) => ({ byKind: { ...s.byKind, [kind]: [] } }));
    return Promise.resolve([]);
  }
  useSdks.setState((s) => ({ loading: { ...s.loading, [kind]: true } }));
  const p = call(commands.sdkDetect(kind))
    .then((list) => {
      useSdks.setState((s) => ({
        byKind: { ...s.byKind, [kind]: list },
        errors: { ...s.errors, [kind]: undefined },
      }));
      return list;
    })
    .catch((e: unknown) => {
      useSdks.setState((s) => ({ errors: { ...s.errors, [kind]: String((e as Error)?.message ?? e) } }));
      return [] as Sdk[];
    })
    .finally(() => {
      inflight.delete(kind);
      useSdks.setState((s) => ({ loading: { ...s.loading, [kind]: false } }));
    });
  inflight.set(kind, p);
  return p;
}

/** Drops an SDK (e.g. a JDK added by hand, then removed) from the cached list. */
export function forgetSdk(kind: SdkKind, path: string) {
  useSdks.setState((s) => ({ byKind: { ...s.byKind, [kind]: (s.byKind[kind] ?? []).filter((x) => x.path !== path) } }));
}

/** Adds an SDK (e.g. a just-created virtualenv) to the cached list. */
export function rememberSdk(kind: SdkKind, sdk: Sdk) {
  const remember = () =>
    useSdks.setState((s) => {
      const list = s.byKind[kind] ?? [];
      return { byKind: { ...s.byKind, [kind]: [sdk, ...list.filter((x) => x.path !== sdk.path)] } };
    });
  remember();
  // An already-running scan may not include this newly added environment.
  void inflight.get(kind)?.then(remember);
}

export interface Streamed<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/**
 * A line of tool output as a terminal shows it: backspaces erase (conda's `-\|/` spinner),
 * a carriage return starts the line over (pip's progress bar), colour and other control
 * sequences go. Null when nothing visible is left.
 */
export function terminalLine(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");
  let line = "";
  for (const segment of plain.split("\r")) {
    if (!segment) continue;
    let text = "";
    for (const ch of segment) {
      if (ch === "\b") text = text.slice(0, -1);
      // eslint-disable-next-line no-control-regex
      else if (ch === "\t" || !/[\x00-\x1f\x7f]/.test(ch)) text += ch;
    }
    // A carriage return overwrites from the line start; the last non-empty rewrite wins.
    if (text.trim()) line = text.length >= line.length ? text : text + line.slice(text.length);
  }
  return line.trim() ? line.trimEnd() : null;
}

function streamed<T>(
  run: (request: ReturnType<typeof nextRequestId>, ch: Channel<string>) => Promise<T>,
  onLine: (line: string) => void,
): Streamed<T> {
  const request = nextRequestId();
  const channel = new Channel<string>();
  channel.onmessage = (raw) => {
    const line = terminalLine(raw);
    if (line !== null) onLine(line);
  };
  return { promise: run(request, channel), cancel: () => void commands.cancelRequest(request) };
}

/** Tool that creates a new Python environment (`VenvTool` in `ide-sdk`). */
export type VenvTool = "venv" | "uv" | "poetry" | "conda";

export function createVenv(
  tool: VenvTool,
  base: string,
  location: string,
  onLine: (line: string) => void,
): Streamed<Sdk> {
  return streamed((req, ch) => call(commands.sdkPythonCreateVenv(tool, base, location, req, ch)), onLine);
}

/** Resolves an interpreter picked by hand ("Existing environment") into an SDK like the detected ones. */
export function pythonInterpreter(path: string): Promise<Sdk | null> {
  return isTauri() ? call(commands.sdkPythonInterpreter(path)) : Promise.resolve(null);
}

/** Interpreters of the other recently opened projects, each with the project it belongs to. */
export function pythonProjectInterpreters(): Promise<ProjectInterpreter[]> {
  return isTauri() ? call(commands.sdkPythonProjectInterpreters()) : Promise.resolve([]);
}

export function listPackages(python: string): Promise<PythonPackage[]> {
  return call(commands.sdkPythonPackages(python, nextRequestId()));
}

export function pip(
  python: string,
  requirement: string,
  op: "install" | "upgrade" | "uninstall",
  onLine: (line: string) => void,
): Streamed<null> {
  return streamed(
    (req, ch) => call(commands.sdkPythonPip(python, requirement, op === "uninstall", op === "upgrade", req, ch)),
    onLine,
  );
}

/** Interpreter the project uses when none is configured (its virtualenv); `near` picks the workspace member. */
export function effectivePython(near: string | null = null): Promise<string | null> {
  return isTauri() ? call(commands.sdkPythonEffective(near)) : Promise.resolve(null);
}

/** What `languages.python.interpreter` starts with when the interpreter is a run target's. */
const TARGET_PREFIX = "target:";

/** The run target id of a `target:<id>` interpreter value; null for a local interpreter. */
export function interpreterTarget(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  if (!v.startsWith(TARGET_PREFIX)) return null;
  return v.slice(TARGET_PREFIX.length).trim() || null;
}

/** Docker and Compose run targets as interpreter choices (`target:<id>`). */
export function targetChoices(targets: readonly RunTargetValid[]): SelectOption[] {
  return targets
    .filter((t) => t.kind === "docker" || t.kind === "compose")
    .map((t) => ({
      value: `${TARGET_PREFIX}${t.id}`,
      label: t.name || t.id,
      verbatim: true,
      detail: t.kind === "compose" ? tx`Docker Compose service ${t.service}` : tx`Docker image ${t.image}`,
    }));
}

/** The project interpreter when it is a Docker or Compose run target's, with its library snapshot. */
export function containerPython(): Promise<ContainerPython | null> {
  return isTauri() ? call(commands.sdkContainerPython()) : Promise.resolve(null);
}

/** Copies the container's libraries again (after the image was rebuilt). */
export function refreshContainerPython(): Promise<ContainerPython | null> {
  return isTauri() ? call(commands.sdkContainerPythonRefresh()) : Promise.resolve(null);
}

/** The PHP language level of the project `path` belongs to; null outside Tauri. */
export function phpLanguageLevel(path: string): Promise<PhpLanguageLevels | null> {
  return isTauri() ? call(commands.sdkPhpLanguageLevel(path)) : Promise.resolve(null);
}
