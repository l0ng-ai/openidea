import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";

/** One debounced disk check per window activation, scoped to its current project. */
export function installDiskSync(sync: () => Promise<void>, canSync: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;
  const enabled = () => {
    const s = useProject.getState();
    return (
      !disposed && canSync() && !s.opening && (s.project || s.lightEdit) && s.settings?.files?.syncOnFocus !== false
    );
  };
  const onFocus = () => {
    clearTimeout(timer);
    if (!enabled()) return;
    const { project, lightEdit } = useProject.getState();
    timer = setTimeout(async () => {
      if (!enabled() || useProject.getState().project !== project || useProject.getState().lightEdit !== lightEdit)
        return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        await sync();
        if (enabled() && useProject.getState().project === project && !lightEdit) {
          void executeAction("project.refresh");
          void executeAction("vcs.refresh");
        }
      } catch (e) {
        console.warn("Cannot synchronize external file changes", e);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          onFocus();
        }
      }
    }, 200);
  };
  window.addEventListener("focus", onFocus);
  return () => {
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener("focus", onFocus);
  };
}
