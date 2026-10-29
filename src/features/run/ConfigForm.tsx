/**
 * The right side of Run/Debug Configurations: the type's own fields, the
 * common ones, the options added through "Modify options" (⌥M) and the
 * Before launch list.
 */
import { useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { BeforeLaunchTask, RunConfig } from "@/platform/ipc";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { Button, Checkbox, Icon, IconButton, Input, Menu, Select, T, type MenuItem, type SelectOption } from "@/ui";
import { useContributions, type RunConfigTypeContribution } from "@/workbench/contributions";
import { TASK_LABELS, taskLabel, type BeforeLaunchKind } from "./beforeLaunch";
import {
  commandLine,
  compoundCycle,
  configIcon,
  formatArgs,
  formatEnv,
  kindLabel,
  parseArgs,
  parseEnv,
  type ConfigErrors,
} from "./configs";
import { EnvDialog } from "./EnvDialog";
import { withTarget } from "./remote";
import { COMPOUND, formParams, terminalApplies, withParams } from "./types";
import styles from "./Run.module.css";

/**
 * Debug adapters with a real launch template (`debugger/launch.ts`, `debugger/java.ts`),
 * verified against small programs. Others (netcoredbg, dart, php-debug, …) only got
 * generic launch arguments and are left out until they have one; a configuration that
 * already names one keeps it.
 */
const ADAPTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "java-debug", label: "java-debug (Java)" },
  { id: "debugpy", label: "debugpy (Python)" },
  { id: "js-debug", label: "js-debug (Node.js / TypeScript)" },
  { id: "delve", label: "Delve (Go)" },
  { id: "codelldb", label: "CodeLLDB (Rust, C, C++)" },
  { id: "lldb-dap", label: "lldb-dap (C, C++, Swift)" },
];

/** Options "Modify options" adds to the form: value fields (shown once added) and flags (chips). */
export type OptionId =
  | "allowParallel"
  | "stdinFile"
  | "envFiles"
  | "outputFile"
  | "showOnStdout"
  | "showOnStderr"
  | "beforeLaunch"
  | "openToolWindow"
  | "focusToolWindow"
  | "isTest"
  | "emulateTerminal";

const VALUE_OPTIONS: ReadonlySet<OptionId> = new Set(["stdinFile", "envFiles", "outputFile", "beforeLaunch"]);

const OPTION_LABELS: Record<OptionId, string> = {
  allowParallel: "Allow multiple instances",
  stdinFile: "Redirect input",
  envFiles: 'Paths to ".env" files',
  outputFile: "Save console output to file",
  showOnStdout: "Show console when a message is printed to stdout",
  showOnStderr: "Show console when a message is printed to stderr",
  beforeLaunch: "Add before launch task",
  openToolWindow: "Open run/debug tool window when started",
  focusToolWindow: "Focus run/debug tool window when started",
  isTest: "Show results in the test runner",
  emulateTerminal: "Emulate terminal in output console",
};

const OPTION_GROUPS: ReadonlyArray<{ label: string; options: OptionId[]; process: boolean }> = [
  { label: "Operating System", options: ["allowParallel", "stdinFile", "envFiles", "emulateTerminal"], process: true },
  { label: "Logs", options: ["outputFile", "showOnStdout", "showOnStderr"], process: true },
  { label: "Test", options: ["isTest"], process: true },
  { label: "Before Launch", options: ["beforeLaunch", "openToolWindow", "focusToolWindow"], process: false },
];

/** Whether the option currently has a (non-default) value. */
export function optionSet(config: RunConfig, id: OptionId, openByDefault: boolean): boolean {
  switch (id) {
    case "allowParallel":
      return !!config.allowParallel;
    case "stdinFile":
      return !!config.stdinFile;
    case "envFiles":
      return !!config.envFiles?.length;
    case "outputFile":
      return !!config.outputFile;
    case "showOnStdout":
      return !!config.showOnStdout;
    case "showOnStderr":
      return !!config.showOnStderr;
    case "beforeLaunch":
      return !!config.beforeLaunch?.length;
    case "openToolWindow":
      return config.openToolWindow ?? openByDefault;
    case "focusToolWindow":
      return !!config.focusToolWindow;
    case "isTest":
      return config.isTest;
    case "emulateTerminal":
      return !!config.emulateTerminal;
  }
}

