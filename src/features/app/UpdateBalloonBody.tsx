/** The running update's progress in its balloon, for windows without a status bar (the welcome screen). */
import { ProgressBar } from "@/ui";
import { useTasks } from "@/workbench/tasks";

export function UpdateBalloonBody({ task }: { task: string }) {
  const current = useTasks((s) => s.tasks.find((t) => t.id === task));
  if (!current || current.done) return null;
  return (
    <>
      {current.message && <div>{current.message}</div>}
      <ProgressBar value={current.fraction} aria-label={current.title} />
    </>
  );
}
