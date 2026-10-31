/**
 * A GitHub body: Markdown (`body` of descriptions, comments, reviews) or GitHub's HTML
 * (`dismissalMessageHTML`), rendered by the editor's Markdown pipeline (marked + DOMPurify,
 * which also sanitizes HTML). Web links open in the browser.
 */
import clsx from "clsx";
import { useMarkupHtml } from "@/editor/lsp/markdown";
import { T } from "@/ui";
import { openInBrowser } from "../data/local";
import styles from "./ui.module.css";

export interface MarkdownProps {
  /** Markdown, or HTML (Markdown passes HTML through). */
  text: string;
  /** Shown in grey italics for an empty body ("No description provided"); nothing when unset. */
  emptyText?: string;
  className?: string;
}

export function Markdown({ text, emptyText, className }: MarkdownProps) {
  const html = useMarkupHtml({ kind: "markdown", value: text });
  if (!text.trim())
    return emptyText ? (
      <div className={clsx(styles.markdownEmpty, className)}>
        <T>{emptyText}</T>
      </div>
    ) : null;
  return (
    <div
      className={clsx(styles.markdown, className)}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        // Other links (relative ones in a pull request's text) must not navigate the app's page.
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (/^https?:/i.test(href)) void openInBrowser(href);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
