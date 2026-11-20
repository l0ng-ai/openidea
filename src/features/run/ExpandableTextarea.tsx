import { useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { Dialog, IconButton } from "@/ui";
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
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={styles.textareaWithButton}>
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
      <IconButton icon="expand-all" size="small" iconSize={14} title="Expand (⇧⏎)" onClick={() => setExpanded(true)} />
      {expanded && (
        <ExpandedTextDialog label={label} value={value} onOk={onChange} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}

function ExpandedTextDialog({
  label,
  value,
  onOk,
  onClose,
}: {
  label: string;
  value: string;
  onOk: (value: string) => void;
  onClose: () => void;
}) {
  const tx = useTx();
  const [text, setText] = useState(value);
  return (
    <Dialog
      open
      title={tx(label)}
      onClose={onClose}
      width={720}
      resizable="both"
      minWidth={360}
      minHeight={220}
      buttons={[
        {
          label: "OK",
          role: "default",
          onClick: () => {
            if (text !== value) onOk(text);
            onClose();
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <textarea
        className={clsx(styles.textarea, styles.expandedTextarea)}
        aria-label={tx(label)}
        spellCheck={false}
        wrap="off"
        rows={14}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
      />
    </Dialog>
  );
}
