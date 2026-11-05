import { setContext } from "@/platform/context";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { usePlugins } from "./store";

const PREFIX = "workspaceContains:";
const KEY = /(?<![\w.\-:/])workspaceContains:[\w.\-:/]+/g;

export function workspaceContainsKeys(whens: readonly (string | null | undefined)[]): string[] {
  return [...new Set(whens.flatMap((when) => when?.match(KEY) ?? []))];
}

function relativePath(key: string): string | null {
  const path = key.slice(PREFIX.length).replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return null;
  }
  return path;
}

export function affectsWorkspaceContains(
  changed: readonly string[],
  roots: readonly string[],
  keys: readonly string[],
): boolean {
  const targets = keys.flatMap((key) => {
    const path = relativePath(key);
    return path === null ? [] : roots.map((root) => `${root}/${path}`);
  });
  return changed.some((p) => targets.some((t) => t === p || t.startsWith(`${p}/`)));
}

export async function refreshWorkspaceContains(
  roots: readonly string[],
  keys: readonly string[],
  list: (dir: string) => Promise<string[]>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const results = await Promise.all(
    keys.map(async (key) => {
      const path = relativePath(key);
      if (path === null) {
        return [key, false] as const;
      }
      const slash = path.lastIndexOf("/");
      const parent = slash < 0 ? "" : path.slice(0, slash);
      const name = path.slice(slash + 1);
      const found = await Promise.all(
        roots.map(async (root) => {
          const names: string[] = await list(parent ? `${root}/${parent}` : root).catch(() => []);
          return names.includes(name);
        }),
      );
      return [key, found.some(Boolean)] as const;
    }),
  );
  if (!isCurrent()) {
    return;
  }
  for (const [key, value] of results) {
    setContext(key, value);
  }
}

const listNames = (dir: string) => call(commands.fsReadDir(dir)).then((entries) => entries.map((e) => e.name));

const projectRoots = () => {
  const project = useProject.getState().project;
  return project?.workspace?.projects ?? (project ? [project.root] : []);
};

export function startWorkspaceContains(): () => void {
  let latest = 0;
  const currentKeys = () =>
    workspaceContainsKeys(usePlugins.getState().ui.map((u) => (u.decl as { when?: string | null }).when));
  const refresh = () => {
    const token = ++latest;
    void refreshWorkspaceContains(projectRoots(), currentKeys(), listNames, () => token === latest);
  };
  const disposers = [
    usePlugins.subscribe((s, prev) => {
      if (s.ui !== prev.ui) refresh();
    }),
    useProject.subscribe((s, prev) => {
      if (
        s.project?.root !== prev.project?.root ||
        s.project?.workspace?.projects.join("\n") !== prev.project?.workspace?.projects.join("\n")
      ) {
        refresh();
      }
    }),
    onIdeEvent("fsChanged", (e) => {
      if (affectsWorkspaceContains([...e.created, ...e.removed], projectRoots(), currentKeys())) refresh();
    }),
  ];
  refresh();
  return () => disposers.forEach((d) => d());
}
