/** Settings › Agents › Coding Agents. */
import { AgentList } from "./AgentList";
import { tauriCommands, tauriRegistry, type CommandsBackend, type RegistryBackend } from "./registry";
import styles from "./AgentRegistry.module.css";

export function AgentRegistryPage({
  onChanged,
  backend = tauriRegistry,
  commandBackend = tauriCommands,
}: {
  /** An agent was installed, updated or removed (the agent list changed). */
  onChanged?: () => void;
  backend?: RegistryBackend;
  commandBackend?: CommandsBackend;
}) {
  return (
    <div className={styles.body}>
      <AgentList backend={commandBackend} registry={backend} onChanged={onChanged} />
    </div>
  );
}
