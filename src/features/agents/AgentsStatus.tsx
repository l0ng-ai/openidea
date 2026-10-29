/** Status bar widget: tasks waiting for the user / running; opens the most urgent one. */
import { Icon, Spinner, T } from "@/ui";
import { openTask, useAgents } from "./store";
import styles from "./Agents.module.css";

export function AgentsStatus() {
  const tasks = useAgents((s) => s.tasks);
  const unread = useAgents((s) => s.unread);
  const list = [...tasks.values()];
  const unseen = list.filter((t) => unread.has(t.id)).sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
  const input = list.filter((t) => t.status === "needsInput");
  const running = list.filter((t) => t.status === "running" || t.status === "starting").length;
  if (!input.length && !running && !unseen.length) return null;
  const target = input[0] ?? unseen[0] ?? list.find((t) => t.status === "running" || t.status === "starting");
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
      {unseen.length > 0 && (
        <span className={styles.statusPart}>
          <span className={styles.unreadDot} aria-hidden="true" />
          {unseen.length} <T>unread</T>
        </span>
      )}
    </button>
  );
}
