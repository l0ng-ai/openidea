import { useId, useRef, useState } from "react";
import { Button, Input, Popup, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import { loadSystemFonts, useSystemFonts } from "@/platform/systemFonts";
import styles from "./FontPicker.module.css";

/** Editable family name, not a CSS list. Search never restricts manual input. */
export function FontPicker({
  value,
  onChange,
  label,
  id,
  disabled,
  monoOnly = false,
  allowEmpty = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  monoOnly?: boolean;
  allowEmpty?: boolean;
}) {
  const tx = useTx();
  const { fonts, status } = useSystemFonts();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ source: string; text: string } | null>(null);
  const [active, setActive] = useState(-1);
  const text = draft?.source === value ? draft.text : value;
  const query = draft?.source === value ? text.trim().toLocaleLowerCase() : "";
  const suggestions = fonts.filter((f) => (!monoOnly || f.monospaced) && f.name.toLocaleLowerCase().includes(query));
  const known = fonts.some((f) => f.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
  const message =
    status === "loading"
      ? "Loading system fonts…"
      : status === "empty"
        ? "No system fonts were returned. Bundled fonts and manual input are available."
        : value && !known && status === "ready"
          ? "This name was not found on this desktop. The saved preference is kept."
          : "Type a family name or search installed fonts.";
  const choose = (name: string) => {
    onChange(name);
    setDraft(null);
    setOpen(false);
    setActive(-1);
  };
  return (
    <span className={styles.picker}>
      <span className={styles.controls}>
        <Input
          ref={input}
          id={id}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open && !disabled}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 && suggestions[active] ? `${listId}-${active}` : undefined}
          aria-describedby={`${listId}-status`}
          value={text}
          disabled={disabled}
          placeholder={allowEmpty ? "None" : undefined}
          onFocus={() => {
            setOpen(true);
            setActive(-1);
          }}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setDraft(null);
          }}
          onChange={(e) => {
            const next = e.target.value;
            const valid = allowEmpty || !!next.trim();
            setDraft({ source: valid ? next : value, text: next });
            if (valid) onChange(next);
            setActive(-1);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              const next = Math.max(0, Math.min(suggestions.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
              setActive(next);
              document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (open && active >= 0 && suggestions[active]) choose(suggestions[active].name);
              else if (allowEmpty || text.trim()) choose(text.trim());
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        <Button
          disabled={disabled || status === "loading"}
          onClick={() => void loadSystemFonts(true)}
          aria-label={tx("Refresh system fonts")}
        >
          <T>Refresh</T>
        </Button>
      </span>
      <span id={`${listId}-status`} className={styles.hint} role="status">
        {tx(message)}
      </span>
      <Popup
        open={open && !disabled}
        anchor={input}
        onClose={() => setOpen(false)}
        autoFocus={false}
        restoreFocus={false}
        matchWidth
        role="presentation"
      >
        <div
          id={listId}
          role="listbox"
          aria-label={tx(label)}
          className={styles.list}
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map((font, index) => (
            <div
              key={font.name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={active === index}
              className={styles.option}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(font.name)}
            >
              <span>{font.name}</span>
              <span className={styles.hint}>
                {tx(
                  font.name === "JetBrains Mono" || font.name === "Inter"
                    ? "Bundled"
                    : font.monospaced
                      ? "Monospaced"
                      : "Proportional",
                )}
              </span>
            </div>
          ))}
          {!suggestions.length && (
            <span className={styles.hint}>
              <T>No matching fonts. Enter a family name manually.</T>
            </span>
          )}
        </div>
      </Popup>
    </span>
  );
}
