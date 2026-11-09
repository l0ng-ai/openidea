/** Bounded, read-only detection for content roots, including collapsed workspace members. */
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { detectProjectType, isProjectManifest } from "./projectType";
import { useProjectTree } from "./store";

const MAX_MANIFEST_BYTES = 256 * 1024;
const NESTED = ["gradle/libs.versions.toml", "ProjectSettings/ProjectVersion.txt", "src-tauri/tauri.conf.json"];

async function detect(root: string) {
  const entries = await call(commands.fsReadDir(root));
  const paths = entries
    .filter((e) => e.kind === "file" && e.size <= MAX_MANIFEST_BYTES && isProjectManifest(e.name))
    .map((e) => e.name);
  for (const path of NESTED) {
    if (!entries.some((e) => e.kind === "dir" && e.name === path.split("/")[0])) continue;
    const probe = await call(commands.fsProbe(`${root}/${path}`)).catch(() => null);
    if (probe && !probe.binary && probe.size <= MAX_MANIFEST_BYTES) paths.push(path);
  }
  const files = await Promise.all(
    paths.map(async (path) => {
      const text = await call(commands.fsReadText(`${root}/${path}`)).catch(() => null);
      return text === null ? [] : [[path, text] as const];
    }),
  );
  return detectProjectType(new Map(files.flat()));
}

export function initProjectTypes(): () => void {
  let reset: (() => void) | undefined;
  const load = () => {
    reset?.();
    const { root, members } = useProjectTree.getState();
    if (!root || !isTauri()) return;
    const roots = members ?? [root];
    const pending = new Set(roots);
    const versions = new Map<string, number>();
    let active = 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pump = () => {
      while (!disposed && active < 4 && pending.size) {
        const path = pending.values().next().value!;
        pending.delete(path);
        const version = versions.get(path) ?? 0;
        active++;
        void detect(path)
          .catch(() => null)
          .then((type) => {
            if (disposed || (versions.get(path) ?? 0) !== version) return;
            useProjectTree.setState((s) => {
              if (s.projectTypes.get(path) === (type ?? undefined)) return s;
              const projectTypes = new Map(s.projectTypes);
              if (type) projectTypes.set(path, type);
              else projectTypes.delete(path);
              return { projectTypes };
            });
          })
          .finally(() => {
            active--;
            pump();
          });
      }
    };
    const events = onIdeEvent("fsChanged", (e) => {
      const paths = [...e.created, ...e.modified, ...e.removed];
      for (const path of roots) {
        if (
          !paths.some(
            (p) =>
              p === path ||
              (p.startsWith(`${path}/`) &&
                (isProjectManifest(p.slice(path.length + 1)) ||
                  NESTED.some((n) => n.startsWith(`${p.slice(path.length + 1)}/`)))),
          )
        )
          continue;
        versions.set(path, (versions.get(path) ?? 0) + 1);
        pending.add(path);
      }
      if (!pending.size) return;
      clearTimeout(timer);
      timer = setTimeout(pump, 100);
    });
    reset = () => {
      disposed = true;
      clearTimeout(timer);
      events();
    };
    pump();
  };
  const project = useProjectTree.subscribe((s, prev) => {
    if (s.root !== prev.root || s.members !== prev.members) load();
  });
  load();
  return () => {
    project();
    reset?.();
  };
}
