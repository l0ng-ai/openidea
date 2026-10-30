/**
 * Settings › Language Servers, right-hand side: the selected tool's executable
 * and, for a language server, its startup options and workspace configuration
 * (`languageServers.<name>`), plus the New Language Server dialog. Edits are
 * staged in the Settings dialog and written on Apply / OK.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { ToolInfo } from "@/bindings";
import { Checkbox, Dialog, Icon, IconButton, Input, Popup, SearchField, Select, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { useSettingsForm } from "@/workbench/contributions";
import { toolsBackend, type LanguageChoice } from "./backend";
import {
  formatArgs,
  formatEnv,
  formatJson,
  formatList,
  nameFromCommand,
  parseArgs,
  parseEnv,
  parseJsonObject,
  parseList,
  SERVER_NAME,
  serverKey,
  toolPathKey,
  type ServerEntry,
  type ServerField,
} from "./serverConfig";
import { STATUS_LABEL, useTools } from "./store";
import styles from "./ServerSettings.module.css";

let languageList: Promise<LanguageChoice[]> | null = null;

/** Languages a server can be used for, loaded once. */
export function useLanguageChoices(): LanguageChoice[] {
  const [langs, setLangs] = useState<LanguageChoice[]>([]);
  useEffect(() => {
    let live = true;
    languageList ??= toolsBackend()
      .languages()
      .catch(() => {
        languageList = null;
        return [];
      });
    void languageList.then((l) => live && setLangs(l));
    return () => {
      live = false;
    };
  }, []);
  return langs;
}

/** Test hook: forget the loaded language list. */
export function resetLanguageChoices() {
  languageList = null;
}

export function languageNames(ids: readonly string[], known: readonly LanguageChoice[]): string[] {
  return ids.map((id) => known.find((l) => l.id === id)?.name ?? id);
}

// ---------------------------------------------------------------------------
// Form building blocks (IDEA layout: "Label: [control]", titled separators)

/** A titled separator; `collapsible` ones fold away like IDEA's hideable separators. */
function Section({
  title,
  note,
  collapsible,
  defaultOpen = true,
  children,
}: {
  title: string;
  note?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = !collapsible || open;
  return (
    <section className={styles.section} aria-label={tx(title)}>
      {collapsible ? (
        <button
          type="button"
          className={clsx(styles.sectionTitle, styles.sectionToggle)}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
          <T>{title}</T>
          <span className={styles.sectionRule} aria-hidden />
        </button>
      ) : (
        <div className={styles.sectionTitle}>
          <T>{title}</T>
          <span className={styles.sectionRule} aria-hidden />
        </div>
      )}
      {shown && (
        <div className={styles.sectionBody}>
          {note && (
            <div className={styles.note}>
              <T>{note}</T>
            </div>
          )}
          {children}
        </div>
      )}
    </section>
  );
}

/** "Label:" above its control (beside it in dialogs), the hint below. */
function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <label className={styles.label} htmlFor={htmlFor}>
        <T>{label}</T>
      </label>
      <div className={styles.control}>{children}</div>
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}

interface FieldProps<V> {
  label: string;
  value: V | undefined;
  format: (v: V | undefined) => string;
  /** Text → value (null removes the setting); throws with a message when invalid. */
  parse: (text: string) => V | null;
  onChange: (value: V | null) => void;
  placeholder?: string;
  hint?: ReactNode;
  multiline?: boolean;
  trailing?: ReactNode;
}

/**
 * A text field over a setting: valid text is staged as it is typed; invalid
 * text stays in the field, marked, and isn't staged.
 */