/** The patch that turns option `id` on or off. */
export function optionPatch(id: OptionId, on: boolean): Partial<RunConfig> {
  switch (id) {
    case "allowParallel":
      return { allowParallel: on };
    case "stdinFile":
      return { stdinFile: null };
    case "envFiles":
      return { envFiles: [] };
    case "outputFile":
      return { outputFile: null };
    case "beforeLaunch":
      return { beforeLaunch: [] };
    case "showOnStdout":
      return { showOnStdout: on };
    case "showOnStderr":
      return { showOnStderr: on };
    case "openToolWindow":
      return { openToolWindow: on };
    case "focusToolWindow":
      return { focusToolWindow: on };
    case "isTest":
      return on ? { isTest: true, emulateTerminal: false } : { isTest: false };
    case "emulateTerminal":
      return { emulateTerminal: on };
  }
}

export interface ConfigFormProps {
  config: RunConfig;
  /** Every configuration of the dialog (compound members, before launch targets, name checks). */
  all: readonly RunConfig[];
  type: RunConfigTypeContribution | undefined;
  errors: ConfigErrors;
  /** Editing a configuration template (no name, storage or compound members). */
  template?: boolean;
  onChange: (next: RunConfig) => void;
  /** Bumped by ⌥M to open the Modify options menu. */
  modifyRequest: number;
}

