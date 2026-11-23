/**
 * IDEA's Scopes editor (Find in Files › Scope › …): named scopes defined by a
 * file pattern, saved per project (`@/platform/search`) and offered wherever
 * named scopes are (Find in Files, the analyses' Specify Scope).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { create } from "zustand";
import { tx, txTemplate, useTx, useTxTemplate } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { customScopes, saveCustomScopes, type CustomScope } from "@/platform/search";
import { Dialog, IconButton, Input, T } from "@/ui";
import styles from "./ScopesDialog.module.css";

export const useScopesDialog = create<{ open: boolean; select: string | null }>(() => ({ open: false, select: null }));

export function showScopesDialog(arg: unknown) {
  const select =
    arg && typeof arg === "object" && typeof (arg as { select?: unknown }).select === "string"
      ? (arg as { select: string }).select
      : null;
  useScopesDialog.setState({ open: true, select });
}

export function ScopesDialogOverlay() {
  const open = useScopesDialog((s) => s.open);
  return open ? <ScopesDialog /> : null;
}

/** Problems that keep the list from being saved, or null. */
export function scopesProblem(scopes: readonly CustomScope[]): string | null {
  const names = new Set<string>();
  for (const s of scopes) {
    const name = s.name.trim();
    if (!name) return "Every scope needs a name";
    if (names.has(name)) return `Duplicate scope name '${name}'`;
    names.add(name);
    if (!s.pattern.trim()) return `Scope '${name}' has no pattern`;
  }
  return null;
}

function newName(scopes: readonly CustomScope[]): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? tx("Unnamed") : txTemplate(`Unnamed (${i})`);
    if (!scopes.some((s) => s.name === name)) return name;
  }
}

/** The backend's complaint about a pattern (debounced), or null. */
function usePatternError(pattern: string): string | null {
  const [checked, setChecked] = useState<{ pattern: string; error: string | null } | null>(null);
  useEffect(() => {
    if (!pattern.trim() || !isTauri()) return;
    let alive = true;
    const setError = (error: string | null) => alive && setChecked({ pattern, error });
    const t = setTimeout(() => {
      call(
        commands.searchValidate({
          pattern: "",
          isRegex: false,
          caseSensitive: false,
          wholeWord: false,
          include: [],
          exclude: [],
          scope: { kind: "pattern", pattern },
          maxMatches: 0,
        }),
      ).then(
        () => setError(null),
        (e: unknown) => setError(String((e as Error)?.message ?? e)),
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pattern]);
  return checked?.pattern === pattern && pattern.trim() ? checked.error : null;
}

function ScopesDialog() {
  const tr = useTx();
  const trTemplate = useTxTemplate();
  const ids = { name: useId(), pattern: useId() };
  const [scopes, setScopes] = useState<CustomScope[]>(() => customScopes().map((s) => ({ ...s })));
  const [index, setIndex] = useState(() => {
    const select = useScopesDialog.getState().select;
    return Math.max(0, select ? scopes.findIndex((s) => s.name === select) : 0);
  });
  const selectedRow = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [index, scopes.length]);
  const current = scopes[index] ?? null;
  const patternError = usePatternError(current?.pattern ?? "");
  const problem = scopesProblem(scopes);
  const close = () => useScopesDialog.setState({ open: false, select: null });

  const update = (patch: Partial<CustomScope>) =>
    setScopes((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const add = () => {
    setScopes((list) => [...list, { name: newName(list), pattern: "" }]);
    setIndex(scopes.length);
  };
  const remove = () => {
    if (!current) return;
    setScopes((list) => list.filter((_, i) => i !== index));
    setIndex((i) => Math.max(0, Math.min(i, scopes.length - 2)));
  };
  const ok = () => {
    saveCustomScopes(scopes);
    close();
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Scopes"
      width={640}
      aria-label="Scopes"
      footerStart={problem && <span className={styles.error}>{trTemplate(problem)}</span>}
      buttons={[
        { label: "OK", role: "default", disabled: !!problem, onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.side}>
          <div className={styles.toolbar} role="toolbar" aria-label={tr("Scopes actions")}>
            <IconButton icon="plus" title="Add Scope" size="small" onClick={add} />
            <IconButton icon="minus" title="Remove Scope" size="small" disabled={!current} onClick={remove} />
          </div>
          {scopes.length ? (
            <ul className={styles.list} aria-label={tr("Scopes")}>
              {scopes.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    ref={i === index ? selectedRow : undefined}
                    className={clsx(styles.item, i === index && styles.itemOn)}
                    aria-current={i === index || undefined}
                    title={s.name}
                    onClick={() => setIndex(i)}
                  >
                    <span>{s.name || tr("Unnamed")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.empty}>
              <T>No custom scopes</T>
            </div>
          )}
        </div>
        <div className={styles.form}>
          {current ? (
            <>
              <label className={styles.label} htmlFor={ids.name}>
                <T>Name:</T>
              </label>
              <Input id={ids.name} value={current.name} onChange={(e) => update({ name: e.target.value })} />
              <label className={styles.label} htmlFor={ids.pattern}>
                <T>Pattern:</T>
              </label>
              <Input
                id={ids.pattern}
                mono
                data-autofocus
                value={current.pattern}
                invalid={!!patternError}
                placeholder="file:src//*&&!file:*test*"
                onChange={(e) => update({ pattern: e.target.value })}
              />
              {patternError && <div className={styles.error}>{patternError}</div>}
              <ul className={styles.help}>
                <li>
                  <code>file:*.ts</code> <T>files by name, anywhere</T>
                </li>
                <li>
                  <code>file:src/*</code> <T>files directly in a folder</T>, <code>file:src//*</code>{" "}
                  <T>at any depth</T>
                </li>
                <li>
                  <code>!</code> <T>not</T>, <code>&&</code> <T>and</T>, <code>||</code> <T>or</T>, <code>( )</code>{" "}
                  <T>grouping</T>
                </li>
              </ul>
            </>
          ) : (
            <div className={styles.empty}>
              <T>Add a scope to define it by a file pattern.</T>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
