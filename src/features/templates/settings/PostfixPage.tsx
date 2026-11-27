/** Settings › Editor › Postfix Completion. */
import { useCallback, useMemo, useState } from "react";
import clsx from "clsx";
import { Checkbox, T } from "@/ui";
import { listNavigate } from "@/ui/List";
import { expandTemplate } from "../live/model";
import { POSTFIX_GROUPS, POSTFIX_TEMPLATES, type PostfixTemplate } from "../postfix/model";
import { setPostfixTemplateEnabled, updatePostfixSettings, usePostfixSettings } from "../postfix/store";
import styles from "./Settings.module.css";
import { tx } from "@/platform/i18n";

const EXAMPLE_EXPRESSION = "expr";

function PostfixPreview({ template }: { template: PostfixTemplate }) {
  const preview = expandTemplate(template, {
    predefined: { EXPR: EXAMPLE_EXPRESSION, TYPE: "Type", PAT: "pattern" },
  }).preview;
  return (
    <section className={styles.postfixPreview} aria-label={tx("Template preview")}>
      <div className={styles.postfixDescription}>
        <code>.{template.key}</code>
        <span>{template.description}</span>
      </div>
      <div>
        <span>
          <T>Before</T>
        </span>
        <pre>
          <code>
            {EXAMPLE_EXPRESSION}.{template.key}
          </code>
        </pre>
      </div>
      <div>
        <span>
          <T>{template.action ? "Fallback expansion" : "After"}</T>
        </span>
        <pre>
          <code>{preview}</code>
        </pre>
      </div>
    </section>
  );
}

export function PostfixPage() {
  const settings = usePostfixSettings();
  const disabled = useMemo(() => new Set(settings.disabled), [settings.disabled]);
  const [group, setGroup] = useState(POSTFIX_GROUPS[0]!.id);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const list = POSTFIX_TEMPLATES.filter((t) => t.id.startsWith(`${group}.`));
  const selectedIndex = Math.max(
    0,
    list.findIndex((t) => t.id === selections[group]),
  );
  const selected = list[selectedIndex];
  const select = (id: string) => setSelections((current) => ({ ...current, [group]: id }));
  const revealSelected = useCallback((button: HTMLButtonElement | null) => {
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.postfixOptions}>
        <Checkbox
          checked={settings.enabled}
          onChange={(v) => updatePostfixSettings({ enabled: v })}
          label="Enable postfix completion"
        />
        <div className={styles.postfixDependentOptions}>
          <Checkbox
            checked={settings.showInCompletion}
            disabled={!settings.enabled}
            onChange={(v) => updatePostfixSettings({ showInCompletion: v })}
            label="Show postfix templates in code completion"
          />
          <Checkbox
            checked={settings.expandWithTab}
            disabled={!settings.enabled}
            onChange={(v) => updatePostfixSettings({ expandWithTab: v })}
            label="Expand templates with Tab"
          />
        </div>
      </div>
      {settings.enabled && settings.expandWithTab && (
        <div className={styles.hint}>
          <T>Type an expression followed by</T> <code>.key</code>, e.g. <code>user.name.nn</code> or{" "}
          <code>items.for</code>
          <T>, then press Tab.</T>
        </div>
      )}
      <div className={styles.postfixWorkspace}>
        <div className={styles.postfixBrowser}>
          <div className={styles.tabs} role="tablist" aria-label={tx("Languages")}>
            {POSTFIX_GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={g.id === group}
                className={clsx(styles.tab, g.id === group && styles.tabActive)}
                onClick={() => setGroup(g.id)}
              >
                {g.title}
              </button>
            ))}
          </div>
          <div
            className={styles.list}
            role="list"
            aria-label={tx("Postfix templates")}
            onKeyDown={(event) => {
              const next = listNavigate(event.key, { items: list, active: selectedIndex });
              if (next === null) return;
              event.preventDefault();
              const template = list[next];
              if (!template) return;
              select(template.id);
              event.currentTarget.querySelectorAll("button")[next]?.focus();
            }}
          >
            {list.map((t) => {
              const active = t.id === selected?.id;
              return (
                <div key={t.id} className={clsx(styles.listRow, active && styles.itemSelected)} role="listitem">
                  <Checkbox
                    checked={!disabled.has(t.id)}
                    disabled={!settings.enabled}
                    tabIndex={active ? undefined : -1}
                    onChange={(v) => {
                      select(t.id);
                      setPostfixTemplateEnabled(t.id, v);
                    }}
                    aria-label={tx`Enable .${t.key}`}
                  />
                  <button
                    type="button"
                    ref={active ? revealSelected : undefined}
                    className={styles.postfixChoice}
                    tabIndex={active ? 0 : -1}
                    aria-label={`.${t.key}`}
                    aria-pressed={active}
                    title={t.description}
                    onClick={() => select(t.id)}
                  >
                    <span className={styles.mono}>.{t.key}</span>
                    <span className={styles.itemDetail}>{t.description}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        {selected && <PostfixPreview template={selected} />}
      </div>
    </div>
  );
}
