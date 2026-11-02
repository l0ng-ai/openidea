/**
 * GitHub avatars (collaboration-tools' `Avatar` / `AvatarIconWithOutline`): a circle
 * loaded from avatars.githubusercontent.com at twice the size for HiDPI, falling back
 * to the user's initial when the image does not load. `ring` outlines it in a review
 * state colour (2px, 1px gap), as the list's reviewer avatars and the status section.
 */
import { useState, type CSSProperties } from "react";
import clsx from "clsx";
import type { GHPRReviewerState } from "../api/types";
import styles from "./ui.module.css";

/** `Avatar.Sizes`. */
export const AVATAR_SIZE = {
  /** Mentions in comments. */
  SMALL: 15,
  /** Reviewer selectors, replies, list rows. */
  BASE: 20,
  /** Avatars with a state ring (list reviewers, status section). */
  OUTLINED: 18,
  /** Timeline items. */
  TIMELINE: 30,
  ACCOUNT: 40,
} as const;

/** The ring colour of a reviewer state (approved green, changes requested orange, else grey). */
export function reviewerRingColor(state: GHPRReviewerState): string {
  if (state === "APPROVED") return "var(--gh-review-approved)";
  if (state === "CHANGES_REQUESTED") return "var(--gh-review-changes)";
  return "var(--gh-review-neutral)";
}

/** `url` sized for `px` CSS pixels (GitHub serves `s=`); other URLs as they are. */
export function avatarSrc(url: string, px: number): string {
  if (!/^https:\/\/avatars\.githubusercontent\.com\//.test(url)) return url;
  const u = new URL(url);
  u.searchParams.set("s", String(Math.round(px * 2)));
  return u.toString();
}

const FALLBACK_COLORS = 8;

function fallbackColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `var(--gh-avatar-${Math.abs(h) % FALLBACK_COLORS})`;
}

export interface AvatarProps {
  /** Image URL (`avatarUrl` / `teamAvatarUrl`); none shows the initial. */
  url: string | null | undefined;
  /** Login or name: the fallback initial and the default tooltip. */
  name: string;
  size?: number;
  /** Outline colour (a CSS colour or `reviewerRingColor(state)`). */
  ring?: string;
  /** Tooltip; defaults to `name`, `null` for none. */
  title?: string | null;
  className?: string;
  style?: CSSProperties;
}

export function Avatar({ url, name, size = AVATAR_SIZE.BASE, ring, title, className, style: extra }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!url && failed !== url;
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(8, Math.round(size * 0.5)),
    ...(showImage ? {} : { background: fallbackColor(name) }),
    ...(ring ? { "--ring": ring } : {}),
    ...extra,
  } as CSSProperties;
  return (
    <span
      className={clsx(styles.avatar, ring && styles.ringed, className)}
      style={style}
      title={title === null ? undefined : (title ?? name)}
      data-avatar={name}
    >
      {showImage ? (
        <img src={avatarSrc(url, size)} alt="" draggable={false} onError={() => setFailed(url)} />
      ) : (
        (name.trim()[0] ?? "?").toUpperCase()
      )}
    </span>
  );
}

export interface AvatarStackItem {
  key: string;
  url: string | null | undefined;
  name: string;
  ring?: string;
}

/** Overlapping avatars, at most `max` of them (the list row's assignees and reviewers: 2). */
export function AvatarStack({
  items,
  max = 2,
  size = AVATAR_SIZE.BASE,
  title,
  className,
}: {
  items: readonly AvatarStackItem[];
  max?: number;
  size?: number;
  /** Tooltip of the whole stack (IntelliJ shows a popup listing them on hover); `null` for none at all. */
  title?: string | null;
  className?: string;
}) {
  if (!items.length) return null;
  const shown = items.slice(0, max);
  return (
    <span
      className={clsx(styles.stack, className)}
      style={{ "--overlap": `${Math.round(size / 3)}px` } as CSSProperties}
      title={title ?? undefined}
    >
      {shown.map((a, i) => (
        <Avatar
          key={a.key}
          url={a.url}
          name={a.name}
          size={size}
          ring={a.ring}
          title={title || title === null ? null : undefined}
          style={{ zIndex: shown.length - i }}
        />
      ))}
    </span>
  );
}