function Field<V>({ label, value, format, parse, onChange, placeholder, hint, multiline, trailing }: FieldProps<V>) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? format(value);
  const change = (next: string) => {
    setDraft(next);
    try {
      onChange(parse(next));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const common = {
    id,
    value: text,
    placeholder,
    "aria-invalid": error ? true : undefined,
    // Valid text is reformatted from the staged value once the field is left.
    onBlur: () => !error && setDraft(null),
  };
  return (
    <Row
      label={label}
      htmlFor={id}
      hint={
        error ? (
          <span className={styles.error} role="alert">
            {error}
          </span>
        ) : (
          hint
        )
      }
    >
      {multiline ? (
        <textarea
          {...common}
          spellCheck={false}
          rows={Math.min(14, Math.max(3, text.split("\n").length + 1, (placeholder ?? "").split("\n").length))}
          className={clsx(styles.area, error && styles.invalid)}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <Input {...common} mono invalid={!!error} className={styles.grow} onChange={(e) => change(e.target.value)} />
      )}
      {trailing}
    </Row>
  );
}

/** "Python, TypeScript ▾": checkboxes in a popup, with a filter. */
export function LanguagePicker({
  id,
  value,
  onChange,
  invalid,
}: {
  id?: string;
  value: readonly string[];
  onChange: (ids: string[]) => void;
  invalid?: boolean;
}) {
  const known = useLanguageChoices();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? known.filter((l) => l.name.toLowerCase().includes(q) || l.id.includes(q)) : known;
  }, [known, query]);
  const label = languageNames(value, known).join(", ");
  return (
    <>
      <button
        id={id}
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        className={clsx(styles.picker, invalid && styles.invalid)}
        onClick={() => setOpen(!open)}
      >
        <span className={clsx(styles.pickerText, !label && styles.placeholder)}>
          {label || tx("Choose languages…")}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>
      <Popup
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-start"
        role="dialog"
        aria-label={tx("Languages")}
        className={styles.pickerPopup}
      >
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Filter languages"
          aria-label="Filter languages"
          data-autofocus
        />
        <div className={styles.pickerList}>
          {shown.map((l) => (
            <Checkbox
              key={l.id}
              checked={value.includes(l.id)}
              label={l.name}
              onChange={(on) => onChange(on ? [...value, l.id] : value.filter((v) => v !== l.id))}
            />
          ))}
          {shown.length === 0 && (
            <div className={styles.note}>
              <T>No languages match.</T>
            </div>
          )}
        </div>
      </Popup>
    </>
  );
}

// ---------------------------------------------------------------------------
// The tool's settings

function useServerEntry(name: string): ServerEntry {
  const form = useSettingsForm();
  return (form.useValue(serverKey(name)) ?? {}) as ServerEntry;
}

/** Where the executable was found, or what is wrong with it. */
function executableHint(tool: ToolInfo, pending: boolean): ReactNode {
  if (pending) return <T>Checked when the settings are applied.</T>;
  if (tool.customError) return <span className={styles.error}>{tool.customError}</span>;
  if (tool.path) {
    return (
      <>
        <T>Using</T> <code className={styles.code}>{tool.path}</code>
        {tool.version && <> ({tool.version})</>}
      </>
    );
  }
  return tool.installHint ?? <T>Not found on PATH.</T>;
}

function ExecutableRow({ tool, pending }: { tool: ToolInfo; pending: boolean }) {
  const form = useSettingsForm();
  const entry = useServerEntry(tool.name);
  const custom = (entry.languages?.length ?? 0) > 0;
  // A server defined in settings names its executable itself; others may point elsewhere.
  const key = custom ? serverKey(tool.name, "command") : toolPathKey(tool.command);
  const tools = form.useValue("tools") as Record<string, { path: string }> | undefined;
  const value = custom ? entry.command : tools?.[tool.command]?.path;
  const set = (path: string | null) => {
    if (custom || !tool.command.includes(".")) form.set(key, path);
    else {
      // A command with dots can't be a key segment: replace the map.
      const next = { ...tools };
      if (path) next[tool.command] = { path };
      else delete next[tool.command];
      form.set("tools", next);
    }
  };
  return (
    <Field<string>
      key={key}
      label={custom ? "Command" : "Path"}
      value={value}
      format={(v) => v ?? ""}
      parse={(t) => t.trim() || null}
      onChange={set}
      placeholder={custom ? tx("Executable name or path") : tx("Auto-detect")}
      hint={executableHint(tool, pending)}
      trailing={
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          onClick={async () => {
            const picked = await toolsBackend().chooseExecutable(tx`Select ${tool.command || tool.name}`, value);
            if (picked) set(picked);
          }}
        />
      }
    />
  );
}

/** Debug adapters: only where the executable is. */
export function ToolSettings({ tool }: { tool: ToolInfo }) {
  return (
    <Section title="Executable">
      <ExecutableRow tool={tool} pending={false} />
    </Section>
  );
}

