/** IDE-rendered plugin settings; every control edits the dialog's staged form. */
import { useMemo, useRef, useState } from "react";
import { tx } from "@/platform/i18n";
import { Button, Checkbox, IconButton, Input, Select, T } from "@/ui";
import { registerSettingsPage, useSettingsForm } from "@/workbench/contributions";
import { pluginsBackend } from "./backend";
import { localizeContributions, usePluginCatalogs } from "./pluginText";
import { itemsOf } from "./projection";
import { SecretsDetails, type SecretDecl } from "./secrets";
import { usePlugins } from "./store";
import styles from "./PluginSettings.module.css";

export interface SettingSchema {
  key: string;
  type: "boolean" | "string" | "number" | "integer" | "array" | "object";
  title: string;
  description?: string | null;
  default: unknown;
  options?: string[] | null;
  multiline?: boolean;
  group?: string | null;
  items?: SettingSchema | null;
  properties?: SettingSchema[];
}
interface SettingsAction {
  title: string;
  command: string;
}
interface SettingsPage {
  id: string;
  title: string;
  properties: SettingSchema[];
  actions?: SettingsAction[];
}
export interface SettingsDecl {
  title: string;
  properties: SettingSchema[];
  pages?: SettingsPage[];
}
type PluginSettings = Record<string, Record<string, unknown>>;

/** `null` removes an override, restoring its default. */
export function withPluginSetting(
  settings: PluginSettings | undefined,
  pluginId: string,
  key: string,
  value: unknown,
): PluginSettings {
  const own = { ...(settings?.[pluginId] ?? {}) };
  if (value === null) delete own[key];
  else own[key] = value;
  const next = { ...(settings ?? {}) };
  if (Object.keys(own).length) next[pluginId] = own;
  else delete next[pluginId];
  return next;
}

export const pluginSettingsPageId = (pluginId: string) => `plugins.${pluginId.replace(/\./g, "-")}`;

function ValueControl({
  s,
  value,
  set,
  label = s.title,
  cell = false,
}: {
  s: SettingSchema;
  value: unknown;
  set(value: unknown): void;
  label?: string;
  cell?: boolean;
}) {
  if (s.type === "array") return <ArrayControl s={s} value={value as unknown[]} set={set} />;
  if (s.type === "boolean")
    return <Checkbox checked={value === true} label={cell ? undefined : s.title} aria-label={label} onChange={set} />;
  if (s.options)
    return (
      <Select
        aria-label={label}
        value={String(value)}
        options={s.options.map((o) => ({ value: o, label: o }))}
        onChange={set}
      />
    );
  if (s.multiline && s.type === "string")
    return (
      <textarea
        className={styles.multiline}
        aria-label={label}
        value={String(value ?? "")}
        onChange={(e) => set(e.target.value)}
      />
    );
  return (
    <Input
      aria-label={label}
      type={s.type === "string" ? "text" : "number"}
      step={s.type === "integer" ? 1 : "any"}
      value={String(value ?? "")}
      onChange={(e) => {
        const raw = e.target.value;
        if (s.type === "string") set(raw);
        else if (raw.trim() && Number.isFinite(Number(raw)))
          set(s.type === "integer" ? Math.trunc(Number(raw)) : Number(raw));
      }}
    />
  );
}

function ArrayControl({ s, value, set }: { s: SettingSchema; value: unknown[]; set(value: unknown): void }) {
  const item = s.items!;
  const columns = item.type === "object" ? item.properties! : [item];
  const rows = Array.isArray(value) ? value : [];
  const update = (index: number, field: SettingSchema, next: unknown) =>
    set(
      rows.map((row, i) =>
        i !== index ? row : item.type === "object" ? { ...(row as Record<string, unknown>), [field.key]: next } : next,
      ),
    );
  const move = (index: number, delta: number) => {
    const next = [...rows];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    set(next);
  };
  return (
    <div className={styles.array}>
      <div className={styles.scroll}>
        <table aria-label={s.title}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{item.type === "object" ? c.title : s.title}</th>
              ))}
              <th>
                <T>Actions</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <ValueControl
                      s={c}
                      cell
                      label={`${s.title}: ${c.title} ${i + 1}`}
                      value={item.type === "object" ? (row as Record<string, unknown>)[c.key] : row}
                      set={(v) => update(i, c, v)}
                    />
                  </td>
                ))}
                <td>
                  <div className={styles.buttons}>
                    <IconButton
                      size="small"
                      icon="arrow-up"
                      title="Move Up"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    />
                    <IconButton
                      size="small"
                      icon="arrow-down"
                      title="Move Down"
                      disabled={i === rows.length - 1}
                      onClick={() => move(i, 1)}
                    />
                    <IconButton
                      size="small"
                      icon="trash"
                      title="Remove"
                      onClick={() => set(rows.filter((_, index) => index !== i))}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        className={styles.add}
        disabled={rows.length >= 1000}
        onClick={() => set([...rows, structuredClone(item.default)])}
      >
        <T>Add</T>
      </Button>
    </div>
  );
}

