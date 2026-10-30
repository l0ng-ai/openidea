/**
 * The row every timeline item, comment and reply uses (collaboration-tools'
 * `CodeReviewChatItemUIUtil.build` with `CodeReviewTimelineUIUtil.createTitleTextPane`):
 * the avatar (tooltip: the name), then the header (bold author link · pretty date, tags,
 * the actions on the right) above the content.
 */
import { Fragment, type ReactNode } from "react";
import type { GHActor } from "../../api/types";
import { GHOST_USER } from "../../data/model";
import { openInBrowser } from "../../data/local";
import { Avatar, AVATAR_SIZE } from "../../ui/Avatar";
import { prettyDateTime } from "../../ui/prettyDate";
import { presentableName } from "../model";
import styles from "./comments.module.css";

/** FULL (timeline items), FULL_SECONDARY (thread replies in the timeline), COMPACT (diff inlays). */
export type ChatItemVariant = "full" | "secondary" | "compact";

export const avatarSize = (v: ChatItemVariant) => (v === "full" ? AVATAR_SIZE.TIMELINE : AVATAR_SIZE.BASE);

/** A user link: the presentable name in bold, opening the profile. */
export function AuthorLink({ actor }: { actor: GHActor | null }) {
  const a = actor ?? GHOST_USER;
  return (
    <a
      className={styles.author}
      href={a.url}
      onClick={(e) => {
        e.preventDefault();
        if (a.url) void openInBrowser(a.url);
      }}
    >
      {presentableName(a)}
    </a>
  );
}

/** A tag pill (OUTDATED / RESOLVED / PENDING). */
export const Tag = ({ children }: { children: ReactNode }) => <span className={styles.tag}>{children}</span>;

export interface ChatItemProps {
  variant?: ChatItemVariant;
  author: GHActor | null;
  /** The date after the name; none for undated items. */
  date?: string | null;
  /** Replaces the avatar (the merged banner's icon). */
  icon?: ReactNode;
  /** Replaces the name · date header. */
  title?: ReactNode;
  tags?: ReactNode;
  actions?: ReactNode;
  /** No content width limit (threads with their diffs). */
  wide?: boolean;
  className?: string;
  children?: ReactNode;
}

export function ChatItem({
  variant = "full",
  author,
  date,
  icon,
  title,
  tags,
  actions,
  wide,
  className,
  children,
}: ChatItemProps) {
  const a = author ?? GHOST_USER;
  const name = presentableName(a);
  return (
    <div className={[styles.item, className].filter(Boolean).join(" ")} data-variant={variant}>
      <div className={styles.icon}>{icon ?? <Avatar url={a.avatarUrl} name={name} size={avatarSize(variant)} />}</div>
      <div className={styles.main} data-wide={wide || undefined}>
        <div className={styles.header}>
          <div className={styles.title}>
            {title ?? (
              <span>
                <AuthorLink actor={a} />
                {date && <span className={styles.date}>&nbsp;{prettyDateTime(date)}</span>}
              </span>
            )}
            {tags}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A translated `{name}` template (the first argument a `txTemplate` call gave) with
 * React nodes for its parameters: `rich(txTemplate("assigned {users}"), { users })`.
 */
export function rich(template: string, values: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/\{(\w+)\}/);
  return parts.map((p, i) => <Fragment key={i}>{i % 2 ? (values[p] ?? `{${p}}`) : p}</Fragment>);
}

/** Nodes joined with ", " (IntelliJ's `joinToString`). */
export function joined(nodes: ReactNode[]): ReactNode {
  return nodes.map((n, i) => (
    <Fragment key={i}>
      {i > 0 && ", "}
      {n}
    </Fragment>
  ));
}
