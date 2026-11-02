/**
 * Settings › Tools › Agents › Command Execution Policy: whitelist (auto-approve)
 * and blacklist (auto-reject) command patterns evaluated on agent permission requests.
 */
import { useMemo, useState } from "react";
import { tx } from "@/platform/i18n";
import { validateAgentSecurity } from "@/platform/workflowSettings";
import { Button, IconButton, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import styles from "./AgentPolicy.module.css";

export function AgentPolicyPage() {
  const form = useSettingsForm();
  const raw = form.useValue("agentSecurity");
  const policy = useMemo(() => validateAgentSecurity(raw), [raw]);
  const [allowDraft, setAllowDraft] = useState("");
  const [blockDraft, setBlockDraft] = useState("");

  const addAllowed = () => {
    const pattern = allowDraft.trim();
    if (!pattern) return;
    setAllowDraft("");
    if (policy.allowedCommands.includes(pattern)) return;
    form.set("agentSecurity", { ...policy, allowedCommands: [...policy.allowedCommands, pattern] });
  };

  const removeAllowed = (pattern: string) => {
    form.set("agentSecurity", {
      ...policy,
      allowedCommands: policy.allowedCommands.filter((p) => p !== pattern),
    });
  };

  const addBlocked = () => {
    const pattern = blockDraft.trim();
    if (!pattern) return;
    setBlockDraft("");
    if (policy.blockedCommands.includes(pattern)) return;
    form.set("agentSecurity", { ...policy, blockedCommands: [...policy.blockedCommands, pattern] });
  };

  const removeBlocked = (pattern: string) => {
    form.set("agentSecurity", {
      ...policy,
      blockedCommands: policy.blockedCommands.filter((p) => p !== pattern),
    });
  };

  return (
    <section className={styles.body} aria-label="Command Execution Policy">
      <p className={styles.notice}>
        <T>
          Configure command patterns for AI agents. Allowed commands run automatically without prompting; blocked
          commands are rejected immediately and take precedence over allowed patterns. Supports prefix and glob
          wildcards (* and ?).
        </T>
      </p>
      <div className={styles.grid}>
        <div className={styles.column}>
          <div className={styles.columnTitle}>
            <T>Allowed Commands (Whitelist)</T>
          </div>
          <div className={styles.items}>
            {policy.allowedCommands.map((pattern) => (
              <div key={pattern} className={styles.item}>
                <code className={styles.pattern}>{pattern}</code>
                <IconButton
                  icon="close"
                  size="small"
                  title={tx`Remove ${pattern}`}
                  onClick={() => removeAllowed(pattern)}
                />
              </div>
            ))}
          </div>
          <div className={styles.add}>
            <input
              type="text"
              className={styles.input}
              value={allowDraft}
              onChange={(e) => setAllowDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addAllowed()}
              placeholder={tx("e.g. cargo test*")}
              aria-label="Allowed command pattern"
            />
            <Button size="small" aria-label="Add allowed command" onClick={addAllowed}>
              Add
            </Button>
          </div>
        </div>
        <div className={styles.column}>
          <div className={styles.columnTitle}>
            <T>Blocked Commands (Blacklist)</T>
          </div>
          <div className={styles.items}>
            {policy.blockedCommands.map((pattern) => (
              <div key={pattern} className={styles.item}>
                <code className={styles.pattern}>{pattern}</code>
                <IconButton
                  icon="close"
                  size="small"
                  title={tx`Remove ${pattern}`}
                  onClick={() => removeBlocked(pattern)}
                />
              </div>
            ))}
          </div>
          <div className={styles.add}>
            <input
              type="text"
              className={styles.input}
              value={blockDraft}
              onChange={(e) => setBlockDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addBlocked()}
              placeholder={tx("e.g. rm -rf *")}
              aria-label="Blocked command pattern"
            />
            <Button size="small" aria-label="Add blocked command" onClick={addBlocked}>
              Add
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
