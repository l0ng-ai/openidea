/**
 * Interpreter / toolchain backend (`sdk_*` commands) with a small per-kind
 * cache, so switching between settings pages doesn't re-run `--version` probes.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  call,
  commands,
  isTauri,
  nextRequestId,
  type PhpLanguageLevels,
  type PythonPackage,
  type Sdk,
  type SdkKind,
} from "@/platform/ipc";

export type { PythonPackage, Sdk, SdkKind };

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

/** Adds an SDK (e.g. a just-created virtualenv) to the cached list. */
export function rememberSdk(kind: SdkKind, sdk: Sdk) {
  useSdks.setState((s) => {
    const list = s.byKind[kind] ?? [];
    return { byKind: { ...s.byKind, [kind]: [sdk, ...list.filter((x) => x.path !== sdk.path)] } };
  });
}

export interface Streamed<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function streamed<T>(
  run: (request: ReturnType<typeof nextRequestId>, ch: Channel<string>) => Promise<T>,
  onLine: (line: string) => void,
): Streamed<T> {
  const request = nextRequestId();
  const channel = new Channel<string>();
  channel.onmessage = onLine;
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

/** Interpreter the project uses when none is configured (its virtualenv). */
export function effectivePython(): Promise<string | null> {
  return isTauri() ? call(commands.sdkPythonEffective(null)) : Promise.resolve(null);
}

/** The PHP language level of the project `path` belongs to; null outside Tauri. */
export function phpLanguageLevel(path: string): Promise<PhpLanguageLevels | null> {
  return isTauri() ? call(commands.sdkPhpLanguageLevel(path)) : Promise.resolve(null);
}

/** File / folder chooser (Tauri dialog); null when cancelled or outside Tauri. */
export async function choosePath(opts: {
  directory: boolean;
  title: string;
  defaultPath?: string;
}): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: opts.directory,
    multiple: false,
    title: opts.title,
    defaultPath: opts.defaultPath || undefined,
  });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}
