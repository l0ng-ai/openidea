/** Visible-file JVM presentation: one bounded IPC batch, shared cache and watcher. */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { fileIconName, type IconName } from "@/ui/icons";
import { call, commands, isTauri, onIdeEvent, type JvmPresentation } from "./ipc";
import { basename, relativePath, useProject } from "./project";
import { rootFor, type RootFolder } from "./languageSettings";
import { useEffectiveRoots } from "./projectRoots";
import { useProjectPresentation } from "./projectPresentation";

const JVM = /\.(java|kt)$/;
const MAX_CACHE = 4096;
const pending = new Map<string, number>();
const visible = new Map<string, number>();
const versions = new Map<string, number>();
const mtimes = new Map<string, number>();
const cache = create<{ entries: ReadonlyMap<string, JvmPresentation | null> }>(() => ({ entries: new Map() }));
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let epoch = 0;
let dispose: (() => void) | undefined;
let users = 0;

function enqueue(path: string) {
  if (!JVM.test(path) || cache.getState().entries.has(path) || !isTauri()) return;
  pending.set(path, versions.get(path) ?? 0);
  if (!running && !timer)
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 0);
}
async function flush() {
  if (running) return;
  const batch = [...pending].filter(([p]) => visible.has(p)).slice(0, 64);
  pending.clear();
  if (!batch.length) return;
  running = true;
  const gen = epoch;
  try {
    const results = await call(commands.jvmFilePresentations(batch.map(([p]) => p)));
    if (gen !== epoch) return;
    const entries = new Map(cache.getState().entries);
    for (const [path, version] of batch) {
      if ((versions.get(path) ?? 0) !== version) continue;
      entries.delete(path);
      entries.set(path, results.find((r) => r.path === path)?.presentation ?? null);
    }
    while (entries.size > MAX_CACHE) entries.delete(entries.keys().next().value!);
    cache.setState({ entries });
  } catch {
    if (gen === epoch) {
      const entries = new Map(cache.getState().entries);
      for (const [path, version] of batch) if ((versions.get(path) ?? 0) === version) entries.set(path, null);
      cache.setState({ entries });
    }
  } finally {
    running = false;
    for (const path of versions.keys()) if (!visible.has(path)) versions.delete(path);
    // Requests that arrived during IPC stay bounded to the mounted consumers.
    for (const p of visible.keys()) if (!batch.some(([b]) => b === p)) enqueue(p);
    if (pending.size && !timer)
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 0);
  }
}

export function invalidateFilePresentations(paths: readonly string[]) {
  const entries = new Map(cache.getState().entries);
  for (const key of new Set([...entries.keys(), ...visible.keys()])) {
    if (!paths.some((p) => key === p || key.startsWith(p + "/"))) continue;
    entries.delete(key);
    versions.set(key, (versions.get(key) ?? 0) + 1);
  }
  cache.setState({ entries });
  for (const p of visible.keys()) enqueue(p);
}
function mount(path: string) {
  if (!JVM.test(path)) return () => {};
  if (users++ === 0) {
    cache.setState({ entries: new Map() });
    mtimes.clear();
    const fs = onIdeEvent("fsChanged", (e) => invalidateFilePresentations([...e.created, ...e.modified, ...e.removed]));
    const project = useProject.subscribe((s, prev) => {
      if (s.project === prev.project) return;
      epoch++;
      versions.clear();
      pending.clear();
      cache.setState({ entries: new Map() });
    });
    dispose = () => {
      fs();
      project();
    };
  }
  visible.set(path, (visible.get(path) ?? 0) + 1);
  enqueue(path);
  return () => {
    const count = (visible.get(path) ?? 1) - 1;
    if (count) visible.set(path, count);
    else {
      visible.delete(path);
      pending.delete(path);
    }
    if (--users === 0) {
      epoch++;
      pending.clear();
      dispose?.();
    }
  };
}

export function presentationIcon(
  path: string,
  info: JvmPresentation | null | undefined,
  roots: readonly RootFolder[],
  root: string | null,
  spring: boolean,
): IconName {
  const name = basename(path);
  const role = root ? rootFor(roots, relativePath(root, path))?.kind : null;
  if (
    /^(application|bootstrap).*\.(yml|yaml|properties)$/.test(name) &&
    (spring || role === "resources" || role === "testResources")
  )
    return "spring-config";
  if (!info?.kind) return fileIconName(name);
  if (info.springBoot) return "spring-boot";
  if (/(Test|Tests|IT)\.(java|kt)$/.test(name) || role === "test") return "jvm-test";
  const kind: Record<NonNullable<JvmPresentation["kind"]>, IconName> = {
    class: "class",
    abstractClass: "class-abstract",
    interface: "interface",
    enum: "enum",
    record: "record",
    annotation: "annotation",
    exception: "exception",
    object: "kotlin-object",
  };
  return kind[info.kind];
}

export function useJvmPresentation(path: string, mtime?: number | null) {
  useEffect(() => (path ? mount(path) : undefined), [path]);
  // Directory refresh metadata also invalidates results if a watcher event was missed.
  useEffect(() => {
    if (mtime != null && JVM.test(path)) {
      const previous = mtimes.get(path);
      mtimes.set(path, mtime);
      if (previous !== undefined && previous !== mtime) invalidateFilePresentations([path]);
      if (mtimes.size > MAX_CACHE) mtimes.delete(mtimes.keys().next().value!);
    }
  }, [path, mtime]);
  return cache((s) => s.entries.get(path));
}

export function useFilePresentation(path: string, mtime?: number | null) {
  const info = useJvmPresentation(path, mtime);
  const roots = useEffectiveRoots();
  const root = useProject((s) => s.project?.root ?? null);
  const build = useProjectPresentation();
  const icon = presentationIcon(path, info, roots, root, build.spring);
  return { icon, runnable: !!info?.runnable && icon !== "spring-boot" && icon !== "jvm-test" };
}

/** Tab strips resolve their mounted file tabs through the same batch as tree rows. */
export function useFilePresentationIcons(paths: readonly string[]) {
  const key = JSON.stringify(paths);
  useEffect(() => {
    const disposers = (JSON.parse(key) as string[]).map(mount);
    return () => disposers.forEach((dispose) => dispose());
  }, [key]);
  const entries = cache((s) => s.entries);
  const roots = useEffectiveRoots();
  const root = useProject((s) => s.project?.root ?? null);
  const build = useProjectPresentation();
  return useMemo(
    () =>
      new Map(
        (JSON.parse(key) as string[]).map((path) => [
          path,
          presentationIcon(path, entries.get(path), roots, root, build.spring),
        ]),
      ),
    [key, entries, roots, root, build.spring],
  );
}
