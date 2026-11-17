/**
 * Appearance & Behavior › Scopes (named file sets) and › File Colors (a background
 * colour per scope in the project view and on editor tabs). Both are project settings.
 */
import { useId, useState } from "react";
import clsx from "clsx";
import { FILE_COLOR_NAMES, fileColorCss, validateFileColors, type FileColorEntry } from "@/platform/fileColors";
import { tx } from "@/platform/i18n";
import { BUILTIN_SCOPES, scopeError, validateScopes, type NamedScope } from "@/platform/scopes";
import { IconButton, Input, T, type SelectOption } from "@/ui";
import { ColorSwatches, Row, Section, Select } from "../components/Form";
import { useSetting } from "../components/context";
import { APPEARANCE_GROUP } from "./behavior";
import type { PageSpec } from "./spec";
import styles from "./Workflow.module.css";
import own from "./Scopes.module.css";

/** Toolbar of an ordered list: add, remove, move up / down. */
function ListToolbar({
  label,
  index,
  count,
  onAdd,
  onRemove,
  onMove,
}: {
  label: string;
  index: number;
  count: number;
  onAdd: () => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx(label)}>
      <IconButton icon="plus" title="Add" size="small" onClick={onAdd} />
      <IconButton icon="minus" title="Remove" size="small" disabled={index < 0} onClick={onRemove} />
      <IconButton icon="arrow-up" title="Move Up" size="small" disabled={index <= 0} onClick={() => onMove(-1)} />
      <IconButton
        icon="arrow-down"
        title="Move Down"
        size="small"
        disabled={index < 0 || index >= count - 1}
        onClick={() => onMove(1)}
      />
    </div>
  );
}

function moved<T>(list: readonly T[], index: number, d: -1 | 1): T[] | null {
  const j = index + d;
  if (index < 0 || j < 0 || j >= list.length) return null;
  const next = [...list];
  [next[index], next[j]] = [next[j]!, next[index]!];
  return next;
}

/** A name not taken yet: `Scope`, `Scope 2`, … */
function freshName(taken: readonly string[]): string {
  const base = tx("Scope");
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.includes(name)) return name;
  }
}

/** A pattern, the same in every language. */
const PATTERN_EXAMPLE = "file:src//*";

function errorText(error: { message: string; at: number }): string {
  const message = tx(error.message);
  const column = error.at + 1;
  return tx`${message} at column ${column}`;
}

