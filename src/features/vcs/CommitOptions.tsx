/**
 * Commit Options popup (the gear next to Commit, after IDEA's): Git author and
 * sign-off, before-commit modifications, Git hooks and the commit checks. The
 * checks and their options are edited in place.
 */
import { useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { RunConfig } from "@/bindings";
import { executeAction, useRunningActions } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { loadSettings, useProject } from "@/platform/project";
import { useTodoSettings } from "@/platform/todo";
import { setTodoFilterSelection, useTodoFilterSelection } from "@/platform/todoFilterSelection";
import { useWorkflowSettings, workflowSettings } from "@/platform/workflowSettings";
import { runConfigurationChecks, useCommitCheckProviders } from "@/workbench/contributions";
import { Checkbox, Menu, Popup, Select, T } from "@/ui";
import { editTodoFiltersItem, todoFilterChoices } from "@/workbench/todoFilterMenu";
import { CommitAuthorFields } from "./CommitAuthorFields";
import { setCommitAuthor, useCommit } from "./commitStore";
import { useStagingArea } from "./staging";
import { setCommitTestSelection, useCommitTestSelection } from "./commitTests";
import styles from "./CommitView.module.css";

type CommitCheck = "reformat" | "optimizeImports" | "cleanup" | "analyzeCode" | "checkTodo" | "postponeSlowChecks";

async function setCheck(key: CommitCheck, value: boolean) {
  if (!isTauri()) return;
  try {
    await call(commands.settingsSet("global", `vcs.commit.${key}`, JSON.stringify(value)));
    await loadSettings();
  } catch {
    // keep the previous value
  }
}

async function setContributedCheck(key: string, on: boolean) {
  if (!isTauri()) return;
  const off = new Set(workflowSettings().vcs.commit.disabledPluginChecks);
  if (on) off.delete(key);
  else off.add(key);
  try {
    await call(commands.settingsSet("global", "vcs.commit.disabledPluginChecks", JSON.stringify([...off].sort())));
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

function ConfigureTodoFilter({ disabled }: { disabled: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const settings = useTodoSettings();
  const selectedId = useTodoFilterSelection("commit");
  const filter = settings.filters.find(({ id }) => id === selectedId);
  const items = todoFilterChoices(settings, filter?.id ?? null, (id) => {
    if (useCommit.getState().operation) return;
    setTodoFilterSelection("commit", id);
    useCommit.setState({ checkResult: null });
  });
  return (
    <>
      <button
        type="button"
        className={`${styles.optLink} ${styles.todoFilter}`}
        aria-label={tx("Configure TODO Filter")}
        title={filter?.name}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        disabled={disabled}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        {filter?.name ?? <T>Configure</T>}
      </button>
      <Menu
        open={!!anchor && !disabled}
        anchor={anchor}
        items={[...items, { kind: "separator" }, editTodoFiltersItem]}
        onClose={() => setAnchor(null)}
        aria-label="TODO filters"
      />
    </>
  );
}

const noConfigurations: readonly RunConfig[] = [];
const emptyConfigurations = () => noConfigurations;
const noSubscription = () => () => {};

function TestOption({ busy }: { busy: boolean }) {
  const service = runConfigurationChecks();
  const trusted = useProject((state) => state.project?.trusted);
  const configs = useSyncExternalStore(
    service?.subscribe ?? noSubscription,
    service?.configurations ?? emptyConfigurations,
  );
  const selection = useCommitTestSelection();
  const options = configs.map(({ id, name }) => ({ value: id, label: name, verbatim: true }));
  if (selection && !options.some((option) => option.value === selection.id))
    options.push({ value: selection.id, label: selection.name, verbatim: true });
  return (
    <div className={styles.optRow}>
      <Checkbox
        label="Run Tests"
        checked={selection?.enabled ?? false}
        disabled={busy || !trusted || !selection}
        onChange={(enabled) => {
          if (selection) setCommitTestSelection({ ...selection, enabled });
        }}
      />
      <Select
        aria-label="Test run configuration"
        aria-description={tx("Tests run against the working tree.")}
        placeholder="Choose configuration"
        value={selection?.id ?? null}
        options={options}
        disabled={busy || !trusted || !configs.length}
        onChange={(id) => {
          const config = configs.find((item) => item.id === id);
          if (config) setCommitTestSelection({ id, name: config.name, enabled: selection?.enabled ?? false });
        }}
        variant="ghost"
        className={styles.testConfiguration}
        searchable
      />
    </div>
  );
}

/** The options themselves: in the popup, and inline beside the Commit dialog's message. */
export function CommitOptionsBody({
  afterRunChecks,
  focusAuthor,
}: {
  afterRunChecks?: () => void;
  focusAuthor?: boolean;
}) {
  const author = useCommit((s) => s.author);
  const authorDate = useCommit((s) => s.authorDate);
  const amend = useCommit((s) => s.amend);
  const signOff = useCommit((s) => s.signOff);
  const runHooks = useCommit((s) => s.runHooks);
  const busy = useCommit((s) => !!s.operation);
  const c = useWorkflowSettings((s) => s.vcs.commit);
  const staging = useStagingArea();
  const savingCommitAll = useRunningActions((s) => s.running.has("vcs.toggleCommitAllWhenNothingStaged"));
  const contributed = useCommitCheckProviders((s) => s.providers).flatMap((p) => p.checks());
  const check = (key: CommitCheck, label: string, extra?: ReactNode) => (
    <div className={styles.optRow}>
      <Checkbox checked={c[key]} onChange={(v) => void setCheck(key, v)} label={label} />
      {extra}
    </div>
  );
  return (
    <>
      <Section title="Git">
        <CommitAuthorFields
          author={author}
          authorDate={authorDate}
          preserveOriginal={amend}
          focusAuthor={focusAuthor}
          onChange={setCommitAuthor}
        />
        <Checkbox checked={signOff} onChange={(v) => useCommit.setState({ signOff: v })} label="Sign-off commit" />
        {staging && (
          <Checkbox
            checked={c.commitAllWhenNothingStaged}
            disabled={savingCommitAll}
            onChange={() => void executeAction("vcs.toggleCommitAllWhenNothingStaged")}
            label="Commit All when Nothing Is Staged"
          />
        )}
      </Section>
      <Section title="Commit Checks">
        {check("reformat", "Reformat code")}
        {check("optimizeImports", "Optimize imports")}
        {check("cleanup", "Cleanup")}
        <Checkbox checked={runHooks} onChange={(v) => useCommit.setState({ runHooks: v })} label="Run Git hooks" />
      </Section>
      <Section title="Advanced Commit Checks">
        {c.nonModal && check("postponeSlowChecks", "Run advanced checks after commit")}
        {check("analyzeCode", "Analyze code")}
        {check("checkTodo", "Check TODO", <ConfigureTodoFilter disabled={busy} />)}
        {c.nonModal && <TestOption busy={busy} />}
        {contributed.map((k) => (
          <div key={k.key} className={styles.optRow}>
            <Checkbox
              checked={!c.disabledPluginChecks.includes(k.key)}
              onChange={(v) => void setContributedCheck(k.key, v)}
              label={k.title}
            />
          </div>
        ))}
      </Section>
      <div>
        <button
          type="button"
          className={styles.optLink}
          disabled={busy}
          onClick={() => {
            afterRunChecks?.();
            void executeAction("vcs.runCommitChecks", "current");
          }}
        >
          <T>Run Commit Checks</T>
        </button>
      </div>
    </>
  );
}

export function CommitOptionsPopup({
  anchor,
  onClose,
  focusAuthor,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  focusAuthor?: boolean;
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
      {!focusAuthor && <div tabIndex={-1} data-autofocus className={styles.optFocus} />}
      <CommitOptionsBody afterRunChecks={onClose} focusAuthor={focusAuthor} />
    </Popup>
  );
}
