/** Settings › Editor › TODO: patterns, colours, matching options. */
import { useState } from "react";
import { Button, Checkbox, Dialog, IconButton, Input, Select, T } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import {
  DEFAULT_PATTERNS,
  updateTodoSettings,
  useTodoSettings,
  type TodoFilter,
  type TodoPattern,
} from "@/platform/todo";
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

function TodoFilterDialog({
  filter,
  filters,
  patterns,
  onClose,
  onSave,
}: {
  filter: TodoFilter;
  filters: readonly TodoFilter[];
  patterns: readonly TodoPattern[];
  onClose: () => void;
  onSave: (filter: TodoFilter) => void;
}) {
  const [name, setName] = useState(filter.name);
  const [selected, setSelected] = useState(() => new Set(filter.patternIds));
  const available = patterns.filter(({ keyword }) => keyword.trim());
  const patternIds = available.filter(({ id }) => selected.has(id)).map(({ id }) => id);
  const trimmed = name.trim();
  const duplicate = filters.some((candidate) => candidate.id !== filter.id && candidate.name === trimmed);
  return (
    <Dialog
      open
      title={tx(filter.name ? "Edit TODO Filter" : "Add TODO Filter")}
      onClose={onClose}
      width={380}
      buttons={[
        {
          role: "default",
          label: "OK",
          disabled: !trimmed || duplicate || !patternIds.length,
          onClick: () => onSave({ ...filter, name: trimmed, patternIds }),
        },
        { role: "cancel", label: "Cancel" },
      ]}
    >
      <div className={styles.page}>
        <Input
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="Filter name"
          aria-label="Filter name"
          data-autofocus
        />
        {duplicate && (
          <span role="status">
            <T>A TODO filter with this name already exists.</T>
          </span>
        )}
        <fieldset className={styles.filterPatterns}>
          <legend>
            <T>Patterns</T>
          </legend>
          {available.map(({ id, keyword }) => (
            <Checkbox
              key={id}
              label={<span>{keyword}</span>}
              checked={selected.has(id)}
              onChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(id);
                else next.delete(id);
                setSelected(next);
              }}
            />
          ))}
        </fieldset>
        {!patternIds.length && (
          <span role="status">
            <T>Select at least one TODO pattern.</T>
          </span>
        )}
      </div>
    </Dialog>
  );
}

export function TodoSettingsPage() {
  const form = useSettingsForm();
  const saved = useTodoSettings();
  const [editingFilter, setEditingFilter] = useState<TodoFilter | null>(null);
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
  const { value: filters, set: setFilters } = form.useExternal("filters", saved.filters, async (value) => {
    updateTodoSettings({ filters: value });
    return value;
  });
  const replacePatterns = (next: TodoPattern[]) => {
    setPatterns(next);
    const valid = new Set(next.map(({ id }) => id));
    const updated = filters.map((filter) => {
      const patternIds = filter.patternIds.filter((id) => valid.has(id));
      return patternIds.length === filter.patternIds.length ? filter : { ...filter, patternIds };
    });
    if (updated.some((filter, index) => filter !== filters[index])) setFilters(updated);
  };
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
              onClick={() => replacePatterns(patterns.filter((x) => x.id !== p.id))}
            />
          </div>
        ))}
      </div>
      <div>
        <Button size="small" onClick={() => replacePatterns(DEFAULT_PATTERNS)}>
          <T>Restore Defaults</T>
        </Button>
      </div>
      <div className={styles.header}>
        <span>
          <T>Filters</T>
        </span>
        <IconButton
          icon="plus"
          size="small"
          title="Add TODO Filter"
          disabled={!patterns.some(({ keyword }) => keyword.trim())}
          onClick={() => setEditingFilter({ id: crypto.randomUUID(), name: "", patternIds: [] })}
        />
      </div>
      <div className={styles.list} role="list" aria-label={tx("TODO filters")}>
        {!filters.length && (
          <div className={styles.empty}>
            <T>No TODO filters</T>
          </div>
        )}
        {filters.map((filter) => (
          <div className={styles.row} role="listitem" key={filter.id}>
            <span className={styles.filterName} title={filter.name}>
              {filter.name}
            </span>
            <IconButton icon="edit" size="small" title="Edit TODO Filter" onClick={() => setEditingFilter(filter)} />
            <IconButton
              icon="trash"
              size="small"
              title="Remove TODO Filter"
              onClick={() => setFilters(filters.filter(({ id }) => id !== filter.id))}
            />
          </div>
        ))}
      </div>
      {editingFilter && (
        <TodoFilterDialog
          key={editingFilter.id}
          filter={editingFilter}
          filters={filters}
          patterns={patterns}
          onClose={() => setEditingFilter(null)}
          onSave={(filter) => {
            setFilters(
              editingFilter.name
                ? filters.map((existing) => (existing.id === filter.id ? filter : existing))
                : [...filters, filter],
            );
            setEditingFilter(null);
          }}
        />
      )}
    </div>
  );
}
