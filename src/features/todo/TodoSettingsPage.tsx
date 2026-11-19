/** Settings › Editor › TODO: patterns, colours, matching options. */
import { Button, Checkbox, IconButton, Input, Select, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { DEFAULT_PATTERNS, type TodoPattern } from "./model";
import { updateTodoSettings, useTodoSettings } from "./store";
import styles from "./TodoSettingsPage.module.css";
import { tx } from "@/platform/i18n";

const COLORS = [
  { value: "var(--info)", label: "Blue" },
  { value: "var(--danger)", label: "Red" },
  { value: "var(--warning)", label: "Yellow" },
  { value: "var(--success)", label: "Green" },
  { value: "var(--syn-annotation)", label: "Violet" },
  { value: "var(--fg-muted)", label: "Grey" },
];

export function TodoSettingsPage() {
  const form = useSettingsForm();
  const saved = useTodoSettings();
  const caseSensitive = form.useExternal("caseSensitive", saved.caseSensitive, async (value) => {
    updateTodoSettings({ caseSensitive: value });
    return value;
  });
  const commentsOnly = form.useExternal("commentsOnly", saved.commentsOnly, async (value) => {
    updateTodoSettings({ commentsOnly: value });
    return value;
  });
  const { value: patterns, set: setPatterns } = form.useExternal("patterns", saved.patterns, async (value) => {
    updateTodoSettings({ patterns: value });
    return value;
  });
  const patch = (id: string, p: Partial<TodoPattern>) =>
    setPatterns(patterns.map((x) => (x.id === id ? { ...x, ...p } : x)));

  return (
    <div className={styles.page}>
      <div className={styles.options}>
        <Checkbox checked={caseSensitive.value} onChange={caseSensitive.set} label="Case sensitive" />
        <Checkbox checked={commentsOnly.value} onChange={commentsOnly.set} label="Only in comments" />
      </div>
      <div className={styles.header}>
        <span>
          <T>Patterns</T>
        </span>
        <IconButton
          icon="plus"
          size="small"
          title="Add Pattern"
          onClick={() =>
            setPatterns([
              ...patterns,
              { id: `p${Date.now().toString(36)}`, keyword: "NOTE", color: "var(--success)", enabled: true },
            ])
          }
        />
      </div>
      <div className={styles.list} role="list" aria-label={tx("TODO patterns")}>
        {patterns.map((p) => (
          <div key={p.id} className={styles.row} role="listitem">
            <Checkbox
              checked={p.enabled}
              onChange={(v) => patch(p.id, { enabled: v })}
              aria-label={tx`Enable ${p.keyword}`}
            />
            <Input
              mono
              className={styles.keyword}
              value={p.keyword}
              onChange={(e) => patch(p.id, { keyword: e.target.value.replace(/\s+/g, "") })}
              aria-label="Keyword"
            />
            <span className={styles.swatch} style={{ background: p.color }} aria-hidden />
            <Select
              value={p.color}
              options={COLORS}
              onChange={(v) => patch(p.id, { color: v })}
              aria-label={tx`${p.keyword} colour`}
            />
            <IconButton
              icon="trash"
              size="small"
              title="Remove Pattern"
              onClick={() => setPatterns(patterns.filter((x) => x.id !== p.id))}
            />
          </div>
        ))}
      </div>
      <div>
        <Button size="small" onClick={() => setPatterns(DEFAULT_PATTERNS)}>
          <T>Restore Defaults</T>
        </Button>
      </div>
    </div>
  );
}