function ScopesEditor() {
  const [raw, setRaw] = useSetting<unknown>("scopes");
  const scopes = validateScopes(raw);
  const [selected, setSelected] = useState(0);
  const index = scopes.length ? Math.min(selected, scopes.length - 1) : -1;
  const current = scopes[index];
  const nameId = useId();
  const patternId = useId();
  const set = (next: NamedScope[]) => setRaw(next);
  const update = (patch: Partial<NamedScope>) => set(scopes.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const error = current?.pattern.trim() ? scopeError(current.pattern) : null;
  const taken = [...BUILTIN_SCOPES, ...scopes.map((s) => s.name)];
  const nameClash = !!current && taken.filter((n) => n === current.name).length > 1;

  return (
    <div className={styles.toolsLayout}>
      <div className={styles.tableBox}>
        <ListToolbar
          label="Scopes actions"
          index={index}
          count={scopes.length}
          onAdd={() => {
            set([...scopes, { name: freshName(taken), pattern: "" }]);
            setSelected(scopes.length);
          }}
          onRemove={() => set(scopes.filter((_, i) => i !== index))}
          onMove={(d) => {
            const next = moved(scopes, index, d);
            if (next) {
              set(next);
              setSelected(index + d);
            }
          }}
        />
        <div className={styles.toolList} role="listbox" aria-label={tx("Scopes")}>
          {scopes.length === 0 && (
            <div className={clsx(styles.toolRow, styles.empty)}>
              <T>No scopes. Click + to add one.</T>
            </div>
          )}
          {scopes.map((s, i) => (
            <div
              key={i}
              role="option"
              aria-selected={i === index}
              className={clsx(styles.toolRow, i === index && styles.toolRowSelected)}
              onMouseDown={() => setSelected(i)}
            >
              <span className={styles.toolName}>{s.name}</span>
              <span className={styles.toolGroup} title={s.pattern}>
                {s.pattern}
              </span>
            </div>
          ))}
        </div>
      </div>
      {current && (
        <Section title="Scope">
          <Row label="Name" htmlFor={nameId} className={styles.alignedRow}>
            <Input
              id={nameId}
              className={styles.wide}
              value={current.name}
              invalid={nameClash || !current.name.trim()}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Row>
          <Row
            label="Pattern"
            htmlFor={patternId}
            className={styles.alignedRow}
            hint={
              error ? (
                <span className={own.error} role="alert">
                  {errorText(error)}
                </span>
              ) : (
                "file:src//*.ts && !file:*.test.ts — paths are relative to the project; // is any folders, * any characters. file[module]:pattern limits a pattern to a module."
              )
            }
          >
            <Input
              id={patternId}
              mono
              className={styles.wide}
              value={current.pattern}
              invalid={!!error}
              placeholder={PATTERN_EXAMPLE}
              onChange={(e) => update({ pattern: e.target.value })}
            />
          </Row>
        </Section>
      )}
    </div>
  );
}

const COLOR_LABELS: Record<string, string> = {
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  rose: "Rose",
  violet: "Violet",
  yellow: "Yellow",
  gray: "Gray",
};

const colorLabel = (color: string) => COLOR_LABELS[color.toLowerCase()] ?? color;

function FileColorsEditor() {
  const [raw, setRaw] = useSetting<unknown>("fileColors");
  const [rawScopes] = useSetting<unknown>("scopes");
  const settings = validateFileColors(raw);
  const colors = settings.colors;
  const [selected, setSelected] = useState(0);
  const index = colors.length ? Math.min(selected, colors.length - 1) : -1;
  const current = colors[index];
  const set = (next: FileColorEntry[]) => setRaw({ ...settings, colors: next });
  const update = (patch: Partial<FileColorEntry>) => set(colors.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  const scopeNames = [...BUILTIN_SCOPES, ...validateScopes(rawScopes).map((s) => s.name)];
  const scopeOptions: SelectOption[] = scopeNames.map((n) => ({ value: n, label: n }));
  if (current && !scopeNames.includes(current.scope))
    scopeOptions.push({ value: current.scope, label: tx`${current.scope} (missing)` });
  const presets = FILE_COLOR_NAMES.map((n) => ({ value: n, label: colorLabel(n), css: fileColorCss(n) }));

  return (
    <div className={styles.toolsLayout}>
      <div className={styles.tableBox}>
        <ListToolbar
          label="File colors actions"
          index={index}
          count={colors.length}
          onAdd={() => {
            const scope = scopeNames.find((n) => !colors.some((c) => c.scope === n)) ?? scopeNames[0]!;
            set([...colors, { scope, color: "blue" }]);
            setSelected(colors.length);
          }}
          onRemove={() => set(colors.filter((_, i) => i !== index))}
          onMove={(d) => {
            const next = moved(colors, index, d);
            if (next) {
              set(next);
              setSelected(index + d);
            }
          }}
        />
        <div className={styles.toolList} role="listbox" aria-label={tx("File colors")}>
          {colors.length === 0 && (
            <div className={clsx(styles.toolRow, styles.empty)}>
              <T>No file colors. Click + to add one.</T>
            </div>
          )}
          {colors.map((c, i) => (
            <div
              key={i}
              role="option"
              aria-selected={i === index}
              className={clsx(styles.toolRow, i === index && styles.toolRowSelected)}
              onMouseDown={() => setSelected(i)}
            >
              <span className={styles.toolName}>{tx(c.scope)}</span>
              <span className={own.color}>
                <span className={own.swatch} style={{ background: fileColorCss(c.color) }} aria-hidden />
                {tx(colorLabel(c.color))}
              </span>
            </div>
          ))}
        </div>
      </div>
      {current && (
        <Section title="File Color">
          <Row label="Scope" className={styles.alignedRow}>
            <Select
              value={current.scope}
              options={scopeOptions}
              onChange={(scope) => update({ scope })}
              aria-label="Scope"
            />
          </Row>
          <Row label="Color" className={styles.alignedRow}>
            <ColorSwatches
              value={current.color}
              presets={presets}
              onChange={(color) => update({ color })}
              aria-label="Color"
            />
          </Row>
        </Section>
      )}
    </div>
  );
}

export const SCOPE_PAGES: PageSpec[] = [
  {
    id: "fileColors",
    title: "File Colors",
    group: APPEARANCE_GROUP,
    order: 1.5,
    projectScope: true,
    defaultScope: "project",
    keywords: ["colour", "color", "tab", "background", "tests", "non-project"],
    sections: [
      {
        options: [
          { kind: "toggle", key: "fileColors.enabled", label: "Enable file colors" },
          { kind: "toggle", key: "fileColors.editorTabs", label: "Use in editor tabs" },
          { kind: "toggle", key: "fileColors.projectView", label: "Use in project view" },
        ],
      },
      {
        options: [
          {
            kind: "custom",
            label: "File Colors",
            keywords: ["Scope", "Color", "Custom", "Hex value"],
            component: FileColorsEditor,
          },
        ],
      },
    ],
  },
  {
    id: "scopes",
    title: "Scopes",
    group: APPEARANCE_GROUP,
    order: 1.6,
    projectScope: true,
    defaultScope: "project",
    keywords: ["scope", "file set", "pattern"],
    sections: [
      {
        options: [{ kind: "custom", label: "Scopes", keywords: ["Name", "Pattern"], component: ScopesEditor }],
      },
    ],
  },
];
