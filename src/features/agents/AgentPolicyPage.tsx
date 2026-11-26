/**
 * Command Rules defines the allow and block patterns for agent permission requests.
 */
import { useMemo } from "react";
import { tx } from "@/platform/i18n";
import { validateAgentSecurity } from "@/platform/workflowSettings";
import { GlobListEditor, Section } from "@/features/settings/components/Form";
import { T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import styles from "./AgentPolicy.module.css";

export function AgentPolicyPage() {
  const form = useSettingsForm();
  const raw = form.useValue("agentSecurity");
  const policy = useMemo(() => validateAgentSecurity(raw), [raw]);

  return (
    <div className={styles.body} role="region" aria-label={tx("Command Rules")}>
      <Section title="Allowed Commands">
        <p className={styles.hint}>
          <T>Run without asking, with or without extra arguments.</T>
        </p>
        <GlobListEditor
          fullWidth
          value={policy.allowedCommands}
          onChange={(allowedCommands) => form.set("agentSecurity", { ...policy, allowedCommands })}
          placeholder="cargo test"
          emptyText="No allowed commands"
          itemLabel="Allowed command pattern"
          aria-label="Allowed commands"
        />
      </Section>
      <Section title="Blocked Commands">
        <p className={styles.hint}>
          <T>Always rejected, even when allowed. Supports * and ? wildcards.</T>
        </p>
        <GlobListEditor
          fullWidth
          value={policy.blockedCommands}
          onChange={(blockedCommands) => form.set("agentSecurity", { ...policy, blockedCommands })}
          placeholder="rm -rf *"
          emptyText="No blocked commands"
          itemLabel="Blocked command pattern"
          aria-label="Blocked commands"
        />
      </Section>
      <p className={styles.hint}>
        <T>Commands with substitutions, redirections or variable assignments always ask.</T>
      </p>
    </div>
  );
}