export function ConfigForm({ config, all, type, errors, template, onChange, modifyRequest }: ConfigFormProps) {
  const openByDefault = useWorkflowSettings((s) => s.run.showOnStart);
  const externalTools = useWorkflowSettings((s) => s.externalTools);
  const runTargets = useWorkflowSettings((s) => s.runTargets);
  const toolWindows = useContributions((s) => s.toolWindows);
  const tx = useTx();
  const txTemplate = useTxTemplate();
  const [shown, setShown] = useState<ReadonlySet<OptionId>>(() => new Set());
  const [argsText, setArgsText] = useState<string | null>(null);
  const [envText, setEnvText] = useState<string | null>(null);
  const [envFilesText, setEnvFilesText] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [lastRequest, setLastRequest] = useState(modifyRequest);
  const [taskMenu, setTaskMenu] = useState(false);
  const modifyRef = useRef<HTMLButtonElement>(null);
  const taskRef = useRef<HTMLButtonElement>(null);

  if (modifyRequest !== lastRequest) {
    setLastRequest(modifyRequest);
    setModifyOpen(true);
  }

  const compound = config.kind === COMPOUND;
  // Compound and debug-only types (Remote JVM Debug) start no process of their own.
  const noProcess = compound || !!type?.debugOnly;
  const params = compound ? {} : formParams(config, type);
  const update = (patch: Partial<RunConfig>) => onChange({ ...config, ...patch });
  const setParam = (key: string, value: string) => {
    const next = { ...(params ?? {}) };
    if (value) next[key] = value;
    else delete next[key];
    onChange(withParams(config, next, type));
  };
  const isShown = (id: OptionId) => shown.has(id) || optionSet(config, id, openByDefault);

  const toggleOption = (id: OptionId) => {
    const on = !isShown(id);
    if (VALUE_OPTIONS.has(id)) {
      setShown((s) => {
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
      if (!on) update(optionPatch(id, false));
      return;
    }
    update(optionPatch(id, on));
  };

  const terminal = terminalApplies(config, type);
  // A terminal has no separate input file: the two options exclude each other.
  const blocked = (id: OptionId) =>
    (id === "emulateTerminal" && isShown("stdinFile")) || (id === "stdinFile" && !!config.emulateTerminal);
  const menuItems: MenuItem[] = OPTION_GROUPS.filter((g) => !noProcess || !g.process).flatMap((g): MenuItem[] => [
    { kind: "header", label: g.label },
    ...g.options
      .filter(
        (id) =>
          (!compound || id === "beforeLaunch") && (id !== "emulateTerminal" || terminal || !!config.emulateTerminal),
      )
      .map((id): MenuItem => ({
        label: OPTION_LABELS[id],
        checked: isShown(id),
        disabled: !isShown(id) && blocked(id),
        run: () => toggleOption(id),
      })),
  ]);

  const tasks = config.beforeLaunch ?? [];
  const setTasks = (next: BeforeLaunchTask[]) => update({ beforeLaunch: next });
  const addTask = (kind: BeforeLaunchKind, target = "") => setTasks([...tasks, { kind, target }]);
  const runnable = all.filter((c) => c.id !== config.id && c.kind !== COMPOUND);
  const taskItems: MenuItem[] = [
    {
      label: TASK_LABELS.run,
      disabled: !runnable.length,
      submenu: runnable.map((c) => ({
        label: c.name,
        verbatim: true,
        icon: configIcon(c),
        run: () => addTask("run", c.id),
      })),
    },
    { label: TASK_LABELS.build, icon: "build-project", run: () => addTask("build") },
    {
      label: TASK_LABELS.tool,
      disabled: !externalTools.length,
      submenu: externalTools.map((t) => ({ label: t.name, verbatim: true, run: () => addTask("tool", t.id) })),
    },
    { label: TASK_LABELS.command, icon: "terminal", run: () => addTask("command") },
    {
      label: TASK_LABELS.toolWindow,
      submenu: [...toolWindows.values()]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((w) => ({ label: w.title, icon: w.icon, run: () => addTask("toolWindow", w.id) })),
    },
  ];
  const moveTask = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= tasks.length) return;
    const next = [...tasks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setTasks(next);
  };

  const adapterOptions: SelectOption[] = [
    { value: "", label: "None" },
    ...ADAPTERS.map((a) => ({ value: a.id, label: a.label })),
  ];
  if (config.debugAdapter && !ADAPTERS.some((a) => a.id === config.debugAdapter))
    adapterOptions.push({
      value: config.debugAdapter,
      label: txTemplate(`${config.debugAdapter} (no launch template)`),
    });

  const targetOptions: SelectOption[] = [
    { value: "", label: "Local machine" },
    ...runTargets.map((t) => ({ value: t.id, label: t.name.trim() || t.id })),
  ];
  if (config.target && !runTargets.some((t) => t.id === config.target))
    targetOptions.push({ value: config.target, label: txTemplate(`${config.target} (missing)`) });

  const chips = (
    [
      "allowParallel",
      "emulateTerminal",
      "showOnStdout",
      "showOnStderr",
      "openToolWindow",
      "focusToolWindow",
      "isTest",
    ] as const
  ).filter(
    (id) => (!noProcess || id === "openToolWindow" || id === "focusToolWindow") && optionSet(config, id, openByDefault),
  );

  return (
    <>
      {config.detected && !template && (
        <div className={styles.notice}>
          <T>Detected from the project. Changes are saved as a user configuration that overrides it.</T>
        </div>
      )}
      {!template && (
        <div className={styles.formHeader}>
          <Field label="Name" error={errors.name}>
            <Input
              value={config.name}
              invalid={!!errors.name}
              aria-label="Name"
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Checkbox
            checked={!config.local}
            onChange={(shared) => update({ local: !shared })}
            label="Store as project file"
            aria-label="Store as project file (.openidea/run.toml); otherwise in the workspace (.openidea/run.local.toml)"
          />
        </div>
      )}
      {!noProcess && (
        <Field
          label="Run on"
          hint={
            config.target
              ? "Debugging is not available on run targets."
              : runTargets.length
                ? undefined
                : "Add SSH hosts in Settings › Build, Execution, Deployment › Run Targets."
          }
        >
          <Select
            value={config.target ?? ""}
            options={targetOptions}
            onChange={(target) => onChange(withTarget(config, target))}
            aria-label="Run on"
          />
        </Field>
      )}
      <div className={styles.formSection}>
        <span className={styles.formSectionTitle}>{tx(type?.label ?? kindLabel(config.kind))}</span>
        <button
          ref={modifyRef}
          type="button"
          className={styles.noticeLink}
          aria-haspopup="menu"
          aria-expanded={modifyOpen}
          onClick={() => setModifyOpen((v) => !v)}
        >
          <T>Modify options</T> <Icon name="chevron-down" size={12} />
        </button>
        <span className={styles.chooserMuted}>⌥M</span>
        <Menu
          open={modifyOpen}
          anchor={modifyRef}
          items={menuItems}
          placement="bottom-end"
          onClose={() => setModifyOpen(false)}
        />
      </div>

      {compound ? (
        template ? null : (
          <CompoundMembers
            config={config}
            all={all}
            error={errors.compound}
            onChange={(compound) => update({ compound })}
          />
        )
      ) : params && type ? (
        type.fields
          .filter((f) => f.visible?.(params) ?? true)
          .map((f) => (
            <Field
              key={f.key}
              label={f.label}
              error={errors[f.key]}
              hint={f.hint}
              top={f.control === "textarea" || f.control === "output"}
            >
              <TypeField
                field={f}
                value={params[f.key] ?? ""}
                params={params}
                all={all}
                invalid={!!errors[f.key]}
                onChange={(v) => setParam(f.key, v)}
              />
            </Field>
          ))
      ) : (
        <>
          {type && (
            <div className={styles.notice}>
              <T>This command line doesn't fit the type's form; it is edited as a command.</T>
            </div>
          )}
          <Field label="Command" error={errors.command}>
            <Input
              mono
              value={config.command}
              invalid={!!errors.command}
              aria-label="Command"
              placeholder="e.g. ./gradlew or cargo"
              onChange={(e) => update({ command: e.target.value, params: {} })}
            />
          </Field>
          <Field label="Arguments">
            <Input
              mono
              aria-label="Arguments"
              value={argsText ?? formatArgs(config.args)}
              placeholder="Space separated; quote with ' or &quot;"
              onChange={(e) => {
                setArgsText(e.target.value);
                update({ args: parseArgs(e.target.value), params: {} });
              }}
            />
          </Field>
        </>
      )}

      {!noProcess && (
        <>
          {!type?.ownsWorkingDirectory && (
            <Field label="Working directory" error={errors.cwd}>
              <Input
                mono
                aria-label="Working directory"
                value={config.cwd ?? ""}
                placeholder="Project root"
                onChange={(e) => update({ cwd: e.target.value.trim() ? e.target.value : null })}
              />
            </Field>
          )}
          <Field
            label="Environment variables"
            error={errors.env}
            hint="Separate variables with semicolon: VAR=value; VAR1=value1"
          >
            <div className={styles.inputWithButton}>
              <Input
                mono
                aria-label="Environment variables"
                value={envText ?? formatEnv(config.env)}
                invalid={!!errors.env}
                onChange={(e) => {
                  setEnvText(e.target.value);
                  update({ env: Object.fromEntries(parseEnv(e.target.value).map((r) => [r.key, r.value])) });
                }}
                onBlur={() => setEnvText(null)}
              />
              <IconButton
                icon="list"
                size="small"
                iconSize={14}
                title="Edit Environment Variables"
                onClick={() => setEnvOpen(true)}
              />
            </div>
            {config.includeSystemEnv === false && (
              <span className={styles.chooserMuted}>
                <T>System environment variables are not passed</T>
              </span>
            )}
          </Field>
          {isShown("envFiles") && (
            <Field label='Paths to ".env" files' hint="Relative to the project root; separate with semicolon">
              <Input
                mono
                aria-label='Paths to ".env" files'
                value={envFilesText ?? (config.envFiles ?? []).join(";")}
                placeholder=".env"
                onChange={(e) => {
                  setEnvFilesText(e.target.value);
                  update({
                    envFiles: e.target.value
                      .split(";")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  });
                }}
                onBlur={() => setEnvFilesText(null)}
              />
            </Field>
          )}
          {isShown("stdinFile") && (
            <Field label="Redirect input from">
              <Input
                mono
                aria-label="Redirect input from"
                value={config.stdinFile ?? ""}
                placeholder="File relative to the project root"
                onChange={(e) => update({ stdinFile: e.target.value || null })}
              />
            </Field>
          )}
          {isShown("outputFile") && (
            <Field label="Save console output to file">
              <Input
                mono
                aria-label="Save console output to file"
                value={config.outputFile ?? ""}
                placeholder="File relative to the project root"
                onChange={(e) => update({ outputFile: e.target.value || null })}
              />
            </Field>
          )}
          <Field label="Debug adapter">
            <Select
              value={config.debugAdapter ?? ""}
              options={adapterOptions}
              onChange={(v) => update({ debugAdapter: v || null })}
              aria-label="Debug adapter"
            />
          </Field>
        </>
      )}

      {isShown("beforeLaunch") && (
        <Field label="Before launch" error={errors.beforeLaunch} top>
          <div className={styles.taskList} role="list" aria-label={tx("Before launch tasks")}>
            {tasks.map((t, i) => (
              <div key={i} role="listitem" className={styles.taskRow}>
                {t.kind === "command" ? (
                  <Input
                    mono
                    aria-label={txTemplate(`Before launch command ${i + 1}`)}
                    value={t.target ?? ""}
                    placeholder="Shell command, e.g. make generate"
                    onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}
                  />
                ) : (
                  <span className={styles.taskLabel}>{txTemplate(taskLabel(t, all))}</span>
                )}
                <IconButton
                  icon="arrow-up"
                  size="small"
                  iconSize={12}
                  title="Move Up"
                  disabled={i === 0}
                  onClick={() => moveTask(i, -1)}
                />
                <IconButton
                  icon="arrow-down"
                  size="small"
                  iconSize={12}
                  title="Move Down"
                  disabled={i === tasks.length - 1}
                  onClick={() => moveTask(i, 1)}
                />
                <IconButton
                  icon="minus"
                  size="small"
                  iconSize={12}
                  title="Remove Task"
                  onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
                />
              </div>
            ))}
            <Button
              ref={taskRef}
              size="small"
              variant="ghost"
              icon="plus"
              aria-haspopup="menu"
              onClick={() => setTaskMenu(true)}
            >
              <T>Add task</T>
            </Button>
            <Menu open={taskMenu} anchor={taskRef} items={taskItems} onClose={() => setTaskMenu(false)} />
          </div>
        </Field>
      )}

      {chips.length > 0 && (
        <div className={styles.chips}>
          {chips.map((id) => (
            <span key={id} className={styles.chip}>
              <T>{OPTION_LABELS[id]}</T>
              <IconButton
                icon="close"
                size="small"
                iconSize={10}
                title={tx`Remove '${OPTION_LABELS[id]}'`}
                onClick={() => update(optionPatch(id, false))}
              />
            </span>
          ))}
        </div>
      )}

      {!noProcess && !template && (
        <div className={styles.editPreview}>
          <span className={styles.chooserMuted}>
            <T>Command line</T>
          </span>
          <code>{commandLine(config) || "—"}</code>
        </div>
      )}

      {envOpen && (
        <EnvDialog
          env={config.env}
          includeSystemEnv={config.includeSystemEnv !== false}
          onClose={() => setEnvOpen(false)}
          onOk={(env, includeSystemEnv) => {
            setEnvText(null);
            update({ env, includeSystemEnv });
          }}
        />
      )}
    </>
  );
}

