/** A plugin content tab's Markdown, rendered (headings, lists, tables, code, links). */
import { useEffect, useRef, type MouseEvent } from "react";
import { highlightInto, useMarkupHtml } from "@/editor/lsp/markdown";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { IconButton } from "@/ui";
import styles from "./ContentMarkdown.module.css";

export type MarkdownLayout = "editor" | "split" | "preview";

/** Markdown content tabs: `language` markdown, or a `.md` / `.markdown` file name. */
export function isMarkdownContent(data: { language?: string; fileName?: string }): boolean {
  const language = data.language?.toLowerCase();
  return language === "markdown" || language === "md" || /\.(md|markdown)$/i.test(data.fileName ?? "");
}

export function ContentMarkdown({ text, label }: { text: string; label: string }) {
  const html = useMarkupHtml({ kind: "markdown", value: text });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
      const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
      void highlightInto(code, (code.textContent ?? "").replace(/\n+$/, ""), lang);
    });
  }, [html]);
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    // Web links open in the browser; relative ones have nothing to open and must not navigate the app's page.
    e.preventDefault();
    void openExternalUrl(a.getAttribute("href") ?? "");
  };
  return (
    <div
      ref={ref}
      className={styles.preview}
      role="document"
      aria-label={label}
      tabIndex={0}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Editor Only / Editor and Preview / Preview Only, as for Markdown files. */
export function MarkdownLayoutButtons({
  layout,
  onChange,
}: {
  layout: MarkdownLayout;
  onChange: (layout: MarkdownLayout) => void;
}) {
  const buttons: Array<[MarkdownLayout, string, string]> = [
    ["editor", "editor-only", "Editor Only"],
    ["split", "editor-preview", "Editor and Preview"],
    ["preview", "preview-only", "Preview Only"],
  ];
  return (
    <div className={styles.layout} role="toolbar" aria-label={tx("Markdown editor layout")}>
      {buttons.map(([value, icon, title]) => (
        <IconButton
          key={value}
          icon={icon}
          iconSize={16}
          size="small"
          title={title}
          pressed={layout === value}
          onClick={() => onChange(value)}
        />
      ))}
    </div>
  );
}
