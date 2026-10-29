import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DbCompletion, DbDriver } from "@/platform/ipc";
import { Input, Popup } from "@/ui";
import { editorPrefs } from "@/platform/editorSettings";
import { analyze } from "./sql/analyze";
import { quoteIdent, shouldAutoCompleteSql, sqlCandidates } from "./sql/complete";
import { inLiteral, lex } from "./sql/lexer";
import styles from "./Database.module.css";
import { SqlHighlight } from "./SqlHighlight";

export function SqlFilterInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
  kind,
  schema,
  table,
  columns,
  driver,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  kind: "where" | "order";
  schema: string;
  table: string;
  columns: readonly { name: string; type: string }[];
  driver: DbDriver;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current !== null) {
      ref.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const prefix = `SELECT * FROM ${quoteIdent(schema, driver)}.${quoteIdent(table, driver)} ${kind === "where" ? "WHERE" : "ORDER BY"} `;
  const model = useMemo<DbCompletion>(
    () => ({
      defaultSchema: schema,
      foreignKeys: [],
      tables: [
        {
          schema,
          name: table,
          kind: "table",
          columns: columns.map((c) => ({
            name: c.name,
            dataType: c.type,
            nullable: true,
            primaryKey: false,
            hasDefault: false,
          })),
        },
      ],
    }),
    [schema, table, columns],
  );
  const analysis = analyze(prefix + value, prefix.length + caret, driver);
  const from = Math.max(0, analysis.prefix.from - prefix.length);
  const typed = value.slice(from, caret).toLowerCase();
  const candidates = sqlCandidates({ model, analysis, driver }).filter(
    (c) => c.kind === "column" || (kind === "where" && ["keyword", "function"].includes(c.kind)),
  );
  if (kind === "order")
    candidates.push(...["ASC", "DESC"].map((label) => ({ label, kind: "keyword" as const, boost: 0 })));
  const options = candidates
    .filter((c, i, a) => c.label.toLowerCase().startsWith(typed) && a.findIndex((v) => v.label === c.label) === i)
    .slice(0, 30);
  const choose = (item: (typeof options)[number]) => {
    const replacement = kind === "order" && item.kind === "column" ? item.label : (item.insert ?? item.label);
    const next = value.slice(0, from) + replacement + value.slice(caret);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(from + replacement.length, from + replacement.length);
    });
  };
  return (
    <>
      <div className={styles.sqlInputWrap}>
        <div ref={highlightRef} className={styles.sqlHighlight} aria-hidden="true">
          <SqlHighlight text={value} />
        </div>
        <Input
          ref={ref}
          className={value ? styles.sqlInputText : undefined}
          onScroll={(e) => {
            if (highlightRef.current) highlightRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          variant="bare"
          mono
          aria-label={kind === "where" ? "WHERE filter" : "ORDER BY"}
          placeholder={kind === "where" ? "WHERE" : "ORDER BY"}
          invalid={invalid}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setActive(0);
            const pos = e.target.selectionStart ?? e.target.value.length;
            setOpen(shouldAutoCompleteSql(analyze(prefix + e.target.value, prefix.length + pos, driver)));
          }}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (!e.metaKey && !e.ctrlKey && !e.altKey) {
              const start = e.currentTarget.selectionStart ?? value.length;
              const end = e.currentTarget.selectionEnd ?? start;
              const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "'": "'", '"': '"' };
              const closer = pairs[e.key];
              const quote = e.key === "'" || e.key === '"';
              const prefs = editorPrefs().smartKeys;
              const literal = inLiteral(lex(value, driver), start);
              if (start === end && value[start] === e.key && (quote || ")]}".includes(e.key))) {
                e.preventDefault();
                e.currentTarget.setSelectionRange(start + 1, start + 1);
                setCaret(start + 1);
                setOpen(false);
                return;
              }
              if (
                closer &&
                start === end &&
                (quote ? prefs.pairQuotes : prefs.pairBrackets) &&
                !literal &&
                (!value[start] || /[\s)\]};,]/.test(value[start]!))
              ) {
                e.preventDefault();
                pendingCaret.current = start + 1;
                onChange(value.slice(0, start) + e.key + closer + value.slice(end));
                setCaret(start + 1);
                setOpen(false);
                return;
              }
            }
            if (e.ctrlKey && e.key === " ") {
              e.preventDefault();
              setCaret(e.currentTarget.selectionStart ?? value.length);
              setOpen(true);
              setActive(0);
              return;
            }
            if (open && options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
              return;
            }
            if (open && options.length && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              choose(options[Math.min(active, options.length - 1)]!);
              return;
            }
            if (open && e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              return;
            }
            onKeyDown(e);
          }}
        />
      </div>
      {open && options.length > 0 && (
        <Popup
          open
          anchor={ref}
          onClose={() => setOpen(false)}
          autoFocus={false}
          restoreFocus={false}
          role="listbox"
          aria-label="SQL completion"
          className={styles.sqlCompletion}
        >
          {options.map((c, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={`${c.kind}:${c.label}`}
              className={styles.sqlCompletionOption}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(c)}
            >
              <span>{c.label}</span>
              <small>{c.type ?? c.kind}</small>
            </button>
          ))}
        </Popup>
      )}
    </>
  );
}
