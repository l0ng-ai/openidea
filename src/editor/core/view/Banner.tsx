import { useMemo, type ReactNode } from "react";
import { Icon, T } from "@/ui";
import { useEditorBanners, type EditorBanner, type EditorBannerContribution } from "@/workbench/contributions";
import { useDocMeta } from "../model/document";
import styles from "./EditorArea.module.css";
import { classFileBreakpointReason } from "@/platform/classFiles";
import { gitRevisionOf } from "@/platform/virtualDocs";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { useLibrarySources } from "../librarySources";

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
  const sources = useLibrarySources(path, decompiled);
  const message = decompiled
    ? path.startsWith("csharp:")
      ? "Decompiled assembly (read-only)."
      : "Decompiled .class file: sources are not available."
    : gitRevisionOf(path)
      ? "File at a Git revision (read-only)."
      : "Library source (read-only).";
  const actions: NonNullable<EditorBanner["actions"]> = [];
  if (sources.busy) {
    actions.push({ label: "Cancel", run: () => void executeAction("editor.cancelSourceDownload", path) });
  } else {
    if (sources.download)
      actions.push({ label: "Download Sources", run: () => void executeAction("editor.downloadSources", path) });
    if (sources.choose)
      actions.push({ label: "Choose Sources…", run: () => void executeAction("editor.chooseSources", path) });
  }
  return (
    <Banner icon={decompiled ? "info" : "lock"} level="warning" actions={actions}>
      <span>
        <T>{message}</T>
        {reason && ` ${tx(reason)}`}
      </span>
      {sources.message && (
        <>
          {" "}
          <span>{tx(sources.message)}</span>
        </>
      )}
      {sources.busy && (
        <>
          {" "}
          <span>
            <T>Loading library sources…</T>
          </span>
        </>
      )}
      {description && (
        <>
          {" "}
          <span className={styles.bannerDetail} title={description}>
            {description}
          </span>
        </>
      )}
    </Banner>
  );
}

function Banner({ icon, level, actions, children }: Omit<EditorBanner, "text"> & { children: ReactNode }) {
  const warning = level === "warning";
  return (
    <div className={`${styles.banner} ${warning ? styles.warningBanner : ""}`} role="status">
      <span className={styles.bannerMessage}>
        <Icon name={icon ?? (warning ? "warning" : "info")} size={16} className={styles.bannerIcon} />
        <span className={styles.bannerText}>{children}</span>
      </span>
      {!!actions?.length && (
        <div className={styles.bannerActions}>
          {actions.map(({ label, run }) => (
            <button key={label} type="button" className={styles.bannerLink} onClick={run}>
              <T>{label}</T>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ContributedBanner({ banner, path }: { banner: EditorBannerContribution; path: string }) {
  const notice = banner.useBanner(path);
  return notice ? (
    <Banner icon={notice.icon} level={notice.level} actions={notice.actions}>
      <T>{notice.text}</T>
    </Banner>
  ) : null;
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
