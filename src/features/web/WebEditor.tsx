/**
 * Text editor wrapper of HTML files: the browser bar at the top right (IDEA's
 * floating "open in browser" toolbar) and the built-in preview beside the
 * editor, served by the built-in server and reloaded when files are saved.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useEditorRegistry } from "@/editor/api";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { FloatingToolbar, IconButton } from "@/ui";
import { browserIcon, isWebResource, openInBrowser, useBrowsers, useWebPreview, webUrl } from "./browsers";
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
      {preview && <WebPreview path={path} />}
    </div>
  );
}

function WebPreview({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const root = useProject((s) => s.project?.root ?? null);

  useEffect(() => {
    let live = true;
    webUrl(path).then(
      (u) => live && setUrl(u),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [path]);

  // Saved edits to the page or the project's web resources (scripts, styles, images) reload it;
  // other files (notes, sources the page doesn't load) leave its state alone.
  useEffect(() => {
    const scope = root ?? path.slice(0, path.lastIndexOf("/"));
    const affects = (p: string) => p === path || ((p.startsWith(scope + "/") || p === scope) && isWebResource(p));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSeq((n) => n + 1), RELOAD_DELAY);
    };
    const offFs = onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some(affects)) reload();
    });
    const offDirty = onIdeEvent("docDirty", (e) => {
      if (e.dirty) return;
      const saved = [...useEditorRegistry.getState().editors].find((ed) => ed.ctx.doc === e.doc)?.ctx.path;
      if (!saved || affects(saved)) reload();
    });
    return () => {
      clearTimeout(timer);
      offFs();
      offDirty();
    };
  }, [path, root]);

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
