/** Read-only text with line numbers (IDEA's preview editors), SQL in the editor's syntax colours. */
import { useEffect, useRef } from "react";
import clsx from "clsx";
import { highlightInto } from "@/editor/lsp/markdown";
import styles from "./Database.module.css";

export function CodePreview({
  text,
  sql = false,
  className,
  "aria-label": ariaLabel,
}: {
  text: string;
  sql?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    if (sql) void highlightInto(el, text, "SQL");
  }, [text, sql]);
  const lines = text.split("\n").length;
  return (
    <div className={clsx(styles.codePreview, className)}>
      <div className={styles.codeGutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre ref={ref} className={styles.codeText} aria-label={ariaLabel} />
    </div>
  );
}