/**
 * Interchangeable servers (a server and its `fallback`s): one picker for the
 * group instead of an on/off box per server. Automatic keeps them all on, so
 * the first one available runs.
 */
function AlternativesRow({ tool }: { tool: ToolInfo }) {
  const form = useSettingsForm();
  const tools = useTools((s) => s.tools);
  const servers = (form.useValue("languageServers") ?? {}) as Record<string, ServerEntry>;
  const names = tool.alternatives;
  const members = names.map((name) => tools.find((t) => t.name === name));
  const common = members.reduce<string[]>(
    (acc, t) => (t ? acc.filter((l) => t.languages.includes(l)) : acc),
    tool.languages,
  );
  const languages = common.join(", ");
  // "ty (Python)" is just "ty" next to "Language server for Python".
  const short = names.map((name, i) => {
    const display = members[i]?.displayName ?? name;
    const suffix = /^(.*) \((.+)\)$/.exec(display);
    return suffix && common.includes(suffix[2]!) ? suffix[1]! : display;
  });
  const enabled = names.filter((name) => servers[name]?.enabled !== false);
  const value =
    enabled.length === names.length
      ? "auto"
      : enabled.length === 0
        ? "none"
        : enabled.length === 1
          ? enabled[0]!
          : null;
  const options = [
    { value: "auto", label: tx("Automatic") },
    ...names.map((name, i) => {
      const t = members[i];
      return { value: name, label: short[i]!, detail: t ? tx(STATUS_LABEL[t.status]) : undefined };
    }),
    { value: "none", label: tx("None") },
  ];
  const order = short.join(" → ");
  const label = languages ? tx`Language server for ${languages}` : tx("Language server");
  return (
    <Row label={label} hint={tx`Only one of these runs at a time. Automatic uses the first one available: ${order}.`}>
      <Select
        aria-label={label}
        value={value}
        placeholder={tx("Custom combination")}
        options={options}
        onChange={(choice) => {
          for (const name of names) {
            const on = choice === "auto" || choice === name;
            // Same as the on/off box: on is the default, so only a project spells it out.
            form.set(serverKey(name, "enabled"), on ? (form.scope === "project" ? true : null) : false);
          }
        }}
      />
    </Row>
  );
}

