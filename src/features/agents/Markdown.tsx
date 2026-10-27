/** Agent messages: Markdown → sanitized HTML (marked + DOMPurify). */
import { useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { openExternalUrl } from "@/platform/openUrl";
import styles from "./Session.module.css";

const marked = new Marked({ gfm: true, breaks: true });

export function markdownHtml(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  return (
    <div
      className={styles.markdown}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        if (/^https?:/i.test(a.href)) void openExternalUrl(a.href);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
