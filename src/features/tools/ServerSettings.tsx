/**
 * Settings › Language Servers: a server's `languageServers.<name>` settings in
 * the global or this project's layer (arguments, environment, initialization
 * options, workspace settings, on/off), and the form adding a server of one's own.
 * Every field saves when committed; running servers pick the change up.
 */
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { SettingsScope, ToolInfo } from "@/bindings";
import { Button, IconButton, Input, T, Toggle } from "@/ui";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { toolsBackend, type LanguageChoice } from "./backend";
import {
  formatArgs,
  formatEnv,
  formatJson,
  formatList,
  parseArgs,
  parseEnv,
  parseJsonObject,
  parseList,
  SERVER_NAME,
  type ServerEntry,
  type ServerField,
} from "./serverConfig";
import { saveServerSetting } from "./store";
import styles from "./ServerSettings.module.css";

function ScopeSwitch({ scope, onChange }: { scope: SettingsScope; onChange: (s: SettingsScope) => void }) {
  const hasProject = useProject((s) => s.project !== null);
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="Settings scope">
      {(["global", "project"] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={scope === s}
          disabled={s === "project" && !hasProject}
          title={s === "project" && !hasProject ? "Open a project to configure it there" : undefined}
          className={clsx(styles.segment, scope === s && styles.segmentOn)}
          onClick={() => onChange(s)}
        >
          {s === "global" ? "Global" : "This project"}
        </button>
      ))}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  hint?: ReactNode;
  /** The saved text. */
  value: string;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  /** Text → value to save (null removes the setting); throws with a message when invalid. */
  parse: (text: string) => unknown;
  onCommit: (value: unknown) => Promise<unknown>;
  trailing?: ReactNode;
}