/** A language server: on/off, executable, startup options, workspace configuration. */
export function ServerSettings({ tool, pending }: { tool: ToolInfo; pending: boolean }) {
  const form = useSettingsForm();
  const entry = useServerEntry(tool.name);
  const custom = (entry.languages?.length ?? 0) > 0;
  const set = (field: ServerField) => (value: unknown) => form.set(serverKey(tool.name, field), value);
  const known = useLanguageChoices();
  const languagesId = useId();
  const languages = custom ? languageNames(entry.languages ?? [], known) : tool.languages;
  const defaultOptions = useMemo(() => {
    try {
      return tool.defaultInitializationOptions ? JSON.parse(tool.defaultInitializationOptions) : null;
    } catch {
      return null;
    }
  }, [tool.defaultInitializationOptions]);
  const overridden = !custom && Object.keys(entry).length > 0;

  return (
    <div className={styles.form}>
      {tool.alternatives.length > 1 ? (
        <AlternativesRow tool={tool} />
      ) : (
        <Checkbox
          checked={entry.enabled !== false}
          label={
            languages.length
              ? tx`Use ${tool.displayName} for ${languages.join(", ")} files`
              : tx`Use ${tool.displayName}`
          }
          // Enabled is the default; a project says so explicitly to win over a global "off".
          onChange={(on) => set("enabled")(on ? (form.scope === "project" ? true : null) : false)}
        />
      )}

      <Section title="Executable">
        <ExecutableRow tool={tool} pending={pending} />
        {custom && (
          <>
            <Row label="Languages" htmlFor={languagesId}>
              <LanguagePicker
                id={languagesId}
                value={entry.languages ?? []}
                invalid={!entry.languages?.length}
                onChange={(ids) => set("languages")(ids.length ? ids : null)}
              />
            </Row>
            <Field<string[]>
              label="Root markers"
              value={entry.rootMarkers}
              format={formatList}
              parse={parseList}
              onChange={set("rootMarkers")}
              placeholder="pyproject.toml, .git"
              hint={<T>Files marking the workspace root.</T>}
            />
          </>
        )}
      </Section>

      <Section
        title="Startup"
        note="Changing these restarts the server."
        collapsible
        defaultOpen={!!(entry.args || entry.env || entry.initializationOptions)}
      >
        <Field<string[]>
          label="Arguments"
          value={entry.args ?? undefined}
          format={formatArgs}
          parse={parseArgs}
          onChange={set("args")}
          placeholder={formatArgs(tool.defaultArgs) || tx("None")}
        />
        <Field<Record<string, string>>
          label="Environment variables"
          value={entry.env}
          format={formatEnv}
          parse={parseEnv}
          onChange={set("env")}
          placeholder="NAME=value; OTHER=value"
        />
        <Field<Record<string, unknown>>
          label="Initialization options"
          multiline
          value={entry.initializationOptions as Record<string, unknown> | undefined}
          format={formatJson}
          parse={parseJsonObject}
          onChange={set("initializationOptions")}
          placeholder={defaultOptions ? formatJson(defaultOptions) : '{ "key": "value" }'}
          hint={defaultOptions ? <T>Merged over the defaults shown when empty.</T> : undefined}
        />
      </Section>

      <Section
        title="Workspace Configuration"
        note="Sent to the running server; no restart needed."
        collapsible
        defaultOpen={!!entry.settings}
      >
        <Field<Record<string, unknown>>
          label="Settings"
          multiline
          value={entry.settings as Record<string, unknown> | undefined}
          format={formatJson}
          parse={parseJsonObject}
          onChange={set("settings")}
          placeholder={'{ "section": { "key": "value" } }'}
        />
      </Section>

      {overridden && (
        <div>
          <button type="button" className={styles.link} onClick={() => form.set(serverKey(tool.name), null)}>
            <T>Restore Defaults</T>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New Language Server

/** Asks for a name, command and languages; stages the new server on OK. */
export function NewServerDialog({
  existing,
  onClose,
  onAdded,
}: {
  existing: readonly string[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const form = useSettingsForm();
  const ids = { name: useId(), command: useId(), languages: useId() };
  const [commandLine, setCommandLine] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  // "ruff server": the executable, then its arguments.
  let words: string[] = [];
  let quoteError: string | null = null;
  try {
    words = parseArgs(commandLine) ?? [];
  } catch (e) {
    quoteError = e instanceof Error ? e.message : String(e);
  }
  const [command = "", ...args] = words;
  const effectiveName = (name ?? nameFromCommand(command)).trim();
  const problem =
    quoteError ??
    (!command
      ? tx("Enter the command that starts the server.")
      : !SERVER_NAME.test(effectiveName)
        ? tx("Name: letters, digits, - _ + only.")
        : existing.includes(effectiveName)
          ? tx`${effectiveName} already exists.`
          : !languages.length
            ? tx("Choose the languages it serves.")
            : null);
  const add = () => {
    if (problem) return;
    const entry: ServerEntry = { command, languages };
    if (args.length) entry.args = args;
    form.set(serverKey(effectiveName), entry);
    onAdded(effectiveName);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={tx("New Language Server")}
      width={480}
      buttons={[
        { label: "OK", role: "default", disabled: !!problem, title: problem ?? undefined, onClick: add },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>
        <Row label="Command" htmlFor={ids.command}>
          <Input
            id={ids.command}
            mono
            autoFocus
            className={styles.grow}
            value={commandLine}
            placeholder="ruff server"
            onChange={(e) => setCommandLine(e.target.value)}
          />
          <IconButton
            icon="folder-open"
            size="small"
            title="Browse…"
            onClick={async () => {
              const picked = await toolsBackend().chooseExecutable(tx("Select the server executable"), command);
              if (picked) setCommandLine(formatArgs([picked, ...args]));
            }}
          />
        </Row>
        <Row label="Name" htmlFor={ids.name}>
          <Input
            id={ids.name}
            mono
            className={styles.grow}
            value={name ?? nameFromCommand(command)}
            onChange={(e) => setName(e.target.value)}
          />
        </Row>
        <Row label="Languages" htmlFor={ids.languages}>
          <LanguagePicker id={ids.languages} value={languages} onChange={setLanguages} />
        </Row>
        <div className={styles.note}>
          {problem ?? <T>Any language server that talks LSP over stdio, with its arguments.</T>}
        </div>
      </div>
    </Dialog>
  );
}
