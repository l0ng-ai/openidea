/**
 * Completion in the debugger's expression fields (Evaluate, Variables, Debug console): the
 * adapter's DAP `completions` for the selected frame, as you type an identifier or after `.`,
 * or on ⌃Space. ↑/↓ move, Enter or Tab inserts, Escape closes.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import type { DebugCompletion } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { call, commands } from "@/platform/ipc";
import { badgeKind, Popup, SymbolBadge } from "@/ui";
import { isLive, type DebugSession } from "../state";
import styles from "./ExpressionCompletion.module.css";

type Field = HTMLInputElement | HTMLTextAreaElement;

const WORD = /[\p{L}\p{N}_$]+$/u;
const DELAY = 120;
const MAX_ITEMS = 200;

/** The identifier being typed before `caret`. */
export function completionPrefix(text: string, caret: number): string {
  return WORD.exec(text.slice(0, caret))?.[0] ?? "";
}

/**
 * The adapter's items that still match `prefix` (they narrow as more is typed), by the adapter's
 * sort text, without repeats; exact-case matches first, private `_names` last unless the prefix asks for them.
 */
export function matchingCompletions(items: readonly DebugCompletion[], prefix: string): DebugCompletion[] {
  const p = prefix.toLowerCase();
  const hidden = (i: DebugCompletion) =>
    (!p.startsWith("_") && i.label.startsWith("_") ? 2 : 0) + ((i.text ?? i.label).startsWith(prefix) ? 0 : 1);
  const key = (i: DebugCompletion) => i.sortText ?? i.label;
  const seen = new Set<string>();
  return items
    .filter((i) => !p || (i.text ?? i.label).toLowerCase().startsWith(p) || i.label.toLowerCase().startsWith(p))
    .filter((i) => {
      const id = `${i.label}\u0000${i.text ?? ""}`;
      return !seen.has(id) && !!seen.add(id);
    })
    .map((item, order) => ({ item, order }))
    .sort((a, b) => hidden(a.item) - hidden(b.item) || compare(key(a.item), key(b.item)) || a.order - b.order)
    .slice(0, MAX_ITEMS)
    .map((x) => x.item);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with `item` replacing the identifier before `caret`, and the caret after it. */
export function applyCompletion(text: string, caret: number, item: DebugCompletion): { text: string; caret: number } {
  const start = caret - completionPrefix(text, caret).length;
  const insert = item.text ?? item.label;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}

/** 0-based line and UTF-16 column of `caret`. */
function position(text: string, caret: number): { line: number; column: number } {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length - 1, column: caret - lineStart };
}

export function useExpressionCompletion(
  field: RefObject<Field | null>,
  value: string,
  setValue: (text: string) => void,
  session: DebugSession | null | undefined,
) {
  const tx = useTx();
  const [items, setItems] = useState<DebugCompletion[] | null>(null);
  const [index, setIndex] = useState(0);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const list = useRef<HTMLDivElement | null>(null);
  const caret = field.current?.selectionStart ?? value.length;
  const shown = items ? matchingCompletions(items, completionPrefix(value, caret)) : [];
  const open = shown.length > 0;

  const close = () => {
    seq.current++;
    clearTimeout(timer.current);
    setItems(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const request = (explicit: boolean) => {
    const el = field.current;
    if (!el || !session || !isLive(session) || session.status !== "paused") return;
    const text = el.value;
    const at = el.selectionStart ?? text.length;
    const prefix = completionPrefix(text, at);
    if (!explicit && !prefix && text[at - 1] !== ".") {
      close();
      return;
    }
    const mine = ++seq.current;
    const { line, column } = position(text, at);
    call(commands.debugCompletions(session.id, session.selectedFrame, text, line, column)).then(
      (result) => {
        if (mine !== seq.current) return;
        setItems(result.length ? result : null);
        setIndex(0);
      },
      () => mine === seq.current && setItems(null),
    );
  };

  const accept = (item: DebugCompletion) => {
    const el = field.current;
    if (!el) return;
    const next = applyCompletion(el.value, el.selectionStart ?? el.value.length, item);
    close();
    setValue(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  return {
    /** Call after the field's value changed by typing. */
    onInput: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => request(false), DELAY);
    },
    /** Handles the popup's keys first; true when the key was consumed. */
    onKeyDown: (e: KeyboardEvent<Field>): boolean => {
      if (isImeKey(e.nativeEvent)) return false;
      if (e.key === " " && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        request(true);
        return true;
      }
      if (!open) return false;
      const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plain) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + step + shown.length) % shown.length);
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && plain) {
        e.preventDefault();
        accept(shown[Math.min(index, shown.length - 1)]!);
        return true;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") close();
      return false;
    },
    close,
    popup: open ? (
      <Popup
        open
        anchor={field}
        placement="bottom-start"
        autoFocus={false}
        restoreFocus={false}
        onClose={close}
        className={styles.popup}
      >
        <div ref={list} className={styles.list} role="listbox" aria-label={tx("Completions")}>
          {shown.map((item, i) => (
            <div
              key={`${item.label}\u0000${i}`}
              data-index={i}
              role="option"
              aria-selected={i === index}
              className={clsx(styles.item, i === Math.min(index, shown.length - 1) && styles.active)}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== index && setIndex(i)}
              onClick={() => accept(item)}
            >
              <SymbolBadge kind={badgeKind(item.kind ?? "variable")} />
              <span className={styles.label}>{item.label}</span>
              {item.detail && <span className={styles.detail}>{item.detail}</span>}
            </div>
          ))}
        </div>
      </Popup>
    ) : null,
  };
}
