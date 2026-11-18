/**
 * Text editor wrapper of HTML files: the browser bar at the top right (IDEA's
 * floating "open in browser" toolbar) and the built-in preview beside the
 * editor, served by the built-in server and reloaded when files are saved.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { onEditorEvent } from "@/editor/api";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { FloatingToolbar, IconButton } from "@/ui";
import { browserIcon, openInBrowser, useBrowsers, useWebPreview, webUrl } from "./browsers";
import { previewResources } from "./previewResources";
import styles from "./Web.module.css";
import { tx } from "@/platform/i18n";

const RELOAD_DELAY = 250;

export function WebEditor({ path, children }: { path: string; tabId: string; children: ReactNode }) {
  const preview = useWebPreview((s) => !!s[path]);
  const browsers = useBrowsers((s) => s.list);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className={clsx(styles.split, preview && styles.withPreview)}>
      <div ref={ref} className={styles.editor}>
        {children}
        <FloatingToolbar targetRef={ref} className={styles.browserBar} hideOnTyping={false} retentionMs={1500}>
          <div className={styles.actions} role="toolbar" aria-label={tx("Open in browser")}>
            <IconButton
              icon="eye"
              size="small"
              iconSize={16}
              action="web.togglePreview"
              actionArg={path}
              pressed={preview}
              title="Built-in Preview"
            />
            {browsers.map((b) => (
              <IconButton
                key={b.id}
                icon={browserIcon(b.id)}
                size="small"
                iconSize={16}
                title={b.name}
                onClick={() => void openInBrowser(path, b.id)}
              />
            ))}
          </div>
        </FloatingToolbar>
      </div>
      {preview && <WebPreview key={path} path={path} />}
    </div>
  );
}

function WebPreview({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pageUrl: string | null = null;
    let resources = new Set([path]);
    let scan = 0;
    let pageChanged = false;

    const updateResources = async (url: string) => {
      const id = ++scan;
      const next = await call(commands.fsReadText(path))
        .then((html) => previewResources(path, url, html))
        .catch(() => new Set([path]));
      if (!live || scan !== id) return false;
      resources = next;
      return true;
    };
    void webUrl(path)
      .then(async (url) => {
        if (!live) return;
        pageUrl = url;
        await updateResources(url);
        if (live) setUrl(url);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));

    const changed = (paths: readonly string[]) => {
      if (!paths.some((changedPath) => resources.has(changedPath))) return;
      pageChanged ||= paths.includes(path);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pageUrl) return;
        if (pageChanged) {
          pageChanged = false;
          void updateResources(pageUrl).then((current) => {
            if (current) setSeq((n) => n + 1);
          });
        } else setSeq((n) => n + 1);
      }, RELOAD_DELAY);
    };
    const offFs = onIdeEvent("fsChanged", (e) => changed([...e.created, ...e.modified, ...e.removed]));
    const offSaved = onEditorEvent((e) => {
      if (e.type === "docSaved") changed([e.path]);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      offFs();
      offSaved();
    };
  }, [path]);

  if (error) return <div className={clsx(styles.preview, styles.message)}>{error}</div>;
  if (!url) return <div className={styles.preview} />;
  return (
    <iframe
      key={seq}
      className={styles.preview}
      title={tx("HTML preview")}
      src={url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
    />
  );
}
