/** Keeps a language's status bar widget out of projects that don't use the language. */
import { isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setStatusWidgetAvailable } from "@/workbench/statusBarWidgets";

/**
 * Re-checks `applies` when the project, its files (index finished, files created or
 * removed) or the settings change. Without a project, or when the check fails, the
 * widget counts as available.
 */
export function trackStatusWidgetAvailability(id: string, applies: () => Promise<boolean>): () => void {
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    const request = ++sequence;
    if (!useProject.getState().project || !isTauri()) {
      setStatusWidgetAvailable(id, true);
      return;
    }
    const available = await applies().catch(() => true);
    if (request === sequence) setStatusWidgetAvailable(id, available);
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
    onIdeEvent("settingsChanged", schedule),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void refresh();
    }),
  ];
  return () => {
    sequence++;
    clearTimeout(timer);
    off.forEach((dispose) => dispose());
    setStatusWidgetAvailable(id, true);
  };
}
