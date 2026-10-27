/** Status bar widget: tasks waiting for the user / running; opens the most urgent one. */
import { Icon, Spinner, T } from "@/ui";
import { openTask, useAgents } from "./store";
import styles from "./Agents.module.css";

export function AgentsStatus() {
  const tasks = useAgents((s) => s.tasks);
  const list = [...tasks.values()];
  const input = list.filter((t) => t.status === "needsInput");
  const running = list.filter((t) => t.status === "running" || t.status === "starting").length;
  if (!input.length && !running) return null;
  const target = input[0] ?? list.find((t) => t.status === "running");
  return (
    <button type="button" className={styles.statusItem} onClick={() => target && openTask(target.id)}>
      {input.length > 0 && (
        <span className={styles.statusPart}>
          <Icon name="warning" size={13} />
          {input.length} <T>needs input</T>
        </span>
      )}
      {running > 0 && (
        <span className={styles.statusPart}>
          <Spinner size={10} />
          {running} <T>running</T>
        </span>
      )}
    </button>
  );
}
