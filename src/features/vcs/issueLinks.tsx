/** Settings › Version Control › Issue Navigation: issue ids in commit messages become links. */
import type { ReactNode } from "react";
import { isTauri } from "@/platform/ipc";
import { useWorkflowSettings, type IssueLinkValid } from "@/platform/workflowSettings";
import styles from "./GitLog.module.css";

export type IssueSegment = string | { text: string; url: string };

function compile(links: readonly IssueLinkValid[]): Array<{ re: RegExp; link: string }> {
  const out: Array<{ re: RegExp; link: string }> = [];
  for (const l of links) {
    try {
      out.push({ re: new RegExp(l.pattern, "g"), link: l.link });
    } catch {
      // Invalid patterns are flagged on the settings page.
    }
  }
  return out;
}

/** Splits `text` into plain parts and issue links (earliest match wins; no overlaps). */
export function linkifyIssues(text: string, links: readonly IssueLinkValid[]): IssueSegment[] {
  const matches: Array<{ start: number; end: number; url: string }> = [];
  for (const { re, link } of compile(links)) {
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      const url = link.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "");
      matches.push({ start: m.index!, end: m.index! + m[0].length, url });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: IssueSegment[] = [];
  let pos = 0;
  for (const m of matches) {
    if (m.start < pos) continue;
    if (m.start > pos) out.push(text.slice(pos, m.start));
    out.push({ text: text.slice(m.start, m.end), url: m.url });
    pos = m.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

export async function openUrl(url: string) {
  if (isTauri()) {
    const { openUrl: open } = await import("@tauri-apps/plugin-opener");
    await open(url);
  } else window.open(url, "_blank", "noopener");
}

/** Commit message text with issue links. */
export function IssueText({ text }: { text: string }): ReactNode {
  const links = useWorkflowSettings((s) => s.vcs.issueNavigation);
  if (!links.length) return text;
  return linkifyIssues(text, links).map((seg, i) =>
    typeof seg === "string" ? (
      seg
    ) : (
      <a
        // oxlint-disable-next-line react/no-array-index-key -- issue links can repeat; position is the identity
        key={i}
        href={seg.url}
        className={styles.issueLink}
        title={seg.url}
        onClick={(e) => {
          e.preventDefault();
          void openUrl(seg.url).catch(() => undefined);
        }}
      >
        {seg.text}
      </a>
    ),
  );
}
