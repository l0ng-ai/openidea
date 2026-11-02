/**
 * Small read-only diffs (`TimelineDiffComponentFactory`): a unified hunk with both line
 * number columns, inserted / deleted lines coloured and the comment's anchor lines
 * highlighted; and the rounded box with the file name header a thread's diff sits in
 * (`createDiffWithHeader`), whose name opens the file's diff and whose chevron collapses it.
 */
import type { ReactNode } from "react";
import { IconButton } from "@/ui";
import { hunkLineNumbers, type PatchHunk } from "../model";
import styles from "./comments.module.css";

export function HunkView({ hunk, anchor }: { hunk: PatchHunk; anchor?: [number, number] | null }) {
  const numbers = hunkLineNumbers(hunk);
  return (
    <div className={styles.hunk}>
      <table>
        <tbody>
          {hunk.lines.map((l, i) => (
            <tr key={i} data-type={l.type} data-anchor={anchor && i >= anchor[0] && i < anchor[1] ? true : undefined}>
              <td className={styles.lineNo}>{numbers[i]![0] ?? ""}</td>
              <td className={styles.lineNo}>{numbers[i]![1] ?? ""}</td>
              <td className={styles.code}>{l.text || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DiffBox({
  path,
  onOpen,
  collapsible,
  collapsed,
  onToggleCollapsed,
  children,
}: {
  path: string;
  onOpen?: () => void;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={styles.diffBox}>
      <div className={styles.fileHeader}>
        <span
          className={styles.fileName}
          role="link"
          tabIndex={0}
          title={path}
          onClick={onOpen}
          onKeyDown={(e) => e.key === "Enter" && onOpen?.()}
        >
          {path}
        </span>
        {collapsible && (
          <IconButton
            icon={collapsed ? "chevron-down" : "chevron-up"}
            title={collapsed ? "Expand" : "Collapse"}
            size="small"
            onClick={onToggleCollapsed}
          />
        )}
      </div>
      {!collapsed && children}
    </div>
  );
}
