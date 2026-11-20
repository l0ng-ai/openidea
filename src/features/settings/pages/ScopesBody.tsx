/**
 * Appearance & Behavior › Scopes (named file sets) and › File Colors (a background
 * colour per scope in the project view and on editor tabs). Both are project settings.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { FILE_COLOR_NAMES, fileColorCss, validateFileColors, type FileColorEntry } from "@/platform/fileColors";
import { tx } from "@/platform/i18n";
import { BUILTIN_SCOPES, scopeError, validateScopes, type NamedScope } from "@/platform/scopes";
import { IconButton, Input, List, T, type SelectOption } from "@/ui";
import { ColorSwatches, Row, Section, Select, SettingToggle } from "../components/Form";
import { useSetting } from "../components/context";
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

export function ScopesEditor() {
  const [raw, setRaw] = useSetting<unknown>("scopes");
  const scopes = validateScopes(raw);
  const [selected, setSelected] = useState(0);
  const index = scopes.length ? Math.min(selected, scopes.length - 1) : -1;
  const current = scopes[index];
  const nameId = useId();
  const patternId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const focusNewScope = useRef(false);
  useLayoutEffect(() => {
    if (!focusNewScope.current) return;
    focusNewScope.current = false;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [scopes.length]);
  const set = (next: NamedScope[]) => setRaw(next);
  const update = (patch: Partial<NamedScope>) => set(scopes.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const error = current?.pattern.trim() ? scopeError(current.pattern) : null;
  const taken = [...BUILTIN_SCOPES, ...scopes.map((s) => s.name)];
  const nameClash = !!current && taken.filter((n) => n === current.name).length > 1;

  return (
    <div className={own.scopeLayout}>
      <div className={clsx(styles.tableBox, own.scopePane)}>
        <ListToolbar
          label="Scopes actions"
          index={index}
          count={scopes.length}
          onAdd={() => {
            focusNewScope.current = true;
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
        <List
          aria-label={tx("Scopes")}
          className={own.scopeList}
          items={scopes}
          activeIndex={index}
          onActiveChange={setSelected}
          getKey={(_, i) => String(i)}
          renderItem={({ name, pattern }) => (
            <span className={own.scopeName} title={pattern ? `${name}\n${pattern}` : name}>
              {name}
            </span>
          )}
          empty={
            <div className={own.scopeEmpty}>
              <T>No scopes. Click + to add one.</T>
            </div>
          }
        />
      </div>
      {current && (
        <Section title="Scope">
          <Row label="Name" htmlFor={nameId}>
            <Input
              id={nameId}
              ref={nameInput}
              className={own.scopeInput}
              value={current.name}
              invalid={nameClash || !current.name.trim()}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Row>
          <Row
            label="Pattern"
            htmlFor={patternId}
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
              className={own.scopeInput}
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

export function FileColorsEditor() {
  const [raw, setRaw] = useSetting<unknown>("fileColors");
  const [rawScopes] = useSetting<unknown>("scopes");
  const settings = validateFileColors(raw);
  const colors = settings.colors;
  const [selected, setSelected] = useState(0);
  const index = colors.length ? Math.min(selected, colors.length - 1) : -1;
  const current = colors[index];
  const set = (next: FileColorEntry[]) => setRaw({ ...settings, colors: next });
  const update = (patch: Partial<FileColorEntry>) => set(colors.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const revealRow = useCallback((row: HTMLTableRowElement | null) => {
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  const scopeNames = [...BUILTIN_SCOPES, ...validateScopes(rawScopes).map((s) => s.name)];
  const scopeOptions: SelectOption[] = scopeNames.map((n) => ({ value: n, label: n }));
  if (current && !scopeNames.includes(current.scope))
    scopeOptions.push({ value: current.scope, label: tx`${current.scope} (missing)` });
  const presets = FILE_COLOR_NAMES.map((n) => ({ value: n, label: colorLabel(n), css: fileColorCss(n) }));

  return (
    <div className={own.fileColorsLayout}>
      <div className={own.colorOptions}>
        <SettingToggle k="fileColors.enabled" label="Enable file colors" />
        <SettingToggle k="fileColors.editorTabs" label="Use in editor tabs" disabled={!settings.enabled} />
        <SettingToggle k="fileColors.projectView" label="Use in project view" disabled={!settings.enabled} />
      </div>
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
        <div className={own.colorRows}>
          <table className={styles.table} aria-label={tx("File colors")}>
            <colgroup>
              <col />
              <col className={own.colorColumn} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <T>Scope</T>
                </th>
                <th scope="col">
                  <T>Color</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {colors.length === 0 && (
                <tr className={own.emptyColorRow}>
                  <td colSpan={2} className={styles.empty}>
                    <T>No file colors. Click + to add one.</T>
                  </td>
                </tr>
              )}
              {colors.map((c, i) => (
                <tr
                  key={i}
                  ref={i === index ? revealRow : undefined}
                  className={clsx(i === index && styles.selectedRow)}
                  onClick={() => setSelected(i)}
                >
                  <td>
                    <button type="button" className={own.scopeButton} title={tx(c.scope)} aria-pressed={i === index}>
                      {tx(c.scope)}
                    </button>
                  </td>
                  <td title={tx(colorLabel(c.color))}>
                    <span className={own.swatch} style={{ background: fileColorCss(c.color) }} aria-hidden />
                    {tx(colorLabel(c.color))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {current && (
        <Section title="File Color">
          <Row label="Scope">
            <Select
              value={current.scope}
              options={scopeOptions}
              onChange={(scope) => update({ scope })}
              aria-label="Scope"
            />
          </Row>
          <Row label="Color" className={own.colorDetail}>
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
