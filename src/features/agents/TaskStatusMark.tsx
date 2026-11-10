/** The tab strip's agent status indicator: spinner while the task is busy, dot once done (#2233). */
import { Badge, Spinner, tooltipAttrs } from "@/ui";
import { isBusy, statusLabel } from "./model";
import { useAgents } from "./store";

export function TaskStatusMark({ task }: { task: string }) {
  const status = useAgents((s) => s.tasks.get(task)?.status);
  if (!status) return null;
  const busy = isBusy(status);
  const label = statusLabel(status);
  return (
    <span {...tooltipAttrs(label, undefined, true)} style={{ display: "inline-flex", alignItems: "center" }}>
      {busy ? (
        <Spinner size={10} variant="spokes" label={label} />
      ) : (
        <Badge
          dot
          tone={status === "ready" ? "success" : status === "failed" || status === "limited" ? "danger" : "neutral"}
        >
          {label}
        </Badge>
      )}
    </span>
  );
}
