/** Settings › Editor › Live Templates. */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { Button, Checkbox, IconButton, Input, T } from "@/ui";
import { bodyVariables, type LiveTemplate, type TemplateVariable } from "../live/model";
import {
  isModifiedBuiltin,
  newTemplateId,
  removeTemplate,
  resetTemplate,
  saveTemplate,
  updateLiveTemplateOptions,
  useLiveTemplateOptions,
  useLiveTemplates,
} from "../live/store";
import { BUILTIN_IDS } from "../live/builtins";
import styles from "./Settings.module.css";
import { tx } from "@/platform/i18n";

export function groupTemplates(templates: readonly LiveTemplate[], filter: string): Array<[string, LiveTemplate[]]> {
  const q = filter.trim().toLowerCase();
  const groups = new Map<string, LiveTemplate[]>();
  for (const t of templates) {
    if (q && !`${t.abbrev} ${t.description} ${t.group}`.toLowerCase().includes(q)) continue;
    const list = groups.get(t.group) ?? [];
    list.push(t);
    groups.set(t.group, list);
  }
  return [...groups];
}

export function LiveTemplatesPage() {
  const templates = useLiveTemplates((s) => s.templates);
  useLiveTemplates((s) => s.custom);
  const options = useLiveTemplateOptions();
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const groups = useMemo(() => groupTemplates(templates, filter), [templates, filter]);
  const selected = templates.find((t) => t.id === selectedId) ?? null;

  const add = () => {
    const t: LiveTemplate = {
      id: newTemplateId(),
      group: selected?.group && !BUILTIN_IDS.has(selected.id) ? selected.group : "User",
      abbrev: "abbr",
      description: "",
      body: "$END$",
      contexts: selected?.contexts ?? ["any"],
    };
    saveTemplate(t);
    setSelectedId(t.id);
  };

  return (
    <div className={styles.page}>
      <div className={styles.options}>
        <Checkbox
          checked={options.expandWithTab}
          onChange={(v) => updateLiveTemplateOptions({ expandWithTab: v })}
          label="Expand abbreviations with Tab"
        />
        <Checkbox
          checked={options.showInCompletion}
          onChange={(v) => updateLiveTemplateOptions({ showInCompletion: v })}
          label="Show live templates in code completion"
        />
      </div>
      <div className={styles.split}>
        <div className={styles.side}>
          <div className={styles.toolbar}>
            <IconButton icon="plus" size="small" title="Add Template" onClick={add} />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Template"
              disabled={!selected || !!selected.pluginOrigin}
              onClick={() => {
                if (!selected) return;
                removeTemplate(selected.id);
                setSelectedId(null);
              }}
            />
            <Input
              variant="bare"
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter templates"
            />
          </div>
          <div className={styles.items} role="listbox" aria-label={tx("Live templates")}>
            {groups.map(([group, list]) => (
              <div key={group} role="group" aria-label={group}>
                <div className={styles.groupHeader}>{group}</div>
                {list.map((t) => (
                  <div
                    key={t.id}
                    role="option"
                    aria-selected={t.id === selectedId}
                    className={clsx(
                      styles.item,
                      t.id === selectedId && styles.itemSelected,
                      t.enabled === false && styles.disabledItem,
                    )}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <Checkbox
                      disabled={!!t.pluginOrigin}
                      checked={t.enabled !== false}
                      onChange={(v) => saveTemplate({ ...t, enabled: v })}
                      aria-label={tx`Enable ${t.abbrev}`}
                    />
                    <span className={clsx(styles.itemLabel, isModifiedBuiltin(t.id) && styles.modified)}>
                      {t.abbrev}
                    </span>
                    <span className={styles.itemDetail} title={t.description}>
                      {t.description}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.editor}>
          {selected ? (
            <fieldset disabled={!!selected.pluginOrigin} className={styles.readonly}>
              <TemplateEditor key={selected.id} template={selected} />
            </fieldset>
          ) : (
            <div className={styles.empty}>
              <T>Select a template to edit it</T>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateEditor({ template: t }: { template: LiveTemplate }) {
  const update = (patch: Partial<LiveTemplate>) => saveTemplate({ ...t, ...patch });
  const names = bodyVariables(t.body);
  const vars = names.map((n) => t.variables?.find((v) => v.name === n) ?? { name: n });
  const setVar = (name: string, patch: Partial<TemplateVariable>) =>
    update({ variables: vars.map((v) => (v.name === name ? { ...v, ...patch } : v)) });

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Abbreviation</T>
        </span>
        <Input
          className={styles.grow}
          mono
          value={t.abbrev}
          onChange={(e) => update({ abbrev: e.target.value.trim() })}
          aria-label="Abbreviation"
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Description</T>
        </span>
        <Input
          className={styles.grow}
          value={t.description}
          onChange={(e) => update({ description: e.target.value })}
          aria-label="Description"
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Group</T>
        </span>
        <Input
          className={styles.grow}
          value={t.group}
          onChange={(e) => update({ group: e.target.value || "User" })}
          aria-label="Group"
        />
      </div>
      <textarea
        className={styles.body}
        value={t.body}
        spellCheck={false}
        aria-label={tx("Template text")}
        onChange={(e) => update({ body: e.target.value })}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: s, selectionEnd: end } = el;
          const body = `${t.body.slice(0, s)}\t${t.body.slice(end)}`;
          update({ body });
          requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1));
        }}
      />
      <div className={styles.hint}>
        <code>$NAME$</code> <T>variables (repeated ones are linked),</T> <code>$END$</code> <T>caret,</T>{" "}
        <code>$SELECTION$</code> <T>surrounded text,</T> <code>$$</code>{" "}
        <T>a dollar sign. Leading tabs are indent units.</T>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          <T>Contexts</T>
        </span>
        <Input
          className={styles.grow}
          mono
          value={t.contexts.join(", ")}
          onChange={(e) => update({ contexts: e.target.value.split(/[,\s]+/).filter(Boolean) })}
          placeholder="any, rust, typescript…"
          aria-label="Contexts"
        />
      </div>
      <div className={styles.row}>
        <Checkbox
          checked={(t.scope ?? "code") === "any"}
          onChange={(v) => update({ scope: v ? "any" : "code" })}
          label="Also expand in comments and strings"
        />
      </div>
      {vars.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <T>Variable</T>
              </th>
              <th>
                <T>Expression</T>
              </th>
              <th>
                <T>Default value</T>
              </th>
              <th>
                <T>Skip if defined</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => (
              <tr key={v.name}>
                <td>{v.name}</td>
                <td>
                  <Input
                    mono
                    value={v.expression ?? ""}
                    placeholder="className()"
                    onChange={(e) => setVar(v.name, { expression: e.target.value || undefined })}
                    aria-label={tx`${v.name} expression`}
                  />
                </td>
                <td>
                  <Input
                    mono
                    value={v.defaultValue ?? ""}
                    placeholder='"value"'
                    onChange={(e) => setVar(v.name, { defaultValue: e.target.value || undefined })}
                    aria-label={tx`${v.name} default value`}
                  />
                </td>
                <td>
                  <Checkbox
                    checked={!!v.skipIfDefined}
                    onChange={(c) => setVar(v.name, { skipIfDefined: c })}
                    aria-label={tx`Skip ${v.name} if defined`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.hint}>
        <T>Functions:</T> <code>className()</code> <code>methodName()</code> <code>fileName()</code>{" "}
        <code>fileNameWithoutExtension()</code> <code>date(&quot;yyyy-MM-dd&quot;)</code> <code>time()</code>{" "}
        <code>user()</code> <code>clipboard()</code> <code>complete()</code> <code>suggestVariableName()</code>{" "}
        <code>commentStart()</code> <code>capitalize(…)</code> <code>camelCase(…)</code> <code>snakeCase(…)</code>
      </div>
      {BUILTIN_IDS.has(t.id) && isModifiedBuiltin(t.id) && (
        <div className={styles.buttons}>
          <Button size="small" onClick={() => resetTemplate(t.id)}>
            <T>Restore Default</T>
          </Button>
        </div>
      )}
    </>
  );
}
