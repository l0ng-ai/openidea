import type { FileStatus } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { ipcPath, isSameOrInside } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { rootOf, stripSlash } from "./model";
import { runOp } from "./ops";
import { refreshNow, useVcs, type VcsState } from "./store";

const pathKey = (path: string) => stripSlash(ipcPath(path));
const untracked = (file: FileStatus | undefined) =>
  file?.unstaged === "untracked" && !file.staged && !file.path.endsWith("/");
const ready = (vcs: VcsState) => vcs.available && vcs.statusLoaded && !vcs.loading && !vcs.error;
const selectedRepo = (vcs: VcsState) => vcs.repo ?? vcs.roots[0] ?? null;
const statusByPath = () => new Map(useVcs.getState().status.map((file) => [pathKey(file.path), file]));

interface PendingMetadata {
  repo: string;
  confirmed: boolean;
  seenAdded: boolean;
}

/** Pair only IDE-created files whose addition succeeded, for this project/repository session. */
export function createUnityMetadataStaging() {
  const pending = new Map<string, PendingMetadata>();
  let generation = 0;
  let disposed = false;
  let staging = false;
  const clear = () => {
    generation++;
    pending.clear();
  };

  const drain = () => {
    const vcs = useVcs.getState();
    if (disposed || !pending.size || !ready(vcs)) return;
    const status = statusByPath();
    const files: string[] = [];
    for (const [asset, entry] of pending) {
      const source = status.get(asset);
      const meta = status.get(`${asset}.meta`);
      if (source?.staged === "added") entry.seenAdded = true;
      if (
        ((entry.confirmed || entry.seenAdded) && source?.staged !== "added") ||
        source?.unstaged === "deleted" ||
        rootOf(asset, vcs.roots) !== entry.repo ||
        rootOf(`${asset}.meta`, vcs.roots) !== entry.repo ||
        (meta && !untracked(meta))
      ) {
        pending.delete(asset);
      } else if (meta && entry.confirmed && !staging) {
        // Consume consent before invoking: a failed addition must not retry on every refresh.
        pending.delete(asset);
        files.push(meta.path);
      }
    }
    if (!files.length) return;
    staging = true;
    void runOp(files.length === 1 ? tx("Add 1 file to Git") : tx`Add ${files.length} files to Git`, () =>
      call(commands.vcsStage(files)),
    ).finally(() => {
      staging = false;
      drain();
    });
  };

  const stopVcs = useVcs.subscribe((s, prev) => {
    const before = selectedRepo(prev);
    // The first refresh discovers the primary repository; that is not a user switch.
    if (s.root !== prev.root || !s.available || (before && selectedRepo(s) !== before)) clear();
    else drain();
  });
  const stopProject = useProject.subscribe((s, prev) => {
    if (
      s.project?.root !== prev.project?.root ||
      !!s.project?.unity !== !!prev.project?.unity ||
      (s.opening && !prev.opening)
    )
      clear();
  });

  return {
    begin(paths: readonly string[]) {
      const started = generation;
      const current = () => !disposed && generation === started && !useProject.getState().opening;
      const project = useProject.getState().project;
      const assetsDir = project?.unity ? `${pathKey(project.root)}/Assets` : null;
      const requested = new Set(paths.map(pathKey));
      const attempt = new Map<string, PendingMetadata>();
      let assets: Map<string, string> | undefined;

      const include = (files: readonly string[]) => {
        const vcs = useVcs.getState();
        const status = statusByPath();
        const paired = (assets ??= new Map(
          files.flatMap((file) => {
            const path = pathKey(file);
            const source = status.get(path);
            const repo = rootOf(path, vcs.roots);
            return assetsDir &&
              requested.has(path) &&
              path !== assetsDir &&
              isSameOrInside(path, assetsDir) &&
              !path.toLowerCase().endsWith(".meta") &&
              source &&
              untracked(source) &&
              repo &&
              rootOf(`${path}.meta`, vcs.roots) === repo
              ? [[path, repo] as const]
              : [];
          }),
        ));
        const out = new Set(
          files.filter((file) => {
            const path = pathKey(file);
            return !(paired.has(path) || paired.has(path.replace(/\.meta$/, ""))) || untracked(status.get(path));
          }),
        );
        for (const [asset, repo] of paired) {
          if (!untracked(status.get(asset)) || rootOf(asset, vcs.roots) !== repo) {
            out.delete(asset);
            out.delete(`${asset}.meta`);
            paired.delete(asset);
            continue;
          }
          const meta = status.get(`${asset}.meta`);
          if (meta && untracked(meta) && rootOf(pathKey(meta.path), vcs.roots) === repo) out.add(meta.path);
        }
        return [...out];
      };

      return {
        current,
        include,
        async beforeStage(files: readonly string[]) {
          if (assets?.size) {
            await refreshNow();
            if (!ready(useVcs.getState())) return [];
          }
          if (!current()) return [];
          const out = include(files);
          const selected = new Set(out.map(pathKey));
          for (const [asset, repo] of assets ?? []) {
            // Observe cancellation while the initial IPC is in flight, but do not
            // add metadata until it succeeds. Already included metadata is finished.
            if (selected.has(`${asset}.meta`)) continue;
            const entry = { repo, confirmed: false, seenAdded: false };
            attempt.set(asset, entry);
            pending.set(asset, entry);
          }
          return out;
        },
        async finished(ok: boolean) {
          for (const [asset, entry] of attempt) {
            if (pending.get(asset) !== entry) continue;
            if (ok && current()) entry.confirmed = true;
            else pending.delete(asset);
          }
          if (!ok || !current() || !attempt.size) return;
          await refreshNow();
          if (current()) drain();
        },
      };
    },
    dispose() {
      disposed = true;
      clear();
      stopVcs();
      stopProject();
    },
  };
}
