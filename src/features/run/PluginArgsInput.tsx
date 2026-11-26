/**
 * The Arguments field of a plugin's own run configuration, completed by that plugin
 * (plugin API 1.18): suggestions follow the caret as the user types (or on Ctrl+Space),
 * and choosing one replaces only the argument the plugin names, so the other options,
 * quoted values and arguments after `--` stay as they are.
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Input, List, Popup, listNavigate } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { useTx } from "@/platform/i18n";
import type { RunConfigCompletion } from "@/platform/ipc";
import { applyCompletion, completeArguments } from "./pluginArgsCompletion";
import styles from "./Run.module.css";

const ROW_HEIGHT = 22;
const MAX_ROWS = 10;

export function PluginArgsInput({
  configId,
  value,
  onChange,
  placeholder,
  complete = completeArguments,
}: {
  configId: string;
  value: string;
  onChange: (text: string) => void;
  /** Untranslated; the input translates it. */
  placeholder?: string;
  /** The completion source (tests replace it). */
  complete?: typeof completeArguments;
}) {
  const tx = useTx();
  const id = useId();
  const rowHeight = useRowHeight(ROW_HEIGHT);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const pendingCaret = useRef<number | null>(null);
  const [items, setItems] = useState<RunConfigCompletion[]>([]);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const close = () => {
    generation.current += 1;
    setItems([]);
  };
  /** Asks the plugin for `text`; an answer for older text or another caret is dropped. */
  const request = (text: string, caret: number) => {
    const mine = ++generation.current;
    void complete(configId, text, caret).then((answer) => {
      if (mine !== generation.current) return;
      setItems(answer);
      setActive(0);
    });
  };
  const choose = (item: RunConfigCompletion | undefined) => {
    if (!item) return;
    const next = applyCompletion(value, item);
    pendingCaret.current = next.caret;
    close();
    onChange(next.text);
    input.current?.focus();
  };
  const shown = items.length > 0;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      request(value, e.currentTarget.selectionStart ?? value.length);
      return;
    }
    if (!shown) return;
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      choose(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = listNavigate(e.key, { items, active, wrap: true });
      if (next === null) return;
      e.preventDefault();
      setActive(next);
    }
  };
  return (
    <>
      <Input
        ref={input}
        mono
        role="combobox"
        aria-label="Arguments"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        aria-activedescendant={shown && items[active] ? `${id}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          request(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <Popup
        open={shown}
        anchor={input}
        onClose={close}
        autoFocus={false}
        restoreFocus={false}
        role="presentation"
        className={styles.argsPopup}
      >
        <div className={styles.argsListWrap} style={{ height: Math.min(MAX_ROWS, items.length) * rowHeight + 8 }}>
          <List
            id={id}
            items={items}
            getKey={(item) => `${item.label}\u0000${item.detail ?? ""}\u0000${item.insert}`}
            activeIndex={active}
            onActiveChange={setActive}
            onActivate={choose}
            focusable={false}
            hoverSelects
            rowHeight={rowHeight}
            aria-label={tx("Argument completions")}
            className={styles.argsList}
            renderItem={(item) => (
              <span className={styles.argsRow} title={item.detail ? `${item.label} — ${item.detail}` : item.label}>
                <span className={styles.argsLabel}>{item.label}</span>
                {item.detail && <span className={styles.argsDetail}>{item.detail}</span>}
              </span>
            )}
          />
        </div>
      </Popup>
    </>
  );
}
