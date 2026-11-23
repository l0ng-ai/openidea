import { useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { Button, IconButton, Popup } from "@/ui";
import styles from "./Run.module.css";

/**
 * A run configuration's multi-line field (VM options, say) with an Expand button (⇧⏎) that
 * edits it in a larger editor where each line stays on one visual line and scrolls sideways,
 * so one long argument isn't mistaken for several.
 */
export function ExpandableTextarea({
  label,
  value,
  placeholder,
  rows,
  invalid,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  rows?: number;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  const tx = useTx();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  return (
    <div ref={fieldRef} className={styles.textareaWithButton}>
      <textarea
        className={clsx(styles.textarea, invalid && styles.textareaInvalid)}
        aria-label={tx(label)}
        spellCheck={false}
        value={value}
        placeholder={tx(placeholder)}
        rows={rows ?? 4}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setExpanded(true);
          }
        }}
      />
      <IconButton
        icon="expand-all"
        size="small"
        iconSize={14}
        title="Expand (⇧⏎)"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      />
      {expanded && (
        <ExpandedTextPopup
          anchor={fieldRef}
          label={tx(label)}
          value={value}
          onOk={onChange}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  );
}

function ExpandedTextPopup({
  anchor,
  label,
  value,
  onOk,
  onClose,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  label: string;
  value: string;
  onOk: (value: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(value);
  const apply = () => {
    if (text !== value) onOk(text);
    onClose();
  };
  return (
    <Popup
      open
      anchor={anchor}
      aria-label={label}
      className={styles.expandedEditor}
      onClose={onClose}
      trapFocus
      matchWidth
      closeOnDeactivate={false}
      resizable="both"
      minWidth={240}
      minHeight={160}
    >
      <div
        className={styles.expandedEditorBody}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || isImeKey(e.nativeEvent))
            return;
          e.preventDefault();
          e.stopPropagation();
          apply();
        }}
      >
        <textarea
          className={clsx(styles.textarea, styles.expandedTextarea)}
          aria-label={label}
          spellCheck={false}
          wrap="off"
          value={text}
          data-autofocus
          onChange={(e) => setText(e.target.value)}
        />
        <div className={styles.expandedEditorActions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            OK
          </Button>
        </div>
      </div>
    </Popup>
  );
}