/** A field saved on Enter / blur (⌘↵ / Ctrl+↵ in a multi-line one); Escape reverts. */
function TextField({
  label,
  hint,
  value,
  placeholder,
  multiline,
  mono = true,
  parse,
  onCommit,
  trailing,
}: TextFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? value;
  const commit = async (next: string) => {
    if (next === value) {
      setDraft(null);
      setError(null);
      return;
    }
    let parsed: unknown;
    try {
      parsed = parse(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setError(null);
    await onCommit(parsed);
    setDraft(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit(e.currentTarget.value);
    }
    if (e.key === "Escape" && draft !== null) {
      e.stopPropagation();
      setDraft(null);
      setError(null);
    }
  };
  const common = {
    id,
    value: text,
    placeholder,
    "aria-invalid": error ? true : undefined,
    onBlur: () => draft !== null && void commit(draft),
    onKeyDown,
  };
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        <T>{label}</T>
      </label>
      <div className={styles.fieldValue}>
        <span className={styles.inputRow}>
          {multiline ? (
            <textarea
              {...common}
              spellCheck={false}
              rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
              className={clsx(styles.area, error && styles.invalid)}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <Input
              {...common}
              mono={mono}
              invalid={!!error}
              className={styles.input}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          {trailing}
        </span>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : (
          hint && <div className={styles.hint}>{hint}</div>
        )}
      </div>
    </div>
  );
}

function unknownLanguages(ids: readonly string[] | null, known: readonly LanguageChoice[]): string[] {
  return known.length ? (ids ?? []).filter((id) => !known.some((l) => l.id === id)) : [];
}

function useLanguageChoices(): LanguageChoice[] {
  const [langs, setLangs] = useState<LanguageChoice[]>([]);
  useEffect(() => {
    let live = true;
    toolsBackend()
      .languages()
      .then((l) => live && setLangs(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return langs;
}

const parseLanguages = (known: readonly LanguageChoice[]) => (text: string) => {
  const ids = parseList(text);
  const unknown = unknownLanguages(ids, known);
  if (unknown.length) throw new Error(tx`Unknown language: ${unknown.join(", ")}`);
  return ids;
};

/** The settings of language server `tool` (shown under its details). */
export function ServerSettings({ tool }: { tool: ToolInfo }) {
  const [scope, setScope] = useState<SettingsScope>("global");
  const [loaded, setLoaded] = useState<{ scope: SettingsScope; entry: ServerEntry | null } | null>(null);
  // undefined while loading; null when the layer sets nothing.
  const entry = loaded?.scope === scope ? loaded.entry : undefined;
  const effective = useProject((s) => s.settings?.languageServers?.[tool.name]);
  const languages = useLanguageChoices();
  const custom = (effective?.languages?.length ?? 0) > 0;

  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    toolsBackend()
      .serverEntry(scope, tool.name)
      .catch(() => null)
      .then((entry) => live && setLoaded({ scope, entry }));
    return () => {
      live = false;
    };
  }, [scope, tool.name, version]);

  const save = async (field: ServerField | null, value: unknown) => {
    if (await saveServerSetting(scope, tool.name, field, value)) setVersion((v) => v + 1);
  };
  // Placeholders show what applies when this layer doesn't set the field.
  const inherited = (text: string, fallback: string) => (text ? text : fallback);
  const enabled = entry?.enabled ?? effective?.enabled ?? true;
  const fields = entry ?? {};

  return (
    <section className={styles.section} aria-label={tx`${tool.displayName} settings`}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>
          <T>Configuration</T>
        </span>
        <ScopeSwitch scope={scope} onChange={setScope} />
      </div>
      {entry === undefined ? (
        <div className={styles.hint}>
          <T>Loading…</T>
        </div>
      ) : (
        <div className={styles.fields} key={scope}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              <T>Enabled</T>
            </span>
            <div className={styles.fieldValue}>
              <Toggle
                checked={enabled}
                aria-label={tx`Use ${tool.displayName}`}
                // On is the default: the global layer only records "off".
                onChange={(on) => void save("enabled", on && scope === "global" ? null : on)}
              />
              <div className={styles.hint}>
                <T>When off, the server isn&apos;t started for any of its languages.</T>
              </div>
            </div>
          </div>
          {custom && (
            <>
              <TextField
                key={`command:${fields.command ?? ""}`}
                label="Command"
                value={fields.command ?? ""}
                placeholder={inherited(effective?.command ?? "", "Executable name or path")}
                parse={(t) => t.trim() || null}
                onCommit={(v) => save("command", v)}
                trailing={
                  <IconButton
                    icon="folder-open"
                    size="small"
                    title="Browse…"
                    onClick={async () => {
                      const picked = await toolsBackend().chooseExecutable(tx`Select ${tool.name}`, fields.command);
                      if (picked) await save("command", picked);
                    }}
                  />
                }
              />
              <TextField
                key={`languages:${formatList(fields.languages)}`}
                label="Languages"
                value={formatList(fields.languages)}
                placeholder={inherited(formatList(effective?.languages), "python, typescript")}
                hint="Language ids, comma-separated."
                parse={parseLanguages(languages)}
                onCommit={(v) => save("languages", v)}
              />
              <TextField
                key={`roots:${formatList(fields.rootMarkers)}`}
                label="Root markers"
                value={formatList(fields.rootMarkers)}
                placeholder={inherited(formatList(effective?.rootMarkers), "pyproject.toml, .git")}
                hint="Files marking the workspace root; the project folder otherwise."
                parse={parseList}
                onCommit={(v) => save("rootMarkers", v)}
              />
            </>
          )}
          <TextField
            key={`args:${formatArgs(fields.args)}`}
            label="Arguments"
            value={formatArgs(fields.args)}
            placeholder={inherited(formatArgs(effective?.args), "The language definition's")}
            hint="Replace the default arguments; quote ones with spaces."
            parse={parseArgs}
            onCommit={(v) => save("args", v)}
          />
          <TextField
            key={`env:${formatEnv(fields.env)}`}
            label="Environment"
            multiline
            value={formatEnv(fields.env)}
            placeholder={inherited(formatEnv(effective?.env), "NAME=value")}
            hint="One NAME=value per line, added to the server's environment."
            parse={parseEnv}
            onCommit={(v) => save("env", v)}
          />
          <TextField
            key={`init:${formatJson(fields.initializationOptions)}`}
            label="Initialization options"
            multiline
            value={formatJson(fields.initializationOptions)}
            placeholder={inherited(
              formatJson(effective?.initializationOptions),
              '{ "check": { "command": "clippy" } }',
            )}
            hint="JSON merged over the defaults and sent at startup; changing it restarts the server."
            parse={parseJsonObject}
            onCommit={(v) => save("initializationOptions", v)}
          />
          <TextField
            key={`settings:${formatJson(fields.settings)}`}
            label="Workspace settings"
            multiline
            value={formatJson(fields.settings)}
            placeholder={inherited(
              formatJson(effective?.settings),
              '{ "python": { "analysis": { "typeCheckingMode": "strict" } } }',
            )}
            hint="JSON answering workspace/configuration; sent to the running server without a restart."
            parse={parseJsonObject}
            onCommit={(v) => save("settings", v)}
          />
          {entry && (
            <div className={styles.footer}>
              <Button size="small" variant="ghost" onClick={() => void save(null, null)}>
                {custom && scope === "global"
                  ? "Remove server"
                  : scope === "project"
                    ? "Clear project settings"
                    : "Reset to defaults"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Adds a language server of one's own (`languageServers.<name>` with `languages`). */
export function AddServerForm({
  existing,
  onAdded,
  onCancel,
}: {
  existing: readonly string[];
  onAdded: (name: string) => void;
  onCancel: () => void;
}) {
  const ids = { name: useId(), command: useId(), languages: useId(), args: useId(), roots: useId() };
  const [scope, setScope] = useState<SettingsScope>("global");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [langText, setLangText] = useState("");
  const [argsText, setArgsText] = useState("");
  const [rootsText, setRootsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const languages = useLanguageChoices();

  const submit = async () => {
    const trimmed = name.trim();
    let entry: ServerEntry;
    try {
      if (!SERVER_NAME.test(trimmed)) throw new Error("Name: letters, digits, - _ + only");
      if (existing.includes(trimmed)) throw new Error(tx`${trimmed} already exists; configure it in its page instead`);
      if (!command.trim()) throw new Error("Command is required");
      const langs = parseLanguages(languages)(langText);
      if (!langs) throw new Error("Pick at least one language");
      entry = { command: command.trim(), languages: langs };
      const args = parseArgs(argsText);
      if (args) entry.args = args;
      const roots = parseList(rootsText);
      if (roots) entry.rootMarkers = roots;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setError(null);
    setSaving(true);
    const ok = await saveServerSetting(scope, trimmed, null, entry);
    setSaving(false);
    if (ok) onAdded(trimmed);
  };

  const row = (id: string, label: string, input: ReactNode, hint?: string) => (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        <T>{label}</T>
      </label>
      <div className={styles.fieldValue}>
        {input}
        {hint && (
          <div className={styles.hint}>
            <T>{hint}</T>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <form
      className={styles.addForm}
      aria-label="Add language server"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={styles.sectionHeader}>
        <span className={styles.title}>
          <T>Add Language Server</T>
        </span>
        <ScopeSwitch scope={scope} onChange={setScope} />
      </div>
      <p className={styles.intro}>
        <T>
          Any server speaking LSP over stdio. It starts for files of the chosen languages, next to their own servers.
        </T>
      </p>
      <div className={styles.fields}>
        {row(
          ids.name,
          "Name",
          <Input id={ids.name} mono value={name} placeholder="ruff" onChange={(e) => setName(e.target.value)} />,
        )}
        {row(
          ids.command,
          "Command",
          <span className={styles.inputRow}>
            <Input
              id={ids.command}
              mono
              className={styles.input}
              value={command}
              placeholder="ruff"
              onChange={(e) => setCommand(e.target.value)}
            />
            <IconButton
              icon="folder-open"
              size="small"
              title="Browse…"
              onClick={async () => {
                const picked = await toolsBackend().chooseExecutable(
                  "Select the server executable",
                  command || undefined,
                );
                if (picked) setCommand(picked);
              }}
            />
          </span>,
          "Executable name on PATH, or its path.",
        )}
        {row(
          ids.args,
          "Arguments",
          <Input
            id={ids.args}
            mono
            value={argsText}
            placeholder="server"
            onChange={(e) => setArgsText(e.target.value)}
          />,
        )}
        {row(
          ids.languages,
          "Languages",
          <Input
            id={ids.languages}
            mono
            list={`${ids.languages}-list`}
            value={langText}
            placeholder="python"
            onChange={(e) => setLangText(e.target.value)}
          />,
          "Language ids, comma-separated.",
        )}
        <datalist id={`${ids.languages}-list`}>
          {languages.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </datalist>
        {row(
          ids.roots,
          "Root markers",
          <Input
            id={ids.roots}
            mono
            value={rootsText}
            placeholder="pyproject.toml"
            onChange={(e) => setRootsText(e.target.value)}
          />,
          "Optional: files marking the workspace root.",
        )}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.footer}>
        <Button type="submit" size="small" variant="primary" disabled={saving}>
          <T>Add</T>
        </Button>
        <Button size="small" variant="ghost" onClick={onCancel}>
          <T>Cancel</T>
        </Button>
      </div>
    </form>
  );
}
