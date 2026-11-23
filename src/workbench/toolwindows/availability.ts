/**
 * Tool windows that only some projects use (.NET, Logcat) say so with `appliesToProject`:
 * elsewhere they stay out of the stripe's "…" and the phone's More. Their actions still open
 * them. Re-checked when the project or its files change (index finished, files created or
 * removed); without a project, or when the check fails, they count as applying.
 */
import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useContributions, type ToolWindowContribution } from "../contributions";

export const useToolWindowAvailability = create<{ unavailable: ReadonlySet<string> }>(() => ({
  unavailable: new Set(),
}));

/** Whether `tw` belongs in the lists of tool windows to open. */
export function toolWindowApplies(tw: ToolWindowContribution, unavailable: ReadonlySet<string>): boolean {
  return !unavailable.has(tw.id);
}

/** Whether the project holds files with one of `extensions` (no dot) or named one of `names`. */
export async function projectHasFiles({ extensions = [], names = [] }: { extensions?: string[]; names?: string[] }) {
  if (extensions.length) {
    const counts = await call(commands.indexFileExtensions());
    const wanted = new Set(extensions.map((e) => e.toLowerCase()));
    if (counts.some((c) => c.files > 0 && wanted.has(c.extension.toLowerCase()))) return true;
  }
  for (const name of names) if ((await call(commands.findFilesNamed(name))).length) return true;
  return false;
}

export function installToolWindowAvailability(): () => void {
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    const request = ++sequence;
    const checked = [...useContributions.getState().toolWindows.values()].filter((tw) => tw.appliesToProject);
    const project = !!useProject.getState().project && isTauri();
    const results = await Promise.all(
      checked.map(async (tw) => [tw.id, !project || (await tw.appliesToProject!().catch(() => true))] as const),
    );
    if (request !== sequence) return;
    useToolWindowAvailability.setState({ unavailable: new Set(results.filter(([, ok]) => !ok).map(([id]) => id)) });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 300);
  };
  void refresh();
  const off = [
    onIdeEvent("indexState", (e) => {
      if (!e.indexing) schedule();
    }),
    onIdeEvent("fsChanged", (e) => {
      if (e.created.length || e.removed.length) schedule();
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void refresh();
    }),
    useContributions.subscribe((s, prev) => {
      if (s.toolWindows !== prev.toolWindows) schedule();
    }),
  ];
  return () => {
    clearTimeout(timer);
    sequence++;
    off.forEach((f) => f());
  };
}
