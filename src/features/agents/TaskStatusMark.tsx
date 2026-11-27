/**
 * The tab strip's agent status indicator (#2233): a spinner while the task is busy, then a
 * dot only while something waits for you (a finished reply not yet read, a question, an error).
 */
import { Badge, Spinner, tooltipAttrs } from "@/ui";
import { isBusy, statusLabel } from "./model";
import { useAgents } from "./store";

export function TaskStatusMark({ task }: { task: string }) {
  const status = useAgents((s) => s.tasks.get(task)?.status);
  const unread = useAgents((s) => s.unread.has(task));
  if (!status) return null;
  // Waiting for you is a dot, not a spinner: the task stops until you answer.
  const busy = isBusy(status) && status !== "needsInput";
  const tone =
    status === "failed" || status === "limited"
      ? "danger"
      : status === "needsInput"
        ? "warning"
        : status === "ready" && unread
          ? "success"
          : null;
  if (!busy && !tone) return null;
  const label = statusLabel(status);
  return (
    <span {...tooltipAttrs(label, undefined, true)} style={{ display: "inline-flex", alignItems: "center" }}>
      {busy ? (
        <Spinner size={10} variant="spokes" label={label} />
      ) : (
        <Badge dot tone={tone!}>
          {label}
        </Badge>
      )}
    </span>
  );
}
