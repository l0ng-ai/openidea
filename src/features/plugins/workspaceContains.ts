import { setContext } from "@/platform/context";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { usePlugins } from "./store";

const KEY = /workspaceContains:[\w.\-:/]+/g;

export function workspaceContainsKeys(whens: readonly (string | null | undefined)[]): string[] {
  return [...new Set(whens.flatMap((when) => when?.match(KEY) ?? []))];
}

export async function refreshWorkspaceContains(
  root: string | null,
  keys: readonly string[],
  list: (dir: string) => Promise<string[]>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const results = await Promise.all(
    keys.map(async (key) => {
      if (root === null) {
        return [key, false] as const;
      }
      const path = key.slice("workspaceContains:".length);
      const slash = path.lastIndexOf("/");
      const parent = slash < 0 ? "" : path.slice(0, slash);
      const name = path.slice(slash + 1);
      const names: string[] = await list(parent ? `${root}/${parent}` : root).catch(() => []);
      return [key, names.includes(name)] as const;
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

export function startWorkspaceContains(): () => void {
  let latest = 0;
  const refresh = () => {
    const token = ++latest;
    const keys = workspaceContainsKeys(usePlugins.getState().ui.map((u) => (u.decl as { when?: string | null }).when));
    void refreshWorkspaceContains(useProject.getState().project?.root ?? null, keys, listNames, () => token === latest);
  };
  const disposers = [
    usePlugins.subscribe((s, prev) => {
      if (s.ui !== prev.ui) refresh();
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) refresh();
    }),
    onIdeEvent("fsChanged", (e) => {
      const root = useProject.getState().project?.root;
      if (root && [...e.created, ...e.removed].some((p) => p.startsWith(root))) refresh();
    }),
  ];
  refresh();
  return () => disposers.forEach((d) => d());
}
