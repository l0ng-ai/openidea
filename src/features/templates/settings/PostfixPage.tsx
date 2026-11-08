/** Settings › Editor › Postfix Completion. */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { Checkbox, T } from "@/ui";
import { POSTFIX_GROUPS, POSTFIX_TEMPLATES } from "../postfix/model";
import { setPostfixTemplateEnabled, updatePostfixSettings, usePostfixSettings } from "../postfix/store";
import styles from "./Settings.module.css";
import { tx } from "@/platform/i18n";

export function PostfixPage() {
  const settings = usePostfixSettings();
  const disabled = useMemo(() => new Set(settings.disabled), [settings.disabled]);
  const [group, setGroup] = useState(POSTFIX_GROUPS[0]!.id);
  const list = POSTFIX_TEMPLATES.filter((t) => t.id.startsWith(`${group}.`));

  return (
    <div className={styles.page}>
      <div className={styles.options}>
        <Checkbox
          checked={settings.enabled}
          onChange={(v) => updatePostfixSettings({ enabled: v })}
          label="Enable postfix completion"
        />
        <Checkbox
          checked={settings.expandWithTab}
          disabled={!settings.enabled}
          onChange={(v) => updatePostfixSettings({ expandWithTab: v })}
          label="Expand templates with Tab"
        />
        <Checkbox
          checked={settings.showInCompletion}
          disabled={!settings.enabled}
          onChange={(v) => updatePostfixSettings({ showInCompletion: v })}
          label="Show postfix templates in code completion"
        />
      </div>
      <div className={styles.hint}>
        <T>Type an expression followed by</T> <code>.key</code>, e.g. <code>user.name.nn</code> or{" "}
        <code>items.for</code>
        <T>, then press Tab.</T>
      </div>
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
      <div className={styles.list} role="list" aria-label={tx("Postfix templates")}>
        {list.map((t) => (
          <div key={t.id} className={styles.listRow} role="listitem">
            <Checkbox
              checked={!disabled.has(t.id)}
              disabled={!settings.enabled}
              onChange={(v) => setPostfixTemplateEnabled(t.id, v)}
              aria-label={tx`Enable .${t.key}`}
            />
            <span className={styles.mono}>.{t.key}</span>
            <span className={styles.itemDetail} title={t.description}>
              {t.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
