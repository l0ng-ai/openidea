/**
 * Commit Options popup (the gear next to Commit, after IDEA's): Git author and
 * sign-off, before-commit modifications, Git hooks and the commit checks. The
 * checks are the Settings › Version Control › Commit values, edited in place.
 */
import type { ReactNode, RefObject } from "react";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { Checkbox, Input, Popup, T } from "@/ui";
import { useCommit } from "./commitStore";
import styles from "./CommitView.module.css";

type CommitCheck = "reformat" | "optimizeImports" | "cleanup" | "analyzeCode" | "checkTodo";

async function setCheck(key: CommitCheck, value: boolean) {
  if (!isTauri()) return;
  try {
    await call(commands.settingsSet("global", `vcs.commit.${key}`, JSON.stringify(value)));
    await loadSettings();
  } catch {
    // keep the previous value
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.optSection}>
      <h3 className={styles.optTitle}>
        <T>{title}</T>
      </h3>
      <div className={styles.optBody}>{children}</div>
    </section>
  );
}

function Configure() {
  return (
    <button type="button" className={styles.optLink} onClick={() => void executeAction("file.settings", "vcs.commit")}>
      <T>Configure</T>
    </button>
  );
}

/** The options themselves: in the popup, and inline beside the Commit dialog's message. */
export function CommitOptionsBody() {
  const author = useCommit((s) => s.author);
  const signOff = useCommit((s) => s.signOff);
  const runHooks = useCommit((s) => s.runHooks);
  const c = useWorkflowSettings((s) => s.vcs.commit);
  const check = (key: CommitCheck, label: string, extra?: ReactNode) => (
    <div className={styles.optRow}>
      <Checkbox checked={c[key]} onChange={(v) => void setCheck(key, v)} label={label} />
      {extra}
    </div>
  );
  return (
    <>
      <Section title="Git">
        <label className={styles.optField}>
          <span>
            <T>Author:</T>
          </span>
          <Input
            value={author}
            title="Name <email>; empty uses the configured Git user"
            aria-label="Author"
            onChange={(e) => useCommit.setState({ author: e.target.value })}
          />
        </label>
        <Checkbox checked={signOff} onChange={(v) => useCommit.setState({ signOff: v })} label="Sign-off commit" />
      </Section>
      <Section title="Commit Checks">
        {check("reformat", "Reformat code")}
        {check("optimizeImports", "Optimize imports")}
        {check("cleanup", "Cleanup")}
        <Checkbox checked={runHooks} onChange={(v) => useCommit.setState({ runHooks: v })} label="Run Git hooks" />
      </Section>
      <Section title="Advanced Commit Checks">
        {check("analyzeCode", "Analyze code")}
        {check("checkTodo", "Check TODO", <Configure />)}
      </Section>
    </>
  );
}

export function CommitOptionsPopup({
  anchor,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <Popup
      open
      anchor={anchor}
      placement="top-start"
      onClose={onClose}
      role="dialog"
      aria-label="Commit Options"
      className={styles.options}
    >
      {/* IDEA opens the options without focusing the Author field. */}
      <div tabIndex={-1} data-autofocus className={styles.optFocus} />
      <CommitOptionsBody />
    </Popup>
  );
}
