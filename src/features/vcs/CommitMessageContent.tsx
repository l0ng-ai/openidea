import type { Commit } from "@/bindings";
import type { ReactNode } from "react";
import { fontWeightOf } from "@/platform/editorSettings";
import { resolveMonoFont } from "@/platform/fonts";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import styles from "./GitLog.module.css";

export function CommitMessageContent({
  commit,
  message,
  compact = false,
  renderText = (text) => text,
  revision = commit.shortId,
}: {
  commit: Commit;
  message: string;
  compact?: boolean;
  renderText?: (text: string) => ReactNode;
  revision?: ReactNode;
}) {
  const editor = useProject((s) => s.settings?.editor);
  const { family, size } = resolveMonoFont(undefined, editor);
  const [subject = "", ...bodyLines] = message.trimEnd().split("\n");
  const body = compact ? "" : bodyLines.join("\n").replace(/^\n+/, "");
  return (
    <>
      <div
        className={styles.messageText}
        style={{ fontFamily: family, fontSize: size, fontWeight: fontWeightOf(editor?.fontWeight, 400) }}
      >
        <div className={styles.subjectLine} style={{ fontWeight: fontWeightOf(editor?.boldFontWeight, 700) }}>
          {renderText(subject)}
        </div>
        {body && <div className={styles.fullMessage}>{renderText(body)}</div>}
      </div>
      <div className={styles.meta}>
        {revision} {commit.author} &lt;{commit.email}&gt;
        {commit.timeMs ? " " + tx`on ${new Date(commit.timeMs).toLocaleString()}` : ""}
      </div>
    </>
  );
}