function TypeField({
  field,
  value,
  params,
  all,
  invalid,
  onChange,
}: {
  field: RunConfigTypeContribution["fields"][number];
  value: string;
  params: Readonly<Record<string, string>>;
  all: readonly RunConfig[];
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const tx = useTx();
  const listId = `run-field-${field.key}`;
  if (field.control === "output") return <OutputField label={field.label} text={field.value?.(params) ?? ""} />;
  if (field.control === "select") {
    const options = [...(field.options ?? [])];
    if (value && !options.some((o) => o.value === value)) options.push({ value, label: value });
    return (
      <Select
        value={value || (options[0]?.value ?? "")}
        options={options}
        onChange={onChange}
        aria-label={field.label}
      />
    );
  }
  if (field.control === "checkbox")
    return <Checkbox checked={value === "true"} onChange={(on) => onChange(on ? "true" : "")} label={field.label} />;
  if (field.control === "textarea")
    return (
      <textarea
        className={clsx(styles.textarea, invalid && styles.textareaInvalid)}
        aria-label={tx(field.label)}
        spellCheck={false}
        value={value}
        placeholder={tx(field.placeholder)}
        rows={field.rows ?? 4}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  const suggestions = field.suggestions?.(all, params) ?? [];
  return (
    <>
      <Input
        mono={field.mono}
        aria-label={field.label}
        value={value}
        invalid={invalid}
        placeholder={field.placeholder}
        list={suggestions.length ? listId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}

/** Read-only text the form computes (e.g. the JDWP agent for the remote JVM), with Copy. */
function OutputField({ label, text }: { label: string; text: string }) {
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className={styles.inputWithButton}>
      <textarea
        className={styles.textarea}
        aria-label={tx(label)}
        readOnly
        spellCheck={false}
        value={text}
        rows={Math.min(4, Math.max(1, Math.ceil(text.length / 72)))}
        onFocus={(e) => e.currentTarget.select()}
      />
      <IconButton
        icon={copied ? "check" : "copy"}
        size="small"
        iconSize={14}
        title={copied ? "Copied" : "Copy"}
        onClick={copy}
        onBlur={() => setCopied(false)}
      />
    </div>
  );
}

function CompoundMembers({
  config,
  all,
  error,
  onChange,
}: {
  config: RunConfig;
  all: readonly RunConfig[];
  error?: string;
  onChange: (ids: string[]) => void;
}) {
  const tx = useTx();
  const members = config.compound ?? [];
  const candidates = all.filter(
    (c) =>
      c.id !== config.id && !members.includes(c.id) && !compoundCycle({ ...config, compound: [...members, c.id] }, all),
  );
  return (
    <Field label="Configurations" error={error} top>
      <div className={styles.taskList} role="list" aria-label={tx("Configurations of the compound")}>
        {members.map((id) => {
          const c = all.find((x) => x.id === id);
          return (
            <div key={id} role="listitem" className={styles.taskRow}>
              <Icon name={c ? configIcon(c) : "warning"} size={13} className={styles.chooserIcon} />
              <span className={styles.taskLabel}>{c?.name ?? id}</span>
              <IconButton
                icon="minus"
                size="small"
                iconSize={12}
                title="Remove"
                onClick={() => onChange(members.filter((m) => m !== id))}
              />
            </div>
          );
        })}
        <Select
          value={null}
          placeholder="Add configuration…"
          options={candidates.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(id) => onChange([...members, id])}
          disabled={!candidates.length}
          aria-label="Add configuration"
        />
      </div>
    </Field>
  );
}

export function Field({
  label,
  error,
  hint,
  top,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  top?: boolean;
  children: ReactNode;
}) {
  const txTemplate = useTxTemplate();
  return (
    <div className={clsx(styles.field, top && styles.fieldTop)}>
      <span className={styles.fieldLabel}>{txTemplate(label)}</span>
      <div className={styles.fieldControl}>
        {children}
        {error ? (
          <span className={styles.fieldError} role="alert">
            {txTemplate(error)}
          </span>
        ) : (
          hint && <span className={styles.chooserMuted}>{txTemplate(hint)}</span>
        )}
      </div>
    </div>
  );
}
