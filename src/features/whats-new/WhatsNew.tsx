/**
 * What's New: an editor tab with the release notes of one version. The install
 * records the notes; a version installed outside the app reads the manifest.
 */
import { useEffect, useState } from "react";
import { useMarkupHtml } from "@/editor/lsp/markdown";
import { DEFAULT_LOCALE, useI18n, useT } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { useProject } from "@/platform/project";
import { updateSource } from "@/platform/updateSource";
import { Checkbox, selectableText } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { setShowAfterUpdate, type WhatsNewData } from "./model";
import styles from "./WhatsNew.module.css";

const RELEASES = "https://github.com/l0ng-ai/openidea/releases";

function releasePage(version: string) {
  return version ? RELEASES + "/tag/v" + version : RELEASES;
}

export function WhatsNewPage({ input }: { input: EditorInput }) {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const data = input.data as Partial<WhatsNewData> | undefined;
  const version = data?.version ?? "";
  // The notes the install recorded, in this language when the manifest carried a translation.
  const recorded = data?.texts?.[locale] ?? data?.notes ?? null;
  const [manifestNotes, setManifestNotes] = useState<Record<string, string> | null>(null);
  // Nothing recorded and a version to look up: the manifest read starts with the first render.
  const [loading, setLoading] = useState(!data?.notes && !!version);
  const show = useProject((s) => s.settings?.general?.showWhatsNewAfterUpdate !== false);
  // Installed outside the app, or the recorded notes lack this language: read the update manifest.
  useEffect(() => {
    if (!version || manifestNotes || (data?.notes && (locale === DEFAULT_LOCALE || data?.texts?.[locale]))) return;
    let live = true;
    void call(commands.appReleaseNotes(version, updateSource()))
      .catch(() => null)
      .then((fetched) => {
        if (!live) return;
        setManifestNotes(fetched);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [version, locale, manifestNotes, data?.notes, data?.texts]);
  // The manifest carries every language it has; a missing translation shows the English notes.
  const notes = manifestNotes?.[locale] ?? manifestNotes?.[DEFAULT_LOCALE] ?? recorded;
  const html = useMarkupHtml({ kind: "markdown", value: notes ?? "" });
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.column}>
          <h1 className={styles.title}>{t("app.whatsNew.title")}</h1>
          <div className={styles.version}>{t("app.whatsNew.version", { version })}</div>
        </div>
      </header>
      <div className={styles.body}>
        <div className={styles.column + " " + styles.bodyColumn}>
          {notes?.trim() ? (
            <div
              className={styles.notes}
              onClick={(e) => {
                const link = (e.target as HTMLElement).closest("a");
                if (!link) return;
                // Links in the notes belong in the browser, not in the IDE's window.
                e.preventDefault();
                const href = link.getAttribute("href") ?? "";
                if (/^https?:/i.test(href)) void openExternalUrl(href).catch(() => {});
              }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : loading ? (
            <div className={styles.empty}>{t("app.whatsNew.loading")}</div>
          ) : (
            <div className={styles.empty}>
              <div className={selectableText}>{t("app.whatsNew.noNotes")}</div>
              <button
                type="button"
                className={styles.link}
                onClick={() => void openExternalUrl(releasePage(version)).catch(() => {})}
              >
                {t("app.whatsNew.openReleases")}
              </button>
            </div>
          )}
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.column + " " + styles.footerRow}>
          <Checkbox
            checked={show}
            onChange={(checked) => void setShowAfterUpdate(checked).catch(() => {})}
            label={t("app.whatsNew.showAfterUpdate")}
          />
        </div>
      </footer>
    </div>
  );
}
