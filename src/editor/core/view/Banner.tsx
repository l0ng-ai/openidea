import { useMemo } from "react";
import { Icon, T } from "@/ui";
import { useEditorBanners, type EditorBannerContribution } from "@/workbench/contributions";
import { useDocMeta } from "../model/document";
import styles from "./EditorArea.module.css";
import { classFileBreakpointReason } from "@/platform/classFiles";
import { tx } from "@/platform/i18n";

const TEXT = {
  binary: "This file appears to be binary and is shown read-only.",
  tooLarge: "The file is too large: editing and code insight are disabled.",
  readOnly: "The file is read-only.",
  library: "Library source (read-only).",
} as const;

/** Notice above read-only / binary / too-large documents. */
export const documentBanner: EditorBannerContribution = {
  id: "editor.document",
  order: -10,
  useBanner: (path) => {
    const banner = useDocMeta((s) => s[path]?.banner ?? null);
    return banner
      ? { text: TEXT[banner], icon: banner === "readOnly" || banner === "library" ? "lock" : "info" }
      : null;
  },
};

/**
 * Notice above a library class opened from a language server (IDEA's
 * "Decompiled .class file" / library source bar): read-only, with its origin.
 */
export function VirtualBanner({
  decompiled,
  description,
  path,
}: {
  decompiled: boolean;
  description: string | null;
  path: string;
}) {
  const reason = classFileBreakpointReason(path);
  return (
    <div className={`${styles.banner} ${styles.libraryBanner}`} role="status">
      <Icon name={decompiled ? "info" : "lock"} size={14} className={styles.bannerIcon} />
      <span className={styles.virtualBannerText}>
        {decompiled ? tx("Decompiled .class file: sources are not available.") : tx("Library source (read-only).")}
        {reason && ` ${tx(reason)}`}
      </span>
      {description && (
        <span className={styles.bannerDetail} title={description}>
          {description}
        </span>
      )}
    </div>
  );
}

function ContributedBanner({ banner, path }: { banner: EditorBannerContribution; path: string }) {
  const b = banner.useBanner(path);
  if (!b) return null;
  return (
    <div className={`${styles.banner} ${b.level === "warning" ? styles.libraryBanner : ""}`} role="status">
      <Icon name={b.icon ?? (b.level === "warning" ? "warning" : "info")} size={14} className={styles.bannerIcon} />
      <span className={styles.bannerText}>
        <T>{b.text}</T>
      </span>
      <span className={styles.bannerSpacer} />
      {b.actions?.map((a) => (
        <button key={a.label} type="button" className={styles.bannerLink} onClick={a.run}>
          <T>{a.label}</T>
        </button>
      ))}
    </div>
  );
}

/** Banners features contribute for `path` (`registerEditorBanner`), in order. */
export function EditorBanners({ path }: { path: string }) {
  const map = useEditorBanners((s) => s.banners);
  const banners = useMemo(
    () => [...map.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id)),
    [map],
  );
  return (
    <>
      {banners.map((b) => (
        <ContributedBanner key={b.id} banner={b} path={path} />
      ))}
    </>
  );
}
