/** Bounded, read-only detection for workspace members, collapsed ones included; a single project root keeps its own icon. */
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { detectProjectType, isProjectMarker } from "./projectType";
import { useProjectTree } from "./store";

async function detect(root: string) {
  const entries = await call(commands.fsReadDir(root));
  return detectProjectType(
    new Set(
      entries.filter((e) => e.kind === "file" || (e.kind === "symlink" && e.targetKind === "file")).map((e) => e.name),
    ),
  );
}

export function initProjectTypes(): () => void {
  let reset: (() => void) | undefined;
  const load = () => {
    reset?.();
    const { root, members: roots } = useProjectTree.getState();
    if (!root || !roots || !isTauri()) return;
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
        if (!paths.some((p) => p === path || (p.startsWith(`${path}/`) && isProjectMarker(p.slice(path.length + 1)))))
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