function accepts(s: SettingSchema, value: unknown): boolean {
  if (s.type === "array")
    return Array.isArray(value) && value.length <= 1000 && !!s.items && value.every((v) => accepts(s.items!, v));
  if (s.type === "object")
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === s.properties?.length &&
      s.properties.every((p) => accepts(p, (value as Record<string, unknown>)[p.key]))
    );
  if (s.type === "boolean") return typeof value === "boolean";
  if (s.type === "number" || s.type === "integer")
    return typeof value === "number" && Number.isFinite(value) && (s.type !== "integer" || Number.isInteger(value));
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length <= 65536 &&
    (!s.options || s.options.includes(value))
  );
}

function SettingControl({ pluginId, s }: { pluginId: string; s: SettingSchema }) {
  const [invalid, setInvalid] = useState(false);
  const form = useSettingsForm();
  const all = form.useValue("plugins") as PluginSettings | undefined;
  const stored = all?.[pluginId]?.[s.key];
  const value = accepts(s, stored) ? stored : s.default;
  return (
    <div className={styles.field}>
      {s.type !== "boolean" && <span>{s.title}</span>}
      <ValueControl
        s={s}
        value={value}
        set={(v) => {
          const valid = accepts(s, v);
          setInvalid(!valid);
          // Keep the chosen value even when it equals the default: false and ""
          // are real plugin settings, not "remove the override".
          if (valid) form.setMapEntry("plugins", [pluginId, s.key], v);
        }}
      />
      {s.description && <div className={styles.description}>{s.description}</div>}
      {invalid && (
        <p role="alert" className={styles.error}>
          <T>The value exceeds this setting’s limits.</T>
        </p>
      )}
    </div>
  );
}

function PageAction({ pluginId, action }: { pluginId: string; action: SettingsAction }) {
  const form = useSettingsForm();
  const lock = useRef(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (lock.current) return;
    lock.current = true;
    setRunning(true);
    setError(null);
    try {
      if (!(await form.apply())) throw new Error(tx`Could not apply settings.`);
      await pluginsBackend().runCommand(pluginId, action.command, null, null, [], form.scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setRunning(false);
    }
  };
  return (
    <div>
      <Button disabled={running} onClick={() => void run()}>
        <>{action.title}</>
      </Button>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

function settingsPage(pluginId: string, page: Pick<SettingsPage, "properties" | "actions">) {
  return function PluginSettingsPage() {
    const groups = new Map<string, SettingSchema[]>();
    for (const s of page.properties) {
      const key = s.group ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    return (
      <div className={`${styles.page} ${page.properties.some((s) => s.type === "array") ? "" : styles.scalars}`}>
        <p className={styles.description}>
          <T>Settings of the plugin; projects can override them.</T>
        </p>
        {[...groups].map(([title, properties]) => (
          <section key={title} className={styles.group}>
            {title && <h3>{title}</h3>}
            {properties.map((s) => (
              <SettingControl key={s.key} pluginId={pluginId} s={s} />
            ))}
          </section>
        ))}
        {!!page.actions?.length && (
          <>
            <p className={styles.description}>
              <T>Running an action applies pending settings first.</T>
            </p>
            <div className={styles.buttons}>
              {page.actions.map((a, index) => (
                <PageAction key={index} pluginId={pluginId} action={a} />
              ))}
            </div>
          </>
        )}
        <PluginSecrets pluginId={pluginId} />
      </div>
    );
  };
}

function keywords(page: Pick<SettingsPage, "properties" | "actions">): string[] {
  const fieldWords = (s: SettingSchema): string[] => [
    s.key,
    s.title,
    s.description ?? "",
    s.group ?? "",
    ...(s.options ?? []),
    ...(s.items ? fieldWords(s.items) : []),
    ...(s.properties ?? []).flatMap(fieldWords),
  ];
  return [...page.properties.flatMap(fieldWords), ...(page.actions ?? []).map((a) => a.title)];
}

/**
 * The plugin's `[[contributes.secrets]]` on its Settings page: a password
 * field per secret, which is where users look for an API key. The plugin
 * details page lists the same fields.
 */
function PluginSecrets({ pluginId }: { pluginId: string }) {
  const ui = usePlugins((s) => s.ui);
  const catalogs = usePluginCatalogs((s) => s.catalogs);
  const plugin = usePlugins((s) => s.plugins.find((p) => p.id === pluginId));
  const items = useMemo(
    () => (plugin ? itemsOf<SecretDecl>(localizeContributions(ui, catalogs), "secrets", pluginId) : []),
    [ui, catalogs, pluginId, plugin],
  );
  if (!plugin || !items.length) return null;
  return (
    <section className={styles.group}>
      <h3>
        <T>Secrets</T>
      </h3>
      <SecretsDetails plugin={plugin} items={items} />
    </section>
  );
}

export function projectSettings(pluginId: string, decl: SettingsDecl): () => void {
  const id = pluginSettingsPageId(pluginId);
  const pages = decl.pages ?? [];
  const dispose = [
    registerSettingsPage({
      id,
      title: decl.title,
      projectScope: true,
      keywords: ["plugin", pluginId, ...keywords(decl)],
      component: pages.length ? undefined : settingsPage(pluginId, decl),
    }),
  ];
  for (const p of pages)
    dispose.push(
      registerSettingsPage({
        id: `${id}.settings:${p.id}`,
        title: p.title,
        projectScope: true,
        keywords: [pluginId, decl.title, ...keywords(p)],
        component: settingsPage(pluginId, p),
      }),
    );
  return () => dispose.forEach((d) => d());
}
